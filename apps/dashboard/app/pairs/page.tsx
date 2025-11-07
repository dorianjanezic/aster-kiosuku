'use client'

import { z } from 'zod'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Search, Filter, SortAsc, SortDesc, AlertCircle, CheckCircle, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react'
import { useState, useMemo, useEffect } from 'react'
import { MetricHeader } from '@/components/MetricHeader'

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

const PairsResponseSchema = z.object({ asOf: z.number().optional(), pairs: z.array(PairSchema) })

function getBaseUrl() {
    if (process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL && process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL.length > 0) {
        return process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL
    }
    // Vercel provides VERCEL_URL without protocol
    if (process.env.VERCEL_URL && process.env.VERCEL_URL.length > 0) {
        return `https://${process.env.VERCEL_URL}`
    }
    return 'http://localhost:3000'
}

async function fetchPairs() {
    const base = getBaseUrl()
    const url = new URL('/api/pairs', base).toString()
    const res = await fetch(url, { next: { revalidate: 5 } })
    if (!res.ok) throw new Error('Failed to fetch pairs')
    const data = await res.json()
    return PairsResponseSchema.parse(data)
}

type SortField = 'corr' | 'spreadZ' | 'halfLife' | 'composite' | 'beta' | 'fundingNet'
type SortDirection = 'asc' | 'desc'

