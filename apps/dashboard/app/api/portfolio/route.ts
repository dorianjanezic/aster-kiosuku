import { NextResponse } from 'next/server'
import { z } from 'zod'

export const runtime = 'nodejs'

const OrderSchema = z.object({
    ts: z.number(),
    type: z.literal('order'),
    data: z.object({
        orderId: z.string(),
        symbol: z.string(),
        side: z.enum(['BUY', 'SELL']),
        type: z.string(),
        status: z.string(),
        price: z.number(),
        executedQty: z.number()
    })
})

const OrdersLineSchema = z.union([
    OrderSchema,
    z.object({ ts: z.number(), type: z.literal('order_plan'), data: z.unknown() }),
    z.object({ ts: z.number(), type: z.string(), data: z.unknown() })
])

// Relaxed schema: tolerate missing fields when reading local snapshots
const PairsSchema = z.object({
    asOf: z.number().optional(),
    pairs: z.array(z.object({
        long: z.string(),
        short: z.string(),
        prices: z.object({
            long: z.object({ mid: z.number().optional() }),
            short: z.object({ mid: z.number().optional() })
        }).optional()
    }))
})

const MarketsSchema = z.object({
    markets: z.array(z.object({ symbol: z.string(), lastPrice: z.number().optional() }))
})

export async function GET() {
    try {
        const backend = process.env.BACKEND_BASE_URL || process.env.NEXT_PUBLIC_BACKEND_BASE_URL || process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL
        if (!backend) return NextResponse.json({ summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }, { status: 200 })
            const res = await fetch(new URL('/api/portfolio', backend).toString(), { cache: 'no-store' })
        if (!res.ok) return NextResponse.json({ summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }, { status: 200 })
                const json = await res.json()
                return NextResponse.json(json, { status: 200 })
    } catch (err) {
        return NextResponse.json({ summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }, { status: 200 })
    }
}


