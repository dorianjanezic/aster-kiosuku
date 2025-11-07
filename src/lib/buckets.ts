import { promises as fs } from 'fs';
import { PublicClient } from '../http/publicClient.js';
import { computeTechnicalsFromKlines } from '../tech/indicators.js';

type MarketRec = any;

export async function updateMarketsBuckets(client: PublicClient, marketsPath = 'sim_data/markets.json', opts?: { interval?: string; limit?: number; concurrency?: number }): Promise<void> {
    const interval = opts?.interval || '15m';
    const limit = opts?.limit || 200;
    const conc = Math.max(1, Math.min(10, opts?.concurrency || 5));
    let data = { markets: [] as MarketRec[] } as { markets: MarketRec[] };
    try {
    const raw = await fs.readFile(marketsPath, 'utf8');
        data = JSON.parse(raw) as { markets: MarketRec[] };
    } catch {
        try {
            const { getDb } = await import('../db/sqlite.js');
            const { SqliteRepo } = await import('../services/sqliteRepo.js');
            const repo = new SqliteRepo(await getDb());
            const latest: any = repo.getLatestMarkets();
            if (latest && Array.isArray(latest.markets)) data = { markets: latest.markets } as any;
        } catch {}
    }
    const markets = (data.markets || []).filter(Boolean);

    // Hydrate missing categories from local maps
    let localMap: Record<string, any> = {};
    let userMap: Record<string, any> = {};
    try {
        const txt = await fs.readFile('src/data/assetCategories.json', 'utf8');
        localMap = JSON.parse(txt);
    } catch { }
    try {
        const txt = await fs.readFile('src/data/userAssetCategories.json', 'utf8');
        userMap = JSON.parse(txt);
    } catch { }
    const catLookup = { ...localMap, ...userMap } as Record<string, any>;

    let i = 0;
    const out: MarketRec[] = markets.map(m => m);
    const liqScores: Array<{ idx: number; score: number }> = [];

    function normalizeBase(base: string): string {
        if (base && base.startsWith('1000')) {
            const u = base.replace(/^1000/, '');
            if (['SHIB', 'FLOKI', 'BONK', 'PEPE', 'CHEEMS'].includes(u)) return u;
        }
        return base;
    }

    async function processOne(idx: number): Promise<void> {
        const m = markets[idx];
        if (!m) return;
        // Ensure category sector if missing
        try {
            const base = (m as any).baseAsset as string;
            const canon = normalizeBase(base);
            if (!m.categories) m.categories = {};
            const src = (base && catLookup[base]) ? catLookup[base] : (canon && catLookup[canon] ? catLookup[canon] : undefined);
            if (!m.categories.sector && src) {
                m.categories.sector = src.sector;
                if (!m.categories.ecosystem && src.ecosystem) m.categories.ecosystem = src.ecosystem;
                if (!m.categories.type && src.type) m.categories.type = src.type;
            }
        } catch { }

        // 24h quote volume fallback using 1h klines
        let stats24h: any = m.categories?.stats24h || m.stats24h;
        try {
            if (!stats24h || stats24h.quoteVolume == null) {
                const kl1h = await client.getKlines(m.symbol, '1h', 24);
                const sumVol = kl1h.reduce((acc: number, row: any) => acc + Number(row[5] || 0), 0);
                const sumQuote = kl1h.reduce((acc: number, row: any) => acc + Number(row[5] || 0) * Number(row[4] || 0), 0);
                stats24h = { volume: sumVol, quoteVolume: sumQuote } as any;
            }
        } catch { }
        // orderbook depth 5
        let orderbook: any = undefined;
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
        } catch { }
        // ATR% from mark price klines
        let atrPct14: number | null = null;
        try {
            const kl = await client.getMarkPriceKlines(m.symbol, interval, limit).catch(async () => await client.getKlines(m.symbol, interval, limit));
            const tech = computeTechnicalsFromKlines(kl as any);
            const lastClose = kl[kl.length - 1]?.[4];
            const atr = (tech as any)?.volatility?.atr;
            if (typeof atr === 'number' && typeof lastClose === 'number' && lastClose > 0) atrPct14 = (atr / lastClose) * 100;
        } catch { }
        // funding mean/variance
        let fundingMean: number | null = null;
        let fundingVariance: number | null = null;
        try {
            const fr = await client.getFundingRate(m.symbol, 50);
            const vals = Array.isArray(fr) ? fr.map((x: any) => Number(x.fundingRate)).filter((n: any) => Number.isFinite(n)) : [];
            if (vals.length) {
                const mean = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
                const variance = vals.reduce((a: number, b: number) => a + (b - mean) * (b - mean), 0) / vals.length;
                fundingMean = mean; fundingVariance = variance;
            }
        } catch { }

        const qVolNum = stats24h ? Number(stats24h.quoteVolume) : 0;
        const notionalDepth = (orderbook?.notionalBid5 ?? 0) + (orderbook?.notionalAsk5 ?? 0);
        const liqScore = Math.log10(1 + Math.max(0, qVolNum)) + Math.log10(1 + Math.max(0, notionalDepth));

        const prevComp = m.categories?.computed || {};
        const prevCats = m.categories || {};
        const metrics = {
            ...(m.categories?.metrics || {}),
            quoteVolume: qVolNum,
            volume: stats24h ? Number(stats24h.volume) : null,
            bidDepth5: orderbook?.bidDepth5 ?? null,
            askDepth5: orderbook?.askDepth5 ?? null,
            notionalBid5: orderbook?.notionalBid5 ?? null,
            notionalAsk5: orderbook?.notionalAsk5 ?? null,
            atrPct14,
            fundingMean,
            fundingVariance,
            liquidityScore: Number.isFinite(liqScore) ? liqScore : null
        };
        const updated = { ...m, categories: { ...prevCats, computed: { ...prevComp }, metrics } };
        out[idx] = updated;
        if (Number.isFinite(liqScore)) liqScores.push({ idx, score: liqScore });
    }

    await Promise.all(Array.from({ length: conc }).map(async () => {
        while (i < markets.length) {
            const cur = i++;
            await processOne(cur);
        }
    }));

    if (liqScores.length > 0) {
        const sorted = [...liqScores].sort((a, b) => b.score - a.score);
        const n = sorted.length;
        const cutT1 = Math.ceil(n * 0.2);
        const cutT2 = Math.ceil(n * 0.6);
        for (let k = 0; k < sorted.length; k++) {
            const e = sorted[k];
            if (!e) continue;
            const tier = k < cutT1 ? 'T1' : k < cutT2 ? 'T2' : 'T3';
            const mm = out[e.idx];
            if (!mm.categories) mm.categories = {};
            if (!mm.categories.computed) mm.categories.computed = {};
            mm.categories.computed.liquidityTier = tier;
        }
    }

    // Drop non-crypto (e.g., equities/ETFs) before writing
    const filtered = out.filter((m) => {
        const sector = m?.categories?.sector;
        return sector !== 'Equity' && sector !== 'ETF';
    });
    const result = { ...data, markets: filtered, bucketsAsOf: Date.now() } as any;
    try {
        const { getDb } = await import('../db/sqlite.js');
        const { SqliteRepo } = await import('../services/sqliteRepo.js');
        const repo = new SqliteRepo(await getDb());
        repo.insertMarketsSnapshot(result.bucketsAsOf, result);
    } catch {}
}


