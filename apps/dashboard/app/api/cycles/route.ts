import { NextResponse } from 'next/server'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'

export const runtime = 'nodejs'

const InputCycleEventSchema = z.object({ ts: z.number(), type: z.string(), data: z.unknown() })

const SlimCycleEventSchema = z.object({
    ts: z.number(),
    type: z.enum(['user', 'decision']),
    data: z.unknown()
})

const SlimCyclesResponseSchema = z.object({ events: z.array(SlimCycleEventSchema) })

async function resolveCyclesPath(): Promise<string> {
    const cwd = process.cwd()
    const candidates = [
        path.join(cwd, '..', '..', 'sim_data', 'cycles.jsonl'),
        path.join(cwd, 'public', 'data', 'cycles.jsonl')
    ]
    for (const p of candidates) {
        try {
            await fs.access(p)
            return p
        } catch { }
    }
    return path.join(cwd, 'sim_data', 'cycles.jsonl')
}

export async function GET() {
    try {
        // Prefer proxying to backend if configured (avoids CORS and uses live data)
        const backend = process.env.BACKEND_BASE_URL || process.env.NEXT_PUBLIC_BACKEND_BASE_URL
        if (backend) {
            try {
                const res = await fetch(new URL('/api/cycles', backend).toString(), { cache: 'no-store' })
                if (!res.ok) return NextResponse.json({ events: [] }, { status: 200 })
                const json = await res.json()
                return NextResponse.json(json, { status: 200 })
            } catch {
                return NextResponse.json({ events: [] }, { status: 200 })
            }
        }

        const filePath = await resolveCyclesPath()
        const raw = await fs.readFile(filePath, 'utf8')
        const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        const slimEvents = [] as Array<z.infer<typeof SlimCycleEventSchema>>
        for (const line of lines) {
            try {
                const parsed = JSON.parse(line)
                const event = InputCycleEventSchema.parse(parsed)
                // Keep only user message, assistant message, and decision
                if (event.type === 'user_raw') {
                    const content = (event.data as any)?.content
                    if (typeof content === 'string') {
                        slimEvents.push({ ts: event.ts, type: 'user', data: content })
                    }
                } else if (event.type === 'decision') {
                    const d = event.data as any
                    const decision = d?.parsed ?? d?.raw ?? d
                    slimEvents.push({ ts: event.ts, type: 'decision', data: decision })
                }
            } catch {
                // ignore malformed lines
            }
        }
        const payload = SlimCyclesResponseSchema.safeParse({ events: slimEvents })
        if (payload.success) return NextResponse.json(payload.data, { status: 200 })
        return NextResponse.json({ events: [] }, { status: 200 })
    } catch (err) {
        return NextResponse.json({ events: [] }, { status: 200 })
    }
}


