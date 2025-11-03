import { promises as fs } from 'fs';
import { computeBuckets, type ComputedBuckets } from '../lib/computeBuckets.js';

export type MarketMeta = {
    symbol: string;
    baseAsset?: string;
    quoteAsset?: string;
    pricePrecision?: number;
    quantityPrecision?: number;
    tickSize?: number;
    stepSize?: number;
    lastPrice?: number;
    maxLeverage?: number;
    categories?: any;
};

export class MarketMetaService {
    private bySymbol = new Map<string, MarketMeta>();
    private computed = new Map<string, ComputedBuckets>();
    private lastComputedAt = 0;

    async load(filePath = 'sim_data/markets.json'): Promise<void> {
        const raw = await fs.readFile(filePath, 'utf8');
        const json = JSON.parse(raw) as { markets: MarketMeta[] };
        this.bySymbol = new Map(json.markets.map(m => [m.symbol, m]));
    }

    get(symbol: string): MarketMeta | undefined {
        return this.bySymbol.get(symbol);
    }

    getComputed(symbol: string, opts?: { force?: boolean; majors?: string[] }): ComputedBuckets | undefined {
        const now = Date.now();
        if (!opts?.force && now - this.lastComputedAt < 60_000 && this.computed.has(symbol)) {
            return this.computed.get(symbol);
        }
        const m = this.bySymbol.get(symbol);
        if (!m) return undefined;
        // pull available hints from stored market snapshot if present
        const stats24h = (m as any).stats24h as any | undefined;
        const orderbook = (m as any).orderbook as any | undefined;
        const atrPct14 = (m as any).atrPct14 as number | undefined;
        const funding = (m as any).funding as any | undefined;
        const buckets = computeBuckets({
            symbol: m.symbol,
            baseAsset: m.baseAsset,
            stats24h,
            orderbook,
            atrPct14,
            funding,
            majors: opts?.majors
        });
        this.computed.set(symbol, buckets);
        this.lastComputedAt = now;
        return buckets;
    }
}

