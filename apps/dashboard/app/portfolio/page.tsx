import { z } from 'zod'

const PositionSchema = z.object({ symbol: z.string(), netQty: z.number(), avgEntry: z.number().nullable(), mid: z.number().nullable(), notional: z.number().nullable(), upnl: z.number().nullable() })
const PairPerfSchema = z.object({ key: z.string(), long: z.string(), short: z.string(), upnl: z.number(), notionalEntry: z.number(), percent: z.number() })
const PortfolioResponseSchema = z.object({ summary: z.object({ baseBalance: z.number(), totalNotional: z.number(), totalUpnl: z.number(), equity: z.number() }), positions: z.array(PositionSchema), pairs: z.array(PairPerfSchema) })

// Use relative API routes within the app

async function fetchPortfolio() {
    const res = await fetch('/api/portfolio', { cache: 'no-store' })
    if (!res.ok) throw new Error('Failed to fetch portfolio')
    const data = await res.json()
    return PortfolioResponseSchema.parse(data)
}

export default async function PortfolioPage() {
    const { positions, summary, pairs } = await fetchPortfolio()
    return (
        <main>
            <h2 className="mb-3 text-base font-semibold">Portfolio</h2>
            <div className="mb-3 grid grid-cols-2 gap-3 text-sm text-muted-foreground md:grid-cols-4">
                <div>Balance: ${summary.baseBalance.toFixed(2)}</div>
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
                                <td className="px-4 py-3 text-right font-mono">{p.netQty.toFixed(4)}</td>
                                <td className="px-4 py-3 text-right font-mono">{p.avgEntry != null ? p.avgEntry.toFixed(6) : '-'}</td>
                                <td className="px-4 py-3 text-right font-mono">{p.mid != null ? p.mid.toFixed(6) : '-'}</td>
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
                                    <td className="px-4 py-3 text-right font-mono">{(pp.percent * 100).toFixed(4)}%</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : null}
        </main>
    )
}


