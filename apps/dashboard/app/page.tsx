import { z } from 'zod'
import { StatsCard } from '@/components/stats-card'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RefreshCw, TrendingUp, TrendingDown, Activity, AlertCircle, CheckCircle } from 'lucide-react'

// Pairs schemas (very tolerant to missing/extra fields)
const PriceSchema = z.object({ last: z.number().optional(), bestBid: z.number().optional(), bestAsk: z.number().optional(), mid: z.number().optional() }).passthrough()
const PairSchema = z.object({
    long: z.string(),
    short: z.string(),
    corr: z.number().optional(),
    beta: z.number().optional(),
    hedgeRatio: z.number().optional(),
    cointegration: z.object({ adfT: z.number().optional(), p: z.number().nullable().optional(), lags: z.number().optional(), halfLife: z.number().optional(), stationary: z.boolean().optional() }).optional().passthrough(),
    spreadZ: z.number().optional(),
    fundingNet: z.number().optional(),
    scores: z.object({ long: z.number().optional(), short: z.number().optional(), composite: z.number().optional() }).optional().passthrough(),
    notes: z.array(z.string()).optional(),
    sector: z.string().optional(),
    prices: z.object({ long: PriceSchema, short: PriceSchema }).optional().passthrough()
}).passthrough()
const PairsResponseSchema = z.object({ asOf: z.number().optional(), pairs: z.array(PairSchema) }).passthrough()

// Cycles schemas
const SlimCycleEventSchema = z.object({ ts: z.number(), type: z.enum(['user', 'decision']), data: z.unknown() }).passthrough()
const SlimCyclesResponseSchema = z.object({ events: z.array(SlimCycleEventSchema) }).passthrough()

// Portfolio schemas
const PositionSchema = z.object({ symbol: z.string(), netQty: z.number(), avgEntry: z.number().nullable(), mid: z.number().nullable(), notional: z.number().nullable(), upnl: z.number().nullable() }).passthrough()
const PairPerfSchema = z.object({ key: z.string(), long: z.string(), short: z.string(), upnl: z.number(), notionalEntry: z.number(), percent: z.number() }).passthrough()
const PortfolioResponseSchema = z.object({ summary: z.object({ baseBalance: z.number(), totalNotional: z.number(), totalUpnl: z.number(), equity: z.number() }), positions: z.array(PositionSchema), pairs: z.array(PairPerfSchema) }).passthrough()

// Use relative URLs within Next.js app router

async function fetchPairs() {
    try {
        const res = await fetch('/api/pairs', { cache: 'no-store' })
        if (!res.ok) {
            console.error('Pairs API returned status:', res.status)
            return { asOf: Date.now(), pairs: [] }
        }
        const data = await res.json()
        console.log('Pairs API response:', data)
        const parsed = PairsResponseSchema.safeParse(data)
        if (parsed.success) {
            console.log('Parsed pairs successfully, count:', parsed.data.pairs?.length || 0)
            return parsed.data
        } else {
            console.error('Failed to parse pairs data:', parsed.error)
            return { asOf: data?.asOf || Date.now(), pairs: Array.isArray(data?.pairs) ? data.pairs : [] }
        }
    } catch (err) {
        console.error('Error fetching pairs:', err)
        return { asOf: Date.now(), pairs: [] }
    }
}

async function fetchCycles() {
    try {
        const res = await fetch('/api/cycles', { cache: 'no-store' })
        if (!res.ok) return { events: [] }
        const data = await res.json()
        const parsed = SlimCyclesResponseSchema.safeParse(data)
        if (parsed.success) {
            return parsed.data
        } else {
            console.error('Failed to parse cycles data:', parsed.error)
            return { events: Array.isArray(data?.events) ? data.events : [] }
        }
    } catch (err) {
        console.error('Error fetching cycles:', err)
        return { events: [] }
    }
}

