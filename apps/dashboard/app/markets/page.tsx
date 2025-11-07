'use client'

import { z } from 'zod'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

const MarketSchema = z.object({
  symbol: z.string(),
  lastPrice: z.number().optional(),
  baseAsset: z.string().optional(),
  quoteAsset: z.string().optional(),
  maxLeverage: z.number().optional(),
  tickSize: z.number().optional(),
  stepSize: z.number().optional(),
  categories: z.object({
    sector: z.string().optional(),
    ecosystem: z.string().optional(),
    type: z.string().optional(),
    computed: z.object({
      liquidityTier: z.string().optional(),
      volatilityBucket: z.string().optional(),
      fundingProfile: z.string().optional(),
      isMajor: z.boolean().optional()
    }).partial().optional(),
    metrics: z.object({
      quoteVolume: z.number().optional(),
      volume: z.number().optional(),
      bidDepth5: z.number().optional(),
      askDepth5: z.number().optional(),
      notionalBid5: z.number().optional(),
      notionalAsk5: z.number().optional(),
      atrPct14: z.number().optional(),
      fundingMean: z.number().optional(),
      fundingVariance: z.number().optional(),
      liquidityScore: z.number().optional()
    }).partial().optional(),
    narratives: z.array(z.string()).optional()
  }).partial().optional()
})
const MarketsResponseSchema = z.object({ asOf: z.number().optional(), markets: z.array(MarketSchema) })

async function fetchMarkets() {
  const res = await fetch('/api/markets', { cache: 'no-store' })
  if (!res.ok) return { asOf: Date.now(), markets: [] as any[] }
  const data = await res.json()
  const parsed = MarketsResponseSchema.safeParse(data)
  return parsed.success ? parsed.data : { asOf: Date.now(), markets: [] as any[] }
}

export default function MarketsPage() {
  const [asOf, setAsOf] = useState<number | null>(null)
  const [markets, setMarkets] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchMarkets()
      .then((d) => { setAsOf(d.asOf || null); setMarkets(d.markets || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const fmtNum = (n?: number, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '-')
  const fmtPct = (n?: number, d = 2) => (typeof n === 'number' ? `${n.toFixed(d)}%` : '-')
  const fmtK = (n?: number) => {
    if (typeof n !== 'number') return '-'
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'
    return n.toFixed(0)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Markets</h1>
        {asOf && (
          <span className="text-xs text-muted-foreground">Updated {new Date(asOf).toLocaleString()}</span>
        )}
      </div>
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Symbol</th>
                  <th className="px-4 py-3 text-right font-medium">Last</th>
                  <th className="px-4 py-3 text-right font-medium">Sector</th>
                  <th className="px-4 py-3 text-right font-medium">Tier</th>
                  <th className="px-4 py-3 text-right font-medium">Volatility</th>
                  <th className="px-4 py-3 text-right font-medium">Quote Vol</th>
                  <th className="px-4 py-3 text-right font-medium">Depth5 Notional</th>
                  <th className="px-4 py-3 text-right font-medium">ATR%14</th>
                  <th className="px-4 py-3 text-right font-medium">Funding μ</th>
                  <th className="px-4 py-3 text-right font-medium">Liq Score</th>
                </tr>
              </thead>
              <tbody>
                {markets.map((m) => (
                  <tr key={m.symbol} className="border-b border-border/50 hover:bg-muted/50">
                    <td className="px-4 py-3 font-medium">
                      <div className="flex items-center gap-2">
                        <span>{m.symbol}</span>
                        <Badge variant="outline" className="text-xxs">{m.baseAsset}/{m.quoteAsset}</Badge>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">{fmtNum(m.lastPrice, 6)}</td>
                    <td className="px-4 py-3 text-right">{m.categories?.sector || '-'}</td>
                    <td className="px-4 py-3 text-right">{m.categories?.computed?.liquidityTier || '-'}</td>
                    <td className="px-4 py-3 text-right">{m.categories?.computed?.volatilityBucket || '-'}</td>
                    <td className="px-4 py-3 text-right">{fmtK(m.categories?.metrics?.quoteVolume)}</td>
                    <td className="px-4 py-3 text-right">{fmtK(((m.categories?.metrics?.notionalBid5 || 0) + (m.categories?.metrics?.notionalAsk5 || 0)))}</td>
                    <td className="px-4 py-3 text-right">{fmtPct(m.categories?.metrics?.atrPct14, 2)}</td>
                    <td className="px-4 py-3 text-right">{typeof m.categories?.metrics?.fundingMean === 'number' ? (m.categories!.metrics!.fundingMean! * 100).toFixed(4) + ' bps' : '-'}</td>
                    <td className="px-4 py-3 text-right">{fmtNum(m.categories?.metrics?.liquidityScore, 3)}</td>
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


