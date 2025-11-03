import { NextResponse } from 'next/server'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'

export const runtime = 'nodejs'

const PriceSchema = z.object({
    last: z.number().optional(),
    bestBid: z.number().optional(),
    bestAsk: z.number().optional(),
    mid: z.number().optional()
})

const PairSchema = z.object({
    long: z.string(),
    short: z.string(),
    corr: z.number().optional(),
    beta: z.number().optional(),
    hedgeRatio: z.number().optional(),
    cointegration: z.object({ adfT: z.number().optional(), p: z.number().nullable().optional(), lags: z.number().optional(), halfLife: z.number().optional(), stationary: z.boolean().optional() }).optional(),
    spreadZ: z.number().optional(),
    fundingNet: z.number().optional(),
    scores: z.object({ long: z.number().optional(), short: z.number().optional(), composite: z.number().optional() }).optional(),
    notes: z.array(z.string()).optional(),
    sector: z.string().optional(),
    prices: z.object({ long: PriceSchema, short: PriceSchema }).optional()
})

const PairsFileSchema = z.object({ asOf: z.number().optional(), pairs: z.array(PairSchema) })

async function resolvePairsPath(): Promise<string> {
    const cwd = process.cwd()
    const candidates = [
        path.join(cwd, '..', '..', 'sim_data', 'pairs.jsonl'), // prefer ledger jsonl
        path.join(cwd, '..', '..', 'sim_data', 'pairs.json'), // local monorepo dev
        path.join(cwd, 'public', 'data', 'pairs.json') // copied for Vercel
    ]
    for (const p of candidates) {
        try {
            await fs.access(p)
            return p
        } catch { }
    }
    // fallback to current dir sim_data if user runs app from root
    return path.join(cwd, 'sim_data', 'pairs.json')
}

export async function GET() {
    try {
        // Always try to fetch from backend first
        const backend = process.env.BACKEND_BASE_URL || process.env.NEXT_PUBLIC_BACKEND_BASE_URL || process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL || 'https://aster-kiosuku-production.up.railway.app'
        try {
            const res = await fetch(new URL('/api/pairs', backend).toString(), { cache: 'no-store' })
            if (res.ok) {
                const json = await res.json()
                // Try to validate, but fail-soft
                const parsed = PairsFileSchema.safeParse(json)
                if (parsed.success) return NextResponse.json(parsed.data, { status: 200 })
                return NextResponse.json({ asOf: Date.now(), pairs: Array.isArray(json?.pairs) ? json.pairs : [] }, { status: 200 })
            }
        } catch (fetchErr) {
            console.error('Backend fetch failed:', fetchErr)
        }

        // Fallback to local file if backend fails
        const filePath = await resolvePairsPath()
        const raw = await fs.readFile(filePath, 'utf8')
        let parsed: any = null
        if (filePath.endsWith('.jsonl')) {
            const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
            const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null
            parsed = last?.data ?? null
        } else {
            parsed = JSON.parse(raw)
        }
        const safe = PairsFileSchema.safeParse(parsed)
        if (safe.success) return NextResponse.json(safe.data, { status: 200 })
        return NextResponse.json({ asOf: Date.now(), pairs: Array.isArray((parsed as any)?.pairs) ? (parsed as any).pairs : [] }, { status: 200 })
    } catch (err) {
        console.error('API error:', err)
        return NextResponse.json({ asOf: Date.now(), pairs: [] }, { status: 200 })
    }
}