async function fetchPortfolio() {
    try {
        const res = await fetch('/api/portfolio', { cache: 'no-store' })
        if (!res.ok) return { summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }
        const data = await res.json()
        const parsed = PortfolioResponseSchema.safeParse(data)
        if (parsed.success) {
            return parsed.data
        } else {
            console.error('Failed to parse portfolio data:', parsed.error)
            return { summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }
        }
    } catch (err) {
        console.error('Error fetching portfolio:', err)
        return { summary: { baseBalance: 10000, totalNotional: 0, totalUpnl: 0, equity: 10000 }, positions: [], pairs: [] }
    }
}

function formatJson(data: unknown): string {
    try {
        if (typeof data === 'string') {
            try {
                const parsed = JSON.parse(data)
                return JSON.stringify(parsed, null, 2)
            } catch {
                return data
            }
        }
        return JSON.stringify(data, null, 2)
    } catch {
        return '[unserializable]'
    }
}

function teaser(text: string, max = 160): string {
    if (text.length <= max) return text
    return text.slice(0, max).trimEnd()
}

function formatMessage(data: unknown): string {
    if (typeof data === 'string') {
        return data
    }

    if (data && typeof data === 'object') {
        // Handle decision events with "raw" field
        if ('raw' in data && typeof data.raw === 'string') {
            try {
                const parsed = JSON.parse(data.raw)
                if (parsed.summary && typeof parsed.summary === 'string') {
                    return parsed.summary
                }
                return data.raw
            } catch {
                // If JSON parsing fails, try to extract summary from raw string
                const rawStr = data.raw as string
                const summaryMatch = rawStr.match(/"summary"\s*:\s*"([^"]+)"/)
                if (summaryMatch && summaryMatch[1]) {
                    return summaryMatch[1]
                }
                return rawStr
            }
        }

        // Handle user_raw/state events with "content" field
        if ('content' in data && typeof data.content === 'string') {
            // Always return a concise summary for state updates instead of full content
            return "Portfolio and market state assessment for trading decision"
        }
    }

    // Fallback to JSON formatting
    return formatJson(data)
}

