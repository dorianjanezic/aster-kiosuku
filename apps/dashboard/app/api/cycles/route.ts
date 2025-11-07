import { NextResponse } from 'next/server'
import { z } from 'zod'

export const runtime = 'nodejs'

const InputCycleEventSchema = z.object({ ts: z.number(), type: z.string(), data: z.unknown() })

const SlimCycleEventSchema = z.object({
    ts: z.number(),
    type: z.enum(['user', 'decision']),
    data: z.unknown()
})

const SlimCyclesResponseSchema = z.object({ events: z.array(SlimCycleEventSchema) })

export async function GET() {
    try {
        const backend = process.env.BACKEND_BASE_URL || process.env.NEXT_PUBLIC_BACKEND_BASE_URL || process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL
        if (!backend) return NextResponse.json({ events: [] }, { status: 200 })
            const res = await fetch(new URL('/api/cycles', backend).toString(), { cache: 'no-store' })
        if (!res.ok) return NextResponse.json({ events: [] }, { status: 200 })
                const json = await res.json()
        const parsed = SlimCyclesResponseSchema.safeParse(json)
        if (parsed.success) return NextResponse.json(parsed.data, { status: 200 })
        return NextResponse.json({ events: [] }, { status: 200 })
    } catch (err) {
        return NextResponse.json({ events: [] }, { status: 200 })
    }
}


