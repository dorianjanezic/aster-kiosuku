'use client'

import { useState, useEffect } from 'react'
import { z } from 'zod'

const PositionSchema = z.object({ symbol: z.string(), netQty: z.number(), avgEntry: z.number().nullable(), mid: z.number().nullable(), notional: z.number().nullable(), upnl: z.number().nullable() })
const PairPerfSchema = z.object({ key: z.string(), long: z.string(), short: z.string(), upnl: z.number(), notionalEntry: z.number(), percent: z.number() })
const PortfolioResponseSchema = z.object({ summary: z.object({ baseBalance: z.number(), totalNotional: z.number(), totalUpnl: z.number(), equity: z.number() }), positions: z.array(PositionSchema), pairs: z.array(PairPerfSchema) })

function getBaseUrl() {
    // For Railway backend API
    if (process.env.NEXT_PUBLIC_API_BASE_URL && process.env.NEXT_PUBLIC_API_BASE_URL.length > 0) {
        return process.env.NEXT_PUBLIC_API_BASE_URL
    }
    // For local dashboard with API routes
    if (process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL && process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL.length > 0) {
        return process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL
    }
    if (typeof window !== 'undefined' && window.location.origin) {
        return window.location.origin
    }
    return 'http://localhost:3000'
}

export default function PortfolioPage() {
    const [data, setData] = useState<{ positions: any[], summary: any, pairs: any[] } | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        async function fetchPortfolio() {
            try {
                const base = getBaseUrl()
                const url = new URL('/api/portfolio', base).toString()
                const res = await fetch(url)
                if (!res.ok) throw new Error('Failed to fetch portfolio')
                const data = await res.json()
                const parsed = PortfolioResponseSchema.parse(data)
                setData(parsed)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Unknown error')
            } finally {
                setLoading(false)
            }
        }
        fetchPortfolio()
    }, [])

    if (loading) {
        return (
            <main>
                <h2 className="mb-3 text-base font-semibold">Portfolio</h2>
                <div className="text-sm text-muted-foreground">Loading portfolio data...</div>
            </main>
        )
    }

    if (error || !data) {
        return (
            <main>
                <h2 className="mb-3 text-base font-semibold">Portfolio</h2>
                <div className="text-sm text-red-600">Error: {error || 'No data available'}</div>
                <div className="mt-4 text-sm text-muted-foreground">
                    The portfolio API is not available. This dashboard requires a backend service to display trading data.
                </div>
            </main>
        )
    }

    const { positions, summary, pairs } = data
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


