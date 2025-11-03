import { NextResponse } from 'next/server'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'

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

async function resolvePath(...segments: string[]): Promise<string> {
    const cwd = process.cwd()
    const candidates = [
        path.join(cwd, '..', '..', 'sim_data', ...segments),
        path.join(cwd, 'public', 'data', ...segments)
    ]
    for (const p of candidates) {
        try { await fs.access(p); return p } catch { }
    }
    return path.join(cwd, ...segments)
}

export async function GET() {
    try {
        const backend = process.env.BACKEND_BASE_URL
        if (backend) {
            try {
                const res = await fetch(new URL('/api/portfolio', backend).toString(), { cache: 'no-store' })
                if (!res.ok) {
                    return NextResponse.json({ summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }, { status: 200 })
                }
                const json = await res.json()
                // Pass through backend response as-is
                return NextResponse.json(json, { status: 200 })
            } catch {
                return NextResponse.json({ summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }, { status: 200 })
            }
        }

        // Prefer latest portfolio snapshot if available
        const portfolioPath = await resolvePath('portfolio.jsonl')
        try {
            const raw = await fs.readFile(portfolioPath, 'utf8')
            const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
            const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null
            if (last && last.type === 'portfolio' && last.data && typeof last.ts === 'number') {
                const acc = last.data.account
                const positions = Array.isArray(last.data.positions) ? last.data.positions : []
                const totalNotional = positions.reduce((a: number, p: any) => a + Math.abs((p?.qty || 0) * (p?.mid || 0)), 0)
                const totalUpnl = positions.reduce((a: number, p: any) => {
                    const mid = typeof p?.mid === 'number' ? p.mid : null
                    const entry = typeof p?.entryPrice === 'number' ? p.entryPrice : null
                    const qty = typeof p?.qty === 'number' ? p.qty : 0
                    const recomputed = (mid != null && entry != null) ? (mid - entry) * qty : 0
                    return a + recomputed
                }, 0)
                const startingBalance = Number(process.env.PORTFOLIO_BASE_BALANCE || 10000)
                return NextResponse.json({
                    summary: { baseBalance: startingBalance, totalNotional, totalUpnl, equity: acc?.equityUsd ?? ((acc?.balanceUsd ?? 10000) + totalUpnl) },
                    positions: positions.map((p: any) => {
                        const mid = (p as any).mid
                        const qty = p.qty
                        const upnl = (typeof mid === 'number' && typeof p.entryPrice === 'number') ? (mid - p.entryPrice) * qty : (p.unrealizedPnl ?? 0)
                        return { symbol: p.symbol, netQty: qty, avgEntry: p.entryPrice, mid: (p as any).mid ?? null, notional: (qty && mid != null) ? Math.abs(qty * mid) : null, upnl }
                    }),
                    pairs: []
                }, { status: 200 })
            }
        } catch { /* fall through to compute path */ }
        const ordersPath = await resolvePath('orders.jsonl')
        const pairsPath = await resolvePath('pairs.json')
        const marketsPath = await resolvePath('markets.json')
        const [ordersRaw, pairsRaw, marketsRaw] = await Promise.all([
            fs.readFile(ordersPath, 'utf8'),
            fs.readFile(pairsPath, 'utf8').catch(() => 'null'),
            fs.readFile(marketsPath, 'utf8').catch(() => 'null')
        ])
        const parsedPairs = (() => { try { return JSON.parse(pairsRaw) } catch { return null } })()
        const pairs = parsedPairs ? (PairsSchema.safeParse(parsedPairs).success ? parsedPairs : { pairs: Array.isArray(parsedPairs?.pairs) ? parsedPairs : [] }) : { pairs: [] as any[] }
        const parsedMarkets = (() => { try { return JSON.parse(marketsRaw) } catch { return null } })()
        const markets = parsedMarkets ? (MarketsSchema.safeParse(parsedMarkets).success ? parsedMarkets : { markets: [] as any[] }) : { markets: [] as any[] }
        const priceMap = new Map<string, number>()
        for (const m of markets.markets) {
            if (typeof m.lastPrice === 'number') priceMap.set(m.symbol, m.lastPrice)
        }

        const lines = ordersRaw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        const orders: z.infer<typeof OrderSchema>[] = []
        let realizedSum = 0
        for (const line of lines) {
            try {
                const obj = JSON.parse(line)
                const maybeOrder = OrderSchema.safeParse(obj)
                if (maybeOrder.success) orders.push(maybeOrder.data)
                if (obj && obj.type === 'pair_exit' && typeof obj.data?.realizedPnlUsd === 'number') {
                    realizedSum += obj.data.realizedPnlUsd
                }
            } catch { }
        }

        type RunningPos = { netQty: number; avgPrice: number | null }
        const posMap = new Map<string, RunningPos>()
        const fills = orders.filter((o) => o.data.status === 'FILLED').sort((a, b) => a.ts - b.ts)
        for (const f of fills) {
            const symbol = f.data.symbol
            const qtySigned = f.data.executedQty * (f.data.side === 'BUY' ? 1 : -1)
            const price = f.data.price
            const cur = posMap.get(symbol) ?? { netQty: 0, avgPrice: null }
            if (cur.netQty === 0) {
                posMap.set(symbol, { netQty: qtySigned, avgPrice: price })
                continue
            }
            if (Math.sign(cur.netQty) === Math.sign(qtySigned)) {
                const newQtyAbs = Math.abs(cur.netQty) + Math.abs(qtySigned)
                const newAvg = ((cur.avgPrice ?? price) * Math.abs(cur.netQty) + price * Math.abs(qtySigned)) / newQtyAbs
                posMap.set(symbol, { netQty: cur.netQty + qtySigned, avgPrice: newAvg })
            } else {
                const remaining = cur.netQty + qtySigned
                if (remaining === 0) {
                    posMap.set(symbol, { netQty: 0, avgPrice: null })
                } else if (Math.sign(remaining) === Math.sign(cur.netQty)) {
                    posMap.set(symbol, { netQty: remaining, avgPrice: cur.avgPrice })
                } else {
                    posMap.set(symbol, { netQty: remaining, avgPrice: price })
                }
            }
        }

        const positions = Array.from(posMap.entries())
            .filter(([, p]) => Math.abs(p.netQty) > 1e-12)
            .map(([symbol, p]) => {
                const directMid = priceMap.get(symbol)
                const pair = (pairs as any).pairs.find((pp: any) => pp?.long === symbol || pp?.short === symbol) as any
                const pairMid = pair ? (pair.long === symbol ? pair.prices?.long?.mid : pair.prices?.short?.mid) : undefined
                const mid = (typeof directMid === 'number') ? directMid : (typeof pairMid === 'number' ? pairMid : null)
                const notional = mid != null ? Math.abs(p.netQty) * mid : null
                const upnl = p.avgPrice != null && mid != null ? (mid - p.avgPrice) * p.netQty : 0
                return { symbol, netQty: p.netQty, avgEntry: p.avgPrice, mid, notional, upnl }
            })

        const totalNotional = positions.reduce((acc, p) => acc + (p.notional ?? 0), 0)
        const totalUpnl = positions.reduce((acc, p) => acc + (p.upnl ?? 0), 0)
        const startingBalance = Number(process.env.PORTFOLIO_BASE_BALANCE || 10000)
        const currentBalance = startingBalance + realizedSum
        const equity = currentBalance + totalUpnl

        const symbolToPos = new Map(positions.map(p => [p.symbol, p]))
        const pairSummaries: Array<{ key: string; long: string; short: string; upnl: number; notionalEntry: number; percent: number }> = []
        for (const pr of pairs.pairs) {
            const longPos = symbolToPos.get(pr.long)
            const shortPos = symbolToPos.get(pr.short)
            if (!longPos || !shortPos) continue
            const upnl = (longPos.upnl ?? 0) + (shortPos.upnl ?? 0)
            const notionalEntry = (Math.abs(longPos.netQty) * (longPos.avgEntry ?? 0)) + (Math.abs(shortPos.netQty) * (shortPos.avgEntry ?? 0))
            const percent = notionalEntry > 0 ? upnl / notionalEntry : 0
            pairSummaries.push({ key: `${pr.long}|${pr.short}`, long: pr.long, short: pr.short, upnl, notionalEntry, percent })
        }

        return NextResponse.json({
            summary: { baseBalance: startingBalance, totalNotional, totalUpnl, equity },
            positions,
            pairs: pairSummaries
        }, { status: 200 })
    } catch (err) {
        return NextResponse.json({ summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }, { status: 200 })
    }
}


