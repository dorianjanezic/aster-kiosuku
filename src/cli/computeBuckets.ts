import 'dotenv/config';
import { promises as fs } from 'fs';
import { computeBuckets } from '../lib/computeBuckets.js';
import { PublicClient } from '../http/publicClient.js';
import { computeTechnicalsFromKlines } from '../tech/indicators.js';

async function main() {
    const marketsPath = 'sim_data/markets.json';
    const text = await fs.readFile(marketsPath, 'utf8');
    const data = JSON.parse(text);
    const rawMarkets: any[] = data.markets || [];
    const markets: any[] = rawMarkets.filter((m: any) => m && typeof m === 'object' && m.symbol);
    const onlySymbol = process.env.BUCKETS_ONLY_SYMBOL || '';
    const targets = onlySymbol ? markets.filter((m: any) => m && m.symbol === onlySymbol) : markets;
    if (onlySymbol && targets.length === 0) {
        console.warn(`[compute:buckets] symbol not found: ${onlySymbol}`);
    }

    const majors = (process.env.BUCKETS_MAJORS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
    const useLive = String(process.env.BUCKETS_FETCH_LIVE || 'true') === 'true';
    const conc = Math.max(1, Math.min(10, Number(process.env.BUCKETS_CONCURRENCY || '5')));
    const interval = process.env.BUCKETS_ATR_INTERVAL || '15m';
    const baseUrl = process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com';
    const basePath = process.env.ASTER_BASE_PATH || '/fapi/v1';
    const client = new PublicClient(baseUrl, basePath);

    let idx = 0; let ok = 0; let fail = 0;
    let haveT24 = 0, haveDepth = 0, haveAtr = 0;
    const liqDist: Record<string, number> = {}; const volDist: Record<string, number> = {}; const fundDist: Record<string, number> = {};
    const liqScores: Array<{ idx: number; symbol: string; score: number }> = [];

    async function processOne(m: any): Promise<any> {
        try {
            let stats24h: any = m.categories?.stats24h || m.stats24h;
            let orderbook: any = m.categories?.orderbook || m.orderbook;
            let atrPct14: number | undefined = m.categories?.atrPct14 || m.atrPct14;

            if (useLive) {
                // Fetch 24h stats
                try { stats24h = await client.getTicker24h(m.symbol); haveT24++; } catch { /* ignore */ }
                // Fetch orderbook depth 5
                try {
                    const ob = await client.getOrderbook(m.symbol, 5);
                    const sumQty = (arr: Array<[number, number]>) => arr.reduce((acc, [_, q]) => acc + q, 0);
                    const sumNotional = (arr: Array<[number, number]>) => arr.reduce((acc, [p, q]) => acc + p * q, 0);
                    orderbook = {
                        bidDepth5: sumQty(ob.bids as any),
                        askDepth5: sumQty(ob.asks as any),
                        notionalBid5: sumNotional(ob.bids as any),
                        notionalAsk5: sumNotional(ob.asks as any)
                    };
                    haveDepth++;
                } catch { /* ignore */ }
                // Compute ATR% from mark price klines if available (fallback to trade klines)
                try {
                    let kl = await client.getMarkPriceKlines(m.symbol, interval, 200).catch(async () => await client.getKlines(m.symbol, interval, 200));
                    const tech = computeTechnicalsFromKlines(kl as any);
                    const lastClose = kl[kl.length - 1]?.[4];
                    const atr = (tech as any)?.volatility?.atr;
                    if (typeof atr === 'number' && typeof lastClose === 'number' && lastClose > 0) {
                        atrPct14 = (atr / lastClose) * 100;
                        haveAtr++;
                    }
                } catch { /* ignore */ }
                // Fallback: approximate 24h quoteVolume from 24 x 1h trade klines
                try {
                    if (!stats24h || stats24h.quoteVolume == null) {
                        const kl1h = await client.getKlines(m.symbol, '1h', 24);
                        const sumVol = kl1h.reduce((acc: number, row: any) => acc + Number(row[5] || 0), 0);
                        const sumQuote = kl1h.reduce((acc: number, row: any) => acc + Number(row[5] || 0) * Number(row[4] || 0), 0);
                        stats24h = { volume: sumVol, quoteVolume: sumQuote } as any;
                        haveT24++;
                    }
                } catch { /* ignore */ }
            }
            // Funding profile from fundingRate samples (mean/variance)
            let fundingStats: { mean?: number; variance?: number } | undefined;
            try {
                const fr = await client.getFundingRate(m.symbol, 50);
                const vals = Array.isArray(fr) ? fr.map((x: any) => Number(x.fundingRate)).filter((n: any) => Number.isFinite(n)) : [];
                if (vals.length) {
                    const mean = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
                    const variance = vals.reduce((a: number, b: number) => a + (b - mean) * (b - mean), 0) / vals.length;
                    fundingStats = { mean, variance };
                }
            } catch { /* ignore */ }

            const buckets = computeBuckets({
                symbol: m.symbol,
                baseAsset: m.baseAsset,
                stats24h: stats24h ? { volume: Number(stats24h.volume), quoteVolume: Number(stats24h.quoteVolume) } : undefined,
                orderbook,
                atrPct14,
                funding: fundingStats,
                majors
            });
            if (onlySymbol) {
                const notionalDepth = (orderbook?.notionalBid5 ?? 0) + (orderbook?.notionalAsk5 ?? 0);
                const qv = stats24h ? Number(stats24h.quoteVolume) : 0;
                const mean = fundingStats?.mean ?? 0; const variance = fundingStats?.variance ?? 0;
                console.log(`[debug:${m.symbol}] qVol=${qv.toFixed(2)} notionalDepth=${notionalDepth.toFixed(2)} atrPct14=${(atrPct14 ?? 0).toFixed(3)} fundMean=${mean.toFixed(6)} fundVar=${variance.toFixed(8)}`);
            }
            liqDist[buckets.liquidityTier || 'NA'] = (liqDist[buckets.liquidityTier || 'NA'] || 0) + 1;
            volDist[buckets.volatilityBucket || 'NA'] = (volDist[buckets.volatilityBucket || 'NA'] || 0) + 1;
            fundDist[buckets.fundingProfile || 'NA'] = (fundDist[buckets.fundingProfile || 'NA'] || 0) + 1;

            const prev = m.categories?.computed || {};
            const notionalDepth = (orderbook?.notionalBid5 ?? 0) + (orderbook?.notionalAsk5 ?? 0);
            const qVolNum = stats24h ? Number(stats24h.quoteVolume) : 0;
            const liqScore = Math.log10(1 + Math.max(0, qVolNum)) + Math.log10(1 + Math.max(0, notionalDepth));
            const metrics = {
                quoteVolume: stats24h ? Number(stats24h.quoteVolume) : null,
                volume: stats24h ? Number(stats24h.volume) : null,
                bidDepth5: orderbook?.bidDepth5 ?? null,
                askDepth5: orderbook?.askDepth5 ?? null,
                notionalBid5: orderbook?.notionalBid5 ?? null,
                notionalAsk5: orderbook?.notionalAsk5 ?? null,
                atrPct14: atrPct14 ?? null,
                fundingMean: fundingStats?.mean ?? null,
                fundingVariance: fundingStats?.variance ?? null,
                liquidityScore: Number.isFinite(liqScore) ? liqScore : null
            };
            ok++;
            // Keep initial buckets; we'll override liquidityTier by percentile after batch
            const updated = { ...m, categories: { ...(m.categories || {}), computed: { ...prev, ...buckets }, metrics } };
            return updated;
        } catch {
            fail++;
            return m;
        } finally {
            idx++;
            if (idx % 20 === 0) {
                console.log(`[compute:buckets] progress ${idx}/${markets.length} (ok=${ok}, fail=${fail})`);
            }
        }
    }

    // Concurrency control
    const out: any[] = markets.map((m) => m); // start with original, mutate updated entries
    let i = 0;
    await Promise.all(Array.from({ length: conc }).map(async () => {
        while (i < targets.length) {
            const cur = i++;
            const idxInMarkets = markets.findIndex((x) => x.symbol === targets[cur].symbol);
            const processed = await processOne(targets[cur]);
            out[idxInMarkets] = processed;
        }
    }));

    // Percentile-based liquidity tiers across processed set
    for (let j = 0; j < out.length; j++) {
        const mm = out[j];
        if (!mm || !mm.categories || !mm.categories.metrics) continue;
        const sc = Number(mm.categories.metrics.liquidityScore ?? NaN);
        if (Number.isFinite(sc)) liqScores.push({ idx: j, symbol: mm.symbol, score: sc });
    }
    if (liqScores.length > 0) {
        const sorted = [...liqScores].sort((a, b) => b.score - a.score);
        const n = sorted.length;
        const cutT1 = Math.ceil(n * 0.2);
        const cutT2 = Math.ceil(n * 0.6);
        sorted.forEach((e, k) => {
            const tier = k < cutT1 ? 'T1' : k < cutT2 ? 'T2' : 'T3';
            const mm = out[e.idx];
            if (mm && typeof mm === 'object') {
                (mm as any).categories ??= {};
                (mm as any).categories.computed ??= {};
                (mm as any).categories.computed.liquidityTier = tier;
            }
        });
        const tierDist: Record<string, number> = { T1: 0, T2: 0, T3: 0 };
        sorted.forEach((e, k) => {
            const tier = (k < cutT1 ? 'T1' : k < cutT2 ? 'T2' : 'T3') as 'T1' | 'T2' | 'T3';
            const em = out[e.idx] as any;
            if (!em) return;
            const cat = (em.categories ||= {}) as any;
            const comp = (cat.computed ||= {}) as any;
            comp.liquidityTier = tier;
        });
        console.log(`[percentiles] liquidity tiers => ${JSON.stringify(tierDist)}`);
    }

    const result = { ...data, markets: out, bucketsAsOf: Date.now() };
    // Backup before writing
    try { await fs.copyFile(marketsPath, 'sim_data/markets.json.bak'); } catch { /* ignore */ }
    await fs.writeFile(marketsPath, JSON.stringify(result, null, 2));
    console.log(`computed buckets for ${targets.length} markets (total=${markets.length})`);
    console.log(`[inputs] 24h stats: ${haveT24}, depth: ${haveDepth}, atr%: ${haveAtr}`);
    console.log(`[dist] liquidity: ${JSON.stringify(liqDist)}, volatility: ${JSON.stringify(volDist)}, funding: ${JSON.stringify(fundDist)}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});


