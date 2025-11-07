import { NextResponse } from 'next/server'
import { z } from 'zod'

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

export async function GET() {
    try {
        const backend = process.env.BACKEND_BASE_URL || process.env.NEXT_PUBLIC_BACKEND_BASE_URL || process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL
        if (!backend) return NextResponse.json({ asOf: Date.now(), pairs: [] }, { status: 200 })
        const res = await fetch(new URL('/api/pairs', backend).toString(), { cache: 'no-store' })
        if (!res.ok) return NextResponse.json({ asOf: Date.now(), pairs: [] }, { status: 200 })
        const json = await res.json()
        const parsed = PairsFileSchema.safeParse(json)
        if (parsed.success) return NextResponse.json(parsed.data, { status: 200 })
        return NextResponse.json({ asOf: Date.now(), pairs: Array.isArray((json as any)?.pairs) ? (json as any).pairs : [] }, { status: 200 })
    } catch (err) {
        console.error('API error:', err)
        return NextResponse.json({ asOf: Date.now(), pairs: [] }, { status: 200 })
    }
}


