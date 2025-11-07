import { z } from 'zod'

const PositionSchema = z.object({ symbol: z.string(), netQty: z.number(), avgEntry: z.number().nullable(), mid: z.number().nullable(), notional: z.number().nullable(), upnl: z.number().nullable() }).passthrough()
const PairPerfSchema = z.object({ key: z.string(), long: z.string(), short: z.string(), upnl: z.number(), notionalEntry: z.number(), percent: z.number() }).passthrough()
const PortfolioResponseSchema = z.object({
    summary: z.object({ baseBalance: z.number(), balance: z.number().optional(), totalNotional: z.number(), totalUpnl: z.number(), equity: z.number() }),
    positions: z.array(PositionSchema),
    pairs: z.array(PairPerfSchema)
}).passthrough()

// Orders schemas
const OrderEventSchema = z.object({
    ts: z.number(),
    type: z.string(),
    data: z.record(z.any())
}).passthrough()
const OrdersResponseSchema = z.object({
    events: z.array(OrderEventSchema)
}).passthrough()

// Fetch directly from Railway backend to avoid Vercel API route issues

async function fetchPortfolio() {
    try {
        const backend = process.env.BACKEND_BASE_URL || process.env.NEXT_PUBLIC_BACKEND_BASE_URL || process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL || 'https://aster-kiosuku-production.up.railway.app'
        const res = await fetch(new URL('/api/portfolio', backend).toString(), { cache: 'no-store' })
        if (!res.ok) return { summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }
        const data = await res.json()
        const parsed = PortfolioResponseSchema.safeParse(data)
        if (parsed.success) {
            return parsed.data
        } else {
            // Fallback: return safe defaults if schema parsing fails
            return { summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }
        }
    } catch (err) {
        return { summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }
    }
}

async function fetchOrders() {
    try {
        const backend = process.env.BACKEND_BASE_URL || process.env.NEXT_PUBLIC_BACKEND_BASE_URL || process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL || 'https://aster-kiosuku-production.up.railway.app'
        const res = await fetch(new URL('/api/orders?limit=100', backend).toString(), { cache: 'no-store' })
        if (!res.ok) return { events: [] }
        const data = await res.json()
        const parsed = OrdersResponseSchema.safeParse(data)
        if (parsed.success) {
            return parsed.data
        } else {
            // Fallback: return raw data if schema parsing fails
            return { events: Array.isArray(data?.events) ? data.events : [] }
        }
    } catch (err) {
        return { events: [] }
    }
}

