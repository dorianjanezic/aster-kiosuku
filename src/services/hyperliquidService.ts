/**
 * HYPERLIQUID SERVICE
 * 
 * Provides market data from Hyperliquid API for pairs trading analysis.
 * Uses the Hyperliquid SDK for candlestick data, market info, and asset metadata.
 * 
 * Key features:
 * - Candlestick data fetching with rate limiting
 * - Asset metadata caching
 * - Retry logic with exponential backoff
 */

import { promises as fs } from 'fs';
import path from 'path';
import createDebug from 'debug';

const log = createDebug('agent:hyperliquid');

// Type declarations for hyperliquid SDK (no official types)
interface HyperliquidSDK {
    connect(): Promise<void>;
    disconnect(): void;
    info: {
        perpetuals: {
            getMeta(): Promise<{ universe: Array<{ name: string }> }>;
            getMetaAndAssetCtxs(): Promise<[{ universe: Array<{ name: string }> }, any[]]>;
        };
        getCandleSnapshot(coin: string, interval: string, startTime: number, endTime: number): Promise<any[]>;
        getAllMids(): Promise<Record<string, string>>;
    };
}

export interface Candlestick {
    time: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
}

export interface MarketDataContext {
    dayNtlVlm: string;
    fundingRate: string;
    markPx: string;
    midPx: string;
    openInterest: string;
    oraclePx: string;
    premium: string;
}

const ASSET_CACHE_PATH = path.resolve(process.cwd(), 'hyperliquid_assets.json');
const CACHE_STALE_TIME_MS = 24 * 60 * 60 * 1000; // 24 hours

export class HyperliquidService {
    private sdk: HyperliquidSDK | null = null;
    private assetNameMap: Map<string, string> = new Map();
    private isInitialized = false;

    constructor() {
        log('HyperliquidService created');
    }

    private async withRetry<T>(fn: () => Promise<T>, retries: number = 3, baseDelayMs: number = 1000): Promise<T> {
        let attempt = 0;
        while (true) {
            try {
                return await fn();
            } catch (err: any) {
                const code = err?.code ?? err?.statusCode;
                const isRateLimited = code === 429 || (typeof err?.message === 'string' && err.message.includes('429'));
                if (attempt < retries && isRateLimited) {
                    const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
                    log('Rate limited, retrying in %dms (attempt %d/%d)', delay, attempt + 1, retries);
                    await new Promise(r => setTimeout(r, delay));
                    attempt++;
                    continue;
                }
                throw err;
            }
        }
    }