export default function PairsPage() {
    const [pairs, setPairs] = useState<any[]>([])
    const [asOf, setAsOf] = useState<number | null>(null)
    const [loading, setLoading] = useState(true)
    const [searchTerm, setSearchTerm] = useState('')
    const [sectorFilter, setSectorFilter] = useState<string>('all')
    const [sortField, setSortField] = useState<SortField>('spreadZ')
    const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

    useEffect(() => {
        fetchPairs()
            .then(data => {
                setPairs(data.pairs)
                setAsOf(data.asOf || null)
                setLoading(false)
            })
            .catch(err => {
                console.error('Failed to load pairs:', err)
                setLoading(false)
            })
    }, [])

    const sectors = useMemo(() => {
        const unique = new Set(pairs.map(p => p.sector).filter(Boolean))
        return Array.from(unique).sort()
    }, [pairs])

    const filteredAndSortedPairs = useMemo(() => {
        let filtered = pairs.filter(pair => {
            const matchesSearch = searchTerm === '' ||
                pair.long.toLowerCase().includes(searchTerm.toLowerCase()) ||
                pair.short.toLowerCase().includes(searchTerm.toLowerCase())

            const matchesSector = sectorFilter === 'all' || pair.sector === sectorFilter

            return matchesSearch && matchesSector
        })

        filtered.sort((a, b) => {
            let aValue: number
            let bValue: number

            switch (sortField) {
                case 'corr':
                    aValue = a.corr
                    bValue = b.corr
                    break
                case 'spreadZ':
                    aValue = Math.abs(a.spreadZ)
                    bValue = Math.abs(b.spreadZ)
                    break
                case 'halfLife':
                    aValue = a.cointegration.halfLife
                    bValue = b.cointegration.halfLife
                    break
                case 'composite':
                    aValue = a.scores.composite
                    bValue = b.scores.composite
                    break
                case 'beta':
                    aValue = Math.abs(a.beta)
                    bValue = Math.abs(b.beta)
                    break
                case 'fundingNet':
                    aValue = a.fundingNet || 0
                    bValue = b.fundingNet || 0
                    break
                default:
                    return 0
            }

            if (sortDirection === 'asc') {
                return aValue - bValue
            } else {
                return bValue - aValue
            }
        })

        return filtered
    }, [pairs, searchTerm, sectorFilter, sortField, sortDirection])

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
        } else {
            setSortField(field)
            setSortDirection('desc')
        }
    }

    const getSortIcon = (field: SortField) => {
        if (sortField !== field) return null
        return sortDirection === 'asc' ? <SortAsc className="h-4 w-4" /> : <SortDesc className="h-4 w-4" />
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            {/* Header with stats */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Trading Pairs</h1>
                    <p className="text-muted-foreground">
                        {pairs.length} total pairs • {filteredAndSortedPairs.length} filtered
                        {asOf && (
                            <span className="ml-2 text-xs">
                                • Updated {new Date(asOf).toLocaleString()}
                            </span>
                        )}
                    </p>
                </div>
                <Button variant="outline" size="sm">
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Refresh
                </Button>
            </div>

            {/* Filters */}
            <Card>
                <CardContent className="pt-6">
                    <div className="flex flex-col sm:flex-row gap-4">
                        <div className="flex-1">
                            <div className="relative">
                                <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                                <Input
                                    placeholder="Search pairs (e.g., BTC, ETH)..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="pl-9"
                                />
                            </div>
                        </div>
                        <Select value={sectorFilter} onValueChange={setSectorFilter}>
                            <SelectTrigger className="w-full sm:w-[200px]">
                                <Filter className="h-4 w-4 mr-2" />
                                <SelectValue placeholder="Filter by sector" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Sectors</SelectItem>
                                {sectors.map(sector => (
                                    <SelectItem key={sector} value={sector}>
                                        {sector}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            {/* Pairs Table */}
            <Card>
                <CardContent className="p-0">
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="border-b bg-muted/50">
                                    <th className="px-4 py-3 text-left font-medium">Pair</th>
                                    <th
                                        className="px-4 py-3 text-right font-medium cursor-pointer hover:bg-muted/70 transition-colors"
                                        onClick={() => handleSort('corr')}
                                    >
                                        <div className="flex items-center justify-end gap-1"><MetricHeader align="right" label="Correlation" tip="Pearson correlation of leg returns (higher = tighter co-movement)" /> {getSortIcon('corr')}</div>
                                    </th>
                                    <th
                                        className="px-4 py-3 text-right font-medium cursor-pointer hover:bg-muted/70 transition-colors"
                                        onClick={() => handleSort('spreadZ')}
                                    >
                                        <div className="flex items-center justify-end gap-1"><MetricHeader align="right" label="Spread Z" tip="Z-score of the cointegrated spread (magnitude shows current divergence)" /> {getSortIcon('spreadZ')}</div>
                                    </th>
                                    <th
                                        className="px-4 py-3 text-right font-medium cursor-pointer hover:bg-muted/70 transition-colors"
                                        onClick={() => handleSort('halfLife')}
                                    >
                                        <div className="flex items-center justify-end gap-1"><MetricHeader align="right" label="Half-Life" tip="Estimated mean-reversion half-life of the spread in periods (lower = faster)" /> {getSortIcon('halfLife')}</div>
                                    </th>
                                    <th
                                        className="px-4 py-3 text-right font-medium cursor-pointer hover:bg-muted/70 transition-colors"
                                        onClick={() => handleSort('beta')}
                                    >
                                        <div className="flex items-center justify-end gap-1"><MetricHeader align="right" label="Beta" tip="Hedge ratio from OLS (used for dollar-neutral sizing)" /> {getSortIcon('beta')}</div>
                                    </th>
                                    <th
                                        className="px-4 py-3 text-right font-medium cursor-pointer hover:bg-muted/70 transition-colors"
                                        onClick={() => handleSort('fundingNet')}
                                    >
                                        <div className="flex items-center justify-end gap-1"><MetricHeader align="right" label="Funding Net" tip="Estimated net funding carry for a dollar-neutral position (higher is better)" /> {getSortIcon('fundingNet')}</div>
                                    </th>
                                    <th
                                        className="px-4 py-3 text-right font-medium cursor-pointer hover:bg-muted/70 transition-colors"
                                        onClick={() => handleSort('composite')}
                                    >
                                        <div className="flex items-center justify-end gap-1"><MetricHeader align="right" label="Score" tip="Composite ranking combining correlation, divergence, half-life, stationarity and technicals" /> {getSortIcon('composite')}</div>
                                    </th>
                                    <th className="px-4 py-3 text-left font-medium"><MetricHeader label="Sector" tip="Primary sector(s) of the pair; mixed shows A/B when legs differ" /></th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredAndSortedPairs.map((p) => {
                                    const swapped = p.spreadZ > 0
                                    const dispLong = swapped ? p.short : p.long
                                    const dispShort = swapped ? p.long : p.short
                                    const displayedZ = Math.abs(swapped ? -p.spreadZ : p.spreadZ)
                                    const displayedSector = (() => {
                                        if (!p.sector) return 'Unknown'
                                        const parts = String(p.sector).split('/')
                                        if (parts.length !== 2) return p.sector
                                        return swapped ? `${parts[1]}/${parts[0]}` : p.sector
                                    })()
                                    return (
                                        <tr key={`${p.long}|${p.short}`} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                                            <td className="px-4 py-3 font-medium">
                                                <div className="flex items-center gap-2">
                                                    <span>{dispLong} / {dispShort}</span>
                                                    {Math.abs(p.spreadZ) > 2 && (
                                                        <Badge variant="warning" className="text-xs">
                                                            <AlertCircle className="h-3 w-3 mr-1" />
                                                            High Z
                                                        </Badge>
                                                    )}
                                                    {p.cointegration.adfT > -2 && (
                                                        <Badge variant="destructive" className="text-xs">
                                                            <AlertCircle className="h-3 w-3 mr-1" />
                                                            Weak Stationarity
                                                        </Badge>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <span className={p.corr > 0.7 ? "text-green-600 font-medium" : p.corr < 0.5 ? "text-red-600" : ""}>
                                                    {p.corr.toFixed(3)}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <span className={displayedZ > 1.5 ? "font-medium" : ""}>
                                                    {displayedZ.toFixed(3)}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <span className={p.cointegration.halfLife < 25 ? "text-green-600" : p.cointegration.halfLife > 50 ? "text-red-600" : ""}>
                                                    {p.cointegration.halfLife.toFixed(1)}p
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-right">{p.beta.toFixed(3)}</td>
                                            <td className="px-4 py-3 text-right">
                                                {p.fundingNet != null ? (
                                                    <span className={p.fundingNet > 0 ? "text-green-600" : "text-red-600"}>
                                                        {(p.fundingNet * 100).toFixed(4)}%
                                                    </span>
                                                ) : (
                                                    <span className="text-muted-foreground">-</span>
                                                )}
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <span className={p.scores.composite > 0 ? "text-green-600 font-medium" : "text-red-600"}>
                                                    {p.scores.composite.toFixed(3)}
                                                </span>
                                            </td>
                                        <td className="px-4 py-3 flex justify-end">
                                            <Badge variant="outline" className="text-xs">
                                                {displayedSector}
                                            </Badge>
                                        </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                    {filteredAndSortedPairs.length === 0 && (
                        <div className="text-center py-12 text-muted-foreground">
                            No pairs match your current filters.
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}