export default async function PortfolioPage() {
    const [{ positions, summary, pairs }, { events: orders }] = await Promise.all([
        fetchPortfolio(),
        fetchOrders()
    ])
    return (
        <main>
            <h2 className="mb-3 text-base font-semibold">Portfolio</h2>
            <div className="mb-3 grid grid-cols-2 gap-3 text-sm text-muted-foreground md:grid-cols-4">
                <div>Balance: ${Number((summary as any).balance ?? summary.baseBalance).toFixed(2)}</div>
                <div>Equity: ${summary.equity.toFixed(2)}</div>
                <div>uPNL: ${summary.totalUpnl.toFixed(2)}</div>
                <div>Exposure: ${summary.totalNotional.toFixed(2)}</div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="min-w-[600px] w-full border-collapse text-sm">
                    <thead>
                        <tr className="border-b">
                            <th className="px-4 py-2 text-left font-medium">Symbol</th>
                            <th className="px-4 py-2 text-right font-medium">Net Qty</th>
                            <th className="px-4 py-2 text-right font-medium">Avg Entry</th>
                            <th className="px-4 py-2 text-right font-medium">Mid</th>
                            <th className="px-4 py-2 text-right font-medium">Notional</th>
                            <th className="px-4 py-2 text-right font-medium">uPNL</th>
                        </tr>
                    </thead>
                    <tbody>
                        {positions.map((p) => (
                            <tr key={p.symbol} className="border-b border-border/50 hover:bg-muted/50">
                                <td className="px-4 py-3">{p.symbol}</td>
                                <td className="px-4 py-3 text-right font-mono">{p.netQty.toFixed(2)}</td>
                                <td className="px-4 py-3 text-right font-mono">{p.avgEntry != null ? p.avgEntry.toFixed(2) : '-'}</td>
                                <td className="px-4 py-3 text-right font-mono">{p.mid != null ? p.mid.toFixed(2) : '-'}</td>
                                <td className="px-4 py-3 text-right font-mono">{p.notional != null ? p.notional.toFixed(2) : '-'}</td>
                                <td className="px-4 py-3 text-right font-mono">
                                    {p.upnl != null ? (
                                        <span className={p.upnl >= 0 ? 'text-green-600' : 'text-red-600'}>
                                            {p.upnl.toFixed(2)}
                                        </span>
                                    ) : '-'}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {pairs.length > 0 ? (
                <div className="mt-6 overflow-x-auto rounded-lg border border-border">
                    <table className="min-w-[600px] w-full border-collapse text-sm">
                        <thead>
                            <tr className="border-b">
                                <th className="px-4 py-2 text-left font-medium">Pair</th>
                                <th className="px-4 py-2 text-right font-medium">uPNL</th>
                                <th className="px-4 py-2 text-right font-medium">Entry Notional</th>
                                <th className="px-4 py-2 text-right font-medium">Return %</th>
                            </tr>
                        </thead>
                        <tbody>
                            {pairs.map((pp) => (
                                <tr key={pp.key} className="border-b border-border/50 hover:bg-muted/50">
                                    <td className="px-4 py-3">{pp.long} / {pp.short}</td>
                                    <td className="px-4 py-3 text-right font-mono">
                                        <span className={pp.upnl >= 0 ? 'text-green-600' : 'text-red-600'}>
                                            {pp.upnl.toFixed(2)}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-right font-mono">{pp.notionalEntry.toFixed(2)}</td>
                                    <td className="px-4 py-3 text-right font-mono">{(pp.percent * 100).toFixed(2)}%</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : null}

            {/* Orders History */}
            <div className="mt-6">
                <h3 className="mb-3 text-base font-semibold">Order History</h3>
                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="min-w-[800px] w-full border-collapse text-sm">
                        <thead>
                            <tr className="border-b">
                                <th className="px-4 py-2 text-left font-medium">Time</th>
                                <th className="px-4 py-2 text-left font-medium">Type</th>
                                <th className="px-4 py-2 text-left font-medium">Symbol</th>
                                <th className="px-4 py-2 text-left font-medium">Side</th>
                                <th className="px-4 py-2 text-right font-medium">Qty</th>
                                <th className="px-4 py-2 text-right font-medium">Price</th>
                                <th className="px-4 py-2 text-left font-medium">Status</th>
                                <th className="px-4 py-2 text-left font-medium">Details</th>
                            </tr>
                        </thead>
                        <tbody>
                            {orders.filter((o: any) => o?.type !== 'order_plan').map((order: any, index: number) => {
                                const timestamp = new Date(order.ts).toLocaleString()
                                const data = order.data || {}

                                let displayData = { ...data }
                                if (order.type === 'pair_exit') {
                                    const pairSym = data?.pair?.long && data?.pair?.short ? `${data.pair.long}/${data.pair.short}` : 'PAIR'
                                    const legA = Array.isArray((data as any)?.legs) ? (data as any).legs[0] : undefined
                                    const legB = Array.isArray((data as any)?.legs) ? (data as any).legs[1] : undefined
                                    const qtyStr = legA && legB ? `${typeof legA.qty === 'number' ? legA.qty.toFixed(2) : 'N/A'}/${typeof legB.qty === 'number' ? legB.qty.toFixed(2) : 'N/A'}` : 'N/A'
                                    const pxStr = legA && legB ? `${typeof legA.price === 'number' ? legA.price.toFixed(2) : 'N/A'}/${typeof legB.price === 'number' ? legB.price.toFixed(2) : 'N/A'}` : 'N/A'
                                    displayData = {
                                        symbol: pairSym,
                                        side: 'EXIT',
                                        qty: qtyStr,
                                        price: pxStr,
                                        status: 'CLOSED',
                                        realizedPnl: typeof data.realizedPnlUsd === 'number' ? `$${data.realizedPnlUsd.toFixed(2)}` : 'N/A'
                                    }
                                } else if (order.type === 'pair_reduce') {
                                    const pairSym = data?.pair?.long && data?.pair?.short ? `${data.pair.long}/${data.pair.short}` : 'PAIR'
                                    const legA = Array.isArray((data as any)?.legs) ? (data as any).legs[0] : undefined
                                    const legB = Array.isArray((data as any)?.legs) ? (data as any).legs[1] : undefined
                                    const qtyStr = legA && legB ? `${typeof legA.qty === 'number' ? legA.qty.toFixed(2) : 'N/A'}/${typeof legB.qty === 'number' ? legB.qty.toFixed(2) : 'N/A'}` : 'N/A'
                                    const pxStr = legA && legB ? `${typeof legA.price === 'number' ? legA.price.toFixed(2) : 'N/A'}/${typeof legB.price === 'number' ? legB.price.toFixed(2) : 'N/A'}` : 'N/A'
                                    displayData = {
                                        symbol: pairSym,
                                        side: 'REDUCE',
                                        qty: qtyStr,
                                        price: pxStr,
                                        status: 'PARTIAL',
                                        realizedPnl: typeof data.realizedPnlUsd === 'number' ? `$${data.realizedPnlUsd.toFixed(2)}` : 'N/A'
                                    }
                                }

                                return (
                                    <tr key={`${order.ts}-${index}`} className="border-b border-border/50 hover:bg-muted/50">
                                        <td className="px-4 py-3 font-mono text-xs">{timestamp}</td>
                                        <td className="px-4 py-3">
                                            <span className={`px-2 py-1 rounded text-xs font-medium ${order.type === 'order' ? 'bg-blue-100 text-blue-800' :
                                                order.type === 'pair_exit' ? 'bg-red-100 text-red-800' :
                                                    'bg-gray-100 text-gray-800'
                                                }`}>
                                                {order.type}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 font-medium">{displayData.symbol || 'N/A'}</td>
                                        <td className="px-4 py-3">
                                            <span className={displayData.side === 'BUY' ? 'text-green-600' : displayData.side === 'SELL' ? 'text-red-600' : ''}>
                                                {displayData.side || 'N/A'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-right font-mono">{
                                            typeof displayData.qty === 'number'
                                                ? displayData.qty.toFixed(2)
                                                : typeof displayData.executedQty === 'number'
                                                    ? displayData.executedQty.toFixed(2)
                                                    : (displayData.qty || displayData.executedQty || 'N/A')
                                        }</td>
                                        <td className="px-4 py-3 text-right font-mono">{typeof displayData.price === 'number' ? `$${displayData.price.toFixed(2)}` : 'N/A'}</td>
                                        <td className="px-4 py-3">
                                            <span className={`px-2 py-1 rounded text-xs ${displayData.status === 'FILLED' ? 'bg-green-100 text-green-800' :
                                                displayData.status === 'CLOSED' ? 'bg-red-100 text-red-800' :
                                                    'bg-yellow-100 text-yellow-800'
                                                }`}>
                                                {displayData.status || 'N/A'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-xs text-muted-foreground max-w-[200px] truncate">
                                            {order.type === 'pair_exit' && displayData.realizedPnl ?
                                                `Realized P&L: ${displayData.realizedPnl}` :
                                                displayData.orderId || 'N/A'
                                            }
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                    {orders.length === 0 && (
                        <div className="text-center py-8 text-muted-foreground">
                            No order history available
                        </div>
                    )}
                </div>
            </div>
        </main>
    )
}