    private async loadAssetsFromCache(): Promise<boolean> {
        try {
            await fs.access(ASSET_CACHE_PATH);
            const stats = await fs.stat(ASSET_CACHE_PATH);
            if (Date.now() - stats.mtime.getTime() > CACHE_STALE_TIME_MS) {
                log('Asset cache is stale');
                return false;
            }
            const fileContent = await fs.readFile(ASSET_CACHE_PATH, 'utf-8');
            const cachedAssets: string[] = JSON.parse(fileContent);
            this.assetNameMap.clear();
            for (const name of cachedAssets) {
                this.assetNameMap.set(name.toLowerCase(), name);
            }
            log('Loaded %d assets from cache', this.assetNameMap.size);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                log('Asset cache file not found');
            } else {
                log('Failed to load assets from cache: %O', error);
            }
            return false;
        }
    }

    private async saveAssetsToCache(): Promise<void> {
        try {
            const allAssetNames = [...this.assetNameMap.values()];
            await fs.writeFile(ASSET_CACHE_PATH, JSON.stringify(allAssetNames, null, 2));
            log('Saved %d assets to cache', allAssetNames.length);
        } catch (error) {
            log('Failed to save assets to cache: %O', error);
        }
    }

    public async initialize(): Promise<void> {
        if (this.isInitialized) return;

        try {
            // Dynamic import of hyperliquid SDK
            // @ts-ignore - hyperliquid SDK has no type declarations
            const hyperliquidModule = await import('hyperliquid');
            const Hyperliquid = (hyperliquidModule as any).Hyperliquid || (hyperliquidModule as any).default;
            this.sdk = new Hyperliquid() as HyperliquidSDK;
            await this.sdk.connect();

            if (await this.loadAssetsFromCache()) {
                this.isInitialized = true;
                return;
            }

            log('Fetching asset metadata from Hyperliquid...');
            const meta = await this.withRetry(() => this.sdk!.info.perpetuals.getMeta());
            const allAssetNames = meta.universe.map((asset: { name: string }) => asset.name);

            this.assetNameMap.clear();
            for (const name of allAssetNames) {
                this.assetNameMap.set(name.toLowerCase(), name);
            }

            log('Loaded %d assets from Hyperliquid', this.assetNameMap.size);
            await this.saveAssetsToCache();
            this.isInitialized = true;

        } catch (error) {
            log('Failed to initialize: %O', error);
            throw new Error('Could not initialize Hyperliquid service');
        }
    }

    public async disconnect(): Promise<void> {
        if (this.sdk) {
            try {
                this.sdk.disconnect();
            } catch {
                // Ignore disconnect errors
            }
            this.sdk = null;
            this.isInitialized = false;
        }
    }

    /**
     * Get candlestick data for a symbol
     * @param symbol Asset name (e.g., 'BTC', 'ETH', 'HYPE')
     * @param interval Candle interval (e.g., '1h', '4h', '1d')
     * @param limit Number of candles to fetch
     */
    public async getCandlesticks(
        symbol: string,
        interval: string = '1h',
        limit: number = 750
    ): Promise<Candlestick[]> {
        if (!this.isInitialized) {
            await this.initialize();
        }

        // Normalize symbol - Hyperliquid uses "BTC-PERP" format
        let assetName = symbol.toUpperCase();
        // Remove common suffixes
        if (assetName.endsWith('-PERP')) {
            assetName = assetName.slice(0, -5);
        } else if (assetName.endsWith('USDT')) {
            assetName = assetName.slice(0, -4);
        } else if (assetName.endsWith('USD')) {
            assetName = assetName.slice(0, -3);
        }

        // Try to find the asset - Hyperliquid stores as "BTC-PERP", "ETH-PERP", etc.
        // First try with -PERP suffix
        let properCasedName = this.assetNameMap.get(`${assetName.toLowerCase()}-perp`);

        // If not found, try without suffix
        if (!properCasedName) {
            properCasedName = this.assetNameMap.get(assetName.toLowerCase());
        }

        if (!properCasedName) {
            // Log available assets for debugging
            log('Available assets: %s', Array.from(this.assetNameMap.keys()).slice(0, 20).join(', '));
            throw new Error(`Asset "${symbol}" (normalized: "${assetName}") not found in Hyperliquid`);
        }

        // Calculate time range
        const endTime = Date.now();
        const intervalMs = this.parseIntervalToMs(interval);
        const startTime = endTime - (limit * intervalMs);

        log('Fetching %d candles for %s (%s) from %s to %s',
            limit, properCasedName, interval,
            new Date(startTime).toISOString(),
            new Date(endTime).toISOString()
        );

        const candles = await this.withRetry(() =>
            this.sdk!.info.getCandleSnapshot(properCasedName, interval, startTime, endTime)
        );

        if (!candles || candles.length === 0) {
            throw new Error(`No candlestick data for ${properCasedName}`);
        }

        return candles.map((c: any) => ({
            time: c.t,
            open: c.o,
            high: c.h,
            low: c.l,
            close: c.c,
            volume: c.v,
        }));
    }

    /**
     * Get market data context for a symbol
     */
    public async getMarketData(symbol: string): Promise<MarketDataContext | null> {
        if (!this.isInitialized) {
            await this.initialize();
        }

        let assetName = symbol.toUpperCase();
        if (assetName.endsWith('-PERP')) {
            assetName = assetName.slice(0, -5);
        } else if (assetName.endsWith('USDT')) {
            assetName = assetName.slice(0, -4);
        } else if (assetName.endsWith('USD')) {
            assetName = assetName.slice(0, -3);
        }

        // Try to find the asset - Hyperliquid stores as "BTC-PERP", "ETH-PERP", etc.
        let properCasedName = this.assetNameMap.get(`${assetName.toLowerCase()}-perp`);
        if (!properCasedName) {
            properCasedName = this.assetNameMap.get(assetName.toLowerCase());
        }
        if (!properCasedName) {
            log('Asset %s not found', symbol);
            return null;
        }

        try {
            if (!this.sdk) throw new Error('SDK not initialized');
            const sdk = this.sdk;
            const [response, allMids] = await Promise.all([
                this.withRetry(() => sdk.info.perpetuals.getMetaAndAssetCtxs()),
                this.withRetry(() => sdk.info.getAllMids())
            ]);

            const universe = response[0].universe;
            const assetCtxs = response[1];

            const assetIndex = universe.findIndex(
                (asset: { name: string }) => asset.name.toLowerCase() === properCasedName.toLowerCase()
            );

            if (assetIndex === -1) {
                return null;
            }

            const assetCtx: any = assetCtxs[assetIndex];
            const midPx = allMids[properCasedName];

            return {
                dayNtlVlm: assetCtx.dayNtlVlm,
                fundingRate: assetCtx.funding,
                markPx: assetCtx.markPx,
                midPx: midPx || assetCtx.markPx,
                openInterest: assetCtx.openInterest,
                oraclePx: assetCtx.oraclePx,
                premium: assetCtx.premium,
            };
        } catch (error) {
            log('Failed to fetch market data for %s: %O', symbol, error);
            return null;
        }
    }

    /**
     * Get all available asset names
     */
    public getAllAssetNames(): string[] {
        return Array.from(this.assetNameMap.values());
    }

    /**
     * Check if an asset is tradable
     */
    public isAssetTradable(symbol: string): boolean {
        let assetName = symbol.toUpperCase();
        if (assetName.endsWith('-PERP')) {
            assetName = assetName.slice(0, -5);
        } else if (assetName.endsWith('USDT')) {
            assetName = assetName.slice(0, -4);
        } else if (assetName.endsWith('USD')) {
            assetName = assetName.slice(0, -3);
        }
        // Check both with and without -PERP suffix
        return this.assetNameMap.has(`${assetName.toLowerCase()}-perp`) ||
            this.assetNameMap.has(assetName.toLowerCase());
    }

    private parseIntervalToMs(interval: string): number {
        const match = interval.match(/^(\d+)([mhd])$/i);
        if (!match) return 60 * 60 * 1000; // Default 1h

        const value = parseInt(match[1]!, 10);
        const unit = match[2]!.toLowerCase();

        switch (unit) {
            case 'm': return value * 60 * 1000;
            case 'h': return value * 60 * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            default: return 60 * 60 * 1000;
        }
    }
}

// Singleton instance
let _instance: HyperliquidService | null = null;

export function getHyperliquidService(): HyperliquidService {
    if (!_instance) {
        _instance = new HyperliquidService();
    }
    return _instance;
}