export default async function DashboardPage() {
    const [{ pairs, asOf }, { events }, { positions, summary, pairs: pairPerformances }] = await Promise.all([
        fetchPairs(),
        fetchCycles(),
        fetchPortfolio()
    ])

    const sortedEvents = [...events].sort((a, b) => b.ts - a.ts)
    const recentEvents = sortedEvents.slice(0, 5)

    // Calculate some derived metrics
    const totalPairs = pairs.length
    const overviewPairs = [...pairs].sort((a, b) => (b.scores?.composite ?? -Infinity) - (a.scores?.composite ?? -Infinity))
    const activePositions = positions.filter(p => Math.abs(p.netQty) > 0.0001).length
    const profitablePairs = pairPerformances.filter(p => p.upnl > 0).length
    const totalExposure = summary.totalNotional

    // Calculate performance metrics
    const equityChange = summary.equity - summary.baseBalance
    const equityChangePercent = summary.baseBalance > 0 ? (equityChange / summary.baseBalance) * 100 : 0

    return (
        <div className="space-y-6">
            {/* Overview Stats */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <StatsCard
                    title="Portfolio Equity"
                    value={summary.equity}
                    change={{
                        value: equityChangePercent,
                        type: equityChangePercent > 0 ? 'positive' : equityChangePercent < 0 ? 'negative' : 'neutral'
                    }}
                    icon="dollar"
                />
                <StatsCard
                    title="Total P&L"
                    value={summary.totalUpnl}
                    icon="chart"
                />
                <StatsCard
                    title="Active Positions"
                    value={`${activePositions}/${positions.length}`}
                    icon="activity"
                />
                <StatsCard
                    title="Total Exposure"
                    value={totalExposure}
                    icon="dollar"
                />
            </div>

            {/* Recent Activity & Quick Actions */}
            <div className="grid grid-cols-1 gap-6">
                <section className="w-full">
                    <div className="flex items-center gap-2 mb-3">
                        <Activity className="h-5 w-5 text-muted-foreground" />
                        <h2 className="text-base font-medium">Recent Activity</h2>
                    </div>
                    <div className="space-y-2 w-full">
                        {recentEvents.map((e) => {
                            const isDecision = e.type === 'decision'
                            const content = formatMessage(e.data)
                            const timeString = new Date(e.ts).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit'
                            })

                            return (
                                <div key={`${e.ts}-${e.type}`} className="w-full flex items-start gap-3 py-3 border-b border-border/50">
                                    <Badge
                                        variant={isDecision ? "default" : "secondary"}
                                        className="mt-0.5 text-xs font-medium"
                                    >
                                        {isDecision ? 'Agent' : 'State'}
                                    </Badge>
                                    <div className="flex-1 min-w-0 w-full">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="text-xs text-muted-foreground font-mono">
                                                {timeString}
                                            </span>
                                            <span className="text-xs text-muted-foreground">•</span>
                                            <span className="text-xs text-muted-foreground">
                                                {new Date(e.ts).toLocaleDateString()}
                                            </span>
                                            {!isDecision && (
                                                <span className="ml-auto text-xs text-muted-foreground">
                                                    Equity: ${summary.equity.toFixed(2)}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-sm text-white leading-relaxed w-full whitespace-nowrap overflow-hidden">
                                            {teaser(content, 200)}
                                        </p>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </section>


            </div>

            {/* Pairs Overview */}
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <CardTitle>Top Trading Pairs</CardTitle>
                        <div className="flex items-center gap-2">
                            <Badge variant="outline">
                                {totalPairs} Available
                            </Badge>
                            {asOf && (
                                <span className="text-xs text-muted-foreground">
                                    Updated {new Date(asOf).toLocaleString()}
                                </span>
                            )}
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="border-b">
                                    <th className="px-4 py-2 text-left font-medium">Pair</th>
                                    <th className="px-4 py-2 text-right font-medium">Correlation</th>
                                    <th className="px-4 py-2 text-right font-medium">Spread Z</th>
                                    <th className="px-4 py-2 text-right font-medium">Half-Life</th>
                                    <th className="px-4 py-2 text-right font-medium">Score</th>
                                    <th className="px-4 py-2 text-left font-medium">Sector</th>
                                </tr>
                            </thead>
                            <tbody>
                                {overviewPairs.slice(0, 10).map((p) => (
                                    <tr key={`${p.long}|${p.short}`} className="border-b border-border/50 hover:bg-muted/50">
                                        <td className="px-4 py-3 font-medium">
                                            <div className="flex items-center gap-2">
                                                <span>{p.long} / {p.short}</span>
                                                {typeof p.spreadZ === 'number' && Math.abs(p.spreadZ) > 2 && (
                                                    <Badge variant="warning" className="text-xs">
                                                        <AlertCircle className="h-3 w-3 mr-1" />
                                                        High Z
                                                    </Badge>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            {typeof p.corr === 'number' ? (
                                                <span className={p.corr > 0.7 ? "text-green-600 font-medium" : ""}>
                                                    {p.corr.toFixed(3)}
                                                </span>
                                            ) : '-'}
                                        </td>
                                        <td className="px-4 py-3 text-right">{typeof p.spreadZ === 'number' ? p.spreadZ.toFixed(3) : '-'}</td>
                                        <td className="px-4 py-3 text-right">{typeof p.cointegration?.halfLife === 'number' ? `${p.cointegration.halfLife.toFixed(1)}p` : '-'}</td>
                                        <td className="px-4 py-3 text-right">
                                            {typeof p.scores?.composite === 'number' ? (
                                                <span className={p.scores.composite > 0 ? "text-green-600" : "text-red-600"}>
                                                    {p.scores.composite.toFixed(3)}
                                                </span>
                                            ) : '-'}
                                        </td>
                                        <td className="px-4 py-3">
                                            <Badge variant="outline" className="text-xs">
                                                {p.sector ?? 'Unknown'}
                                            </Badge>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                </CardContent>
            </Card>
        </div>
    )
}

