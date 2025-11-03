import { NextResponse } from 'next/server'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'

const PriceSchema = z.object({
    last: z.number(),
    bestBid: z.number(),
    bestAsk: z.number(),
    mid: z.number()
})

const PairSchema = z.object({
    long: z.string(),
    short: z.string(),
    corr: z.number(),
    beta: z.number(),
    hedgeRatio: z.number(),
    cointegration: z.object({ adfT: z.number(), p: z.number().nullable(), lags: z.number(), halfLife: z.number(), stationary: z.boolean() }),
    spreadZ: z.number(),
    fundingNet: z.number().optional(),
    scores: z.object({ long: z.number(), short: z.number(), composite: z.number() }),
    notes: z.array(z.string()).optional(),
    sector: z.string().optional(),
    prices: z.object({ long: PriceSchema, short: PriceSchema })
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
        const data = PairsFileSchema.parse(parsed)
        return NextResponse.json(data, { status: 200 })
    } catch (err) {
        return NextResponse.json({ error: 'Failed to read pairs data' }, { status: 500 })
    }
}


