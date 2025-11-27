/**
 * PAIR DISCOVERY SCANNER
 * 
 * Automatically discovers quality pair trading candidates from Hyperliquid universe.
 * 
 * Features:
 * - Fetches full Hyperliquid perpetuals universe
 * - Categorizes assets by sector (L1, L2, Meme, AI, DeFi, etc.)
 * - Enriches with market data (volume, OI, funding, price change)
 * - Generates all intra-sector pair combinations
 * - Filters by statistical quality (correlation, cointegration, half-life)
 * - Outputs ranked watchlist for the scanner
 * 
 * Usage: pnpm discover:pairs
 * 
 * Environment variables:
 * - MIN_VOLUME_24H: Minimum 24h volume in USD (default: 1000000)
 * - MIN_CORRELATION: Minimum correlation threshold (default: 0.5)
 * - MAX_HALF_LIFE: Maximum half-life in days (default: 45)
 * - DISCOVERY_LIMIT: Max pairs to output (default: 20)
 */

import 'dotenv/config';
import { promises as fs } from 'fs';
import createDebug from 'debug';
import {
    logPrices,
    logReturns,
    pearson,
    olsRegression,
    adfTest,
    alignSeries,
    ensureMinimumDataRequirements
} from '../lib/stats.js';

const log = createDebug('agent:discover-pairs');

// ═══════════════════════════════════════════════════════════════
// SECTOR DEFINITIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Asset sector categorization.
 * Assets not in any category will be placed in 'other'.
 * 
 * IMPORTANT: These must match EXACT Hyperliquid asset names (without -PERP suffix)
 * Reference: hyperliquid_assets.json
 * 
 * Last updated: 2025-11-27
 */
const SECTOR_DEFINITIONS: Record<string, string[]> = {
    // ═══════════════════════════════════════════════════════════════
    // LAYER 1 BLOCKCHAINS
    // ═══════════════════════════════════════════════════════════════
    // Last updated: 2025-11-27 (184 active assets on Hyperliquid)

    // Major Layer 1s (highest liquidity)
    layer1_major: ['BTC', 'ETH', 'SOL', 'AVAX', 'BNB'],

    // Alt Layer 1s
    layer1_alt: [
        'SUI', 'APT', 'NEAR', 'ATOM', 'DOT', 'ADA', 'XRP', 'TRX', 'TON',
        'SEI', 'INJ', 'TIA', 'HBAR', 'ALGO', 'ICP', 'XLM', 'CELO',
        'IOTA', 'NEO', 'ETC', 'BCH', 'LTC', 'MINA', 'BERA', 'S', 'MOVE', 'CFX'
    ],

    // ═══════════════════════════════════════════════════════════════
    // LAYER 2 / SCALING
    // ═══════════════════════════════════════════════════════════════
    layer2: [
        'ARB', 'OP', 'POL', 'STRK', 'MANTA', 'IMX', 'ZK',
        'BLAST', 'LINEA', 'MNT', 'ZETA'
    ],

    // ═══════════════════════════════════════════════════════════════
    // MEME COINS
    // ═══════════════════════════════════════════════════════════════
    meme: [
        // Classic memes
        'DOGE', 'kSHIB', 'kPEPE', 'kFLOKI', 'MEME',
        // Solana memes
        'WIF', 'kBONK', 'POPCAT', 'MEW', 'BOME',
        // New memes (2024-2025)
        'TRUMP', 'MELANIA', 'BRETT', 'GOAT', 'PNUT', 'FARTCOIN',
        'CHILLGUY', 'MOODENG', 'TURBO', 'PENGU', 'kNEIRO',
        // Political / Viral
        'PEOPLE', 'SPX', 'VINE', 'TST', 'BABY', 'DOOD', 'PUMP', 'BANANA'
    ],

    // ═══════════════════════════════════════════════════════════════
    // AI / MACHINE LEARNING
    // ═══════════════════════════════════════════════════════════════
    ai: [
        'FET', 'RENDER', 'TAO', 'WLD',
        // AI Agents
        'AIXBT', 'ZEREBRO', 'GRIFFAIN', 'VIRTUAL',
        // Infrastructure
        'GRASS', 'IO'
    ],

    // ═══════════════════════════════════════════════════════════════
    // DEFI PROTOCOLS
    // ═══════════════════════════════════════════════════════════════
    defi: [
        // Blue chip DeFi
        'UNI', 'AAVE', 'LINK', 'CRV', 'SNX', 'COMP', 'SUSHI',
        // Derivatives & Perps
        'DYDX', 'GMX', 'PENDLE',
        // Liquid Staking
        'LDO', 'ETHFI',
        // Other DeFi
        'FXS', 'JTO', 'JUP', 'PYTH', 'ONDO', 'MORPHO', 'USUAL',
        'ENA', 'CAKE', 'RSR', 'MAV', 'EIGEN', 'REZ', 'AERO', 'SYRUP'
    ],

    // ═══════════════════════════════════════════════════════════════
    // GAMING / METAVERSE
    // ═══════════════════════════════════════════════════════════════
    gaming: [
        'SAND', 'GALA', 'IMX', 'XAI',
        'BIGTIME', 'SUPER', 'YGG', 'MAVIA', 'NXPC', 'ANIME', 'GMT'
    ],

    // ═══════════════════════════════════════════════════════════════
    // DEPIN (Decentralized Physical Infrastructure)
    // ═══════════════════════════════════════════════════════════════
    depin: ['FIL', 'AR', 'RENDER', 'IO', 'GRASS'],

    // ═══════════════════════════════════════════════════════════════
    // HYPERLIQUID ECOSYSTEM
    // ═══════════════════════════════════════════════════════════════
    hl_ecosystem: ['HYPE', 'ASTER', 'MON', 'XPL', 'PURR', 'HYPER'],

    // ═══════════════════════════════════════════════════════════════
    // NEW LAUNCHES / HOT TOKENS (2025)
    // ═══════════════════════════════════════════════════════════════
    new_launches: [
        'KAITO', 'NIL', 'PROMPT', 'WCT', 'ZORA', 'INIT',
        'SOPH', 'RESOLV', 'PROVE', 'YZY', 'WLFI', 'SKY', 'AVNT',
        'STBL', '0G', 'HEMI', 'APEX', '2Z', 'MET', 'MEGA', 'CC', 'BIO',
        'VVV', 'LAYER', 'IP', 'OM'
    ],

    // ═══════════════════════════════════════════════════════════════
    // PRIVACY COINS
    // ═══════════════════════════════════════════════════════════════
    privacy: ['ZEC', 'ZEN'],

    // ═══════════════════════════════════════════════════════════════
    // NFT / SOCIAL
    // ═══════════════════════════════════════════════════════════════
    nft_social: ['APE', 'BLUR', 'ENS'],

    // ═══════════════════════════════════════════════════════════════
    // CROSS-CHAIN / BRIDGES
    // ═══════════════════════════════════════════════════════════════
    crosschain: ['W', 'ZRO', 'SAGA', 'DYM', 'ALT'],

    // ═══════════════════════════════════════════════════════════════
    // BITCOIN ECOSYSTEM (Ordinals, BRC-20)
    // ═══════════════════════════════════════════════════════════════
    btc_ecosystem: ['ORDI', 'STX', 'RUNE', 'KAS', 'MERL'],

    // ═══════════════════════════════════════════════════════════════
    // ORACLE / DATA
    // ═══════════════════════════════════════════════════════════════
    oracle: ['TRB'],

    // ═══════════════════════════════════════════════════════════════
    // LEGACY / LOW LIQUIDITY (excluded from pairing)
    // ═══════════════════════════════════════════════════════════════
    legacy: [
        'ARK', 'BSV', 'POLYX', 'GAS', 'FTT',
        'USTC', 'kLUNC', 'ACE', 'UMA',
        'TNSR', 'NOT', 'HMSTR', 'SCR', 'ME', 'PAXG'
    ],
};

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

interface DiscoveryConfig {
    // Minimum filters
    minVolume24h: number;      // Min 24h volume in USD
    minOpenInterest: number;   // Min OI in USD
    minDataDays: number;       // Min days of data required

    // Quality thresholds
    minCorrelation: number;    // Min correlation for pair
    maxHalfLife: number;       // Max half-life in days

    // Statistical windows
    correlationDays: number;
    cointegrationDays: number;

    // Output
    maxPairsPerSector: number;
    totalMaxPairs: number;

    // Cross-sector pairing
    allowCrossSector: boolean;
    crossSectorMinCorr: number;  // Higher threshold for cross-sector
}

const DEFAULT_CONFIG: DiscoveryConfig = {
    minVolume24h: Number(process.env.MIN_VOLUME_24H || '500000'),
    minOpenInterest: Number(process.env.MIN_OI || '100000'),
    minDataDays: 30,

    minCorrelation: Number(process.env.MIN_CORRELATION || '0.5'),
    maxHalfLife: Number(process.env.MAX_HALF_LIFE || '45'),

    correlationDays: 30,
    cointegrationDays: 90,

    maxPairsPerSector: 5,
    totalMaxPairs: Number(process.env.DISCOVERY_LIMIT || '25'),

    allowCrossSector: process.env.ALLOW_CROSS_SECTOR === 'true',
    crossSectorMinCorr: 0.7,
};

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface AssetInfo {
    name: string;
    sector: string;
    maxLeverage: number;
    szDecimals: number;
    isDelisted: boolean;
    onlyIsolated: boolean;
}

interface AssetContext {
    name: string;
    markPx: number;
    midPx: number;
    oraclePx: number;
    fundingRate: number;
    openInterest: number;
    dayNtlVlm: number;
    premium: number;
    prevDayPx: number;
    priceChange24h: number;
}

interface EnrichedAsset extends AssetInfo, AssetContext {
    fundingAvg24h?: number;
    predictedFunding?: number;
    qualityScore: number;
}

interface PairCandidate {
    pair: [string, string];
    sector: string;
    correlation: number;
    isCointegrated: boolean;
    halfLifeDays: number | null;
    hedgeRatio: number;
    rSquared: number;
    combinedVolume: number;
    combinedOI: number;
    fundingDelta: number;
    qualityScore: number;
}

interface DiscoveryResult {
    timestamp: string;
    config: DiscoveryConfig;
    universeStats: {
        totalAssets: number;
        eligibleAssets: number;
        sectorBreakdown: Record<string, number>;
    };
    topPairs: PairCandidate[];
    pairsBySector: Record<string, PairCandidate[]>;
    watchlist: [string, string][];
}

// ═══════════════════════════════════════════════════════════════
// HYPERLIQUID API HELPERS
// ═══════════════════════════════════════════════════════════════

async function hlInfoRequest<T>(payload: any, retries = 3): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch('https://api.hyperliquid.xyz/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (response.status === 429) {
                // Rate limited - wait and retry
                const waitTime = Math.pow(2, attempt) * 5000; // 5s, 10s, 20s, 40s
                console.log(`⏳ Rate limited, waiting ${waitTime / 1000}s before retry...`);
                await new Promise(r => setTimeout(r, waitTime));
                continue;
            }

            if (!response.ok) {
                throw new Error(`Hyperliquid API error: ${response.status}`);
            }

            return response.json() as Promise<T>;
        } catch (error) {
            if (attempt === retries) throw error;
            const waitTime = Math.pow(2, attempt) * 5000;
            console.log(`⏳ Request failed, waiting ${waitTime / 1000}s before retry...`);
            await new Promise(r => setTimeout(r, waitTime));
        }
    }
    throw new Error('Max retries exceeded');
}

async function fetchMetaAndContexts(): Promise<{ universe: any[]; contexts: any[] }> {
    const data = await hlInfoRequest<[{ universe: any[] }, any[]]>({
        type: 'metaAndAssetCtxs'
    });

    return {
        universe: data[0].universe,
        contexts: data[1]
    };
}

async function fetchPredictedFundings(): Promise<Map<string, number>> {
    try {
        const data = await hlInfoRequest<Array<[string, Array<[string, { fundingRate: string }]>]>>({
            type: 'predictedFundings'
        });

        const fundingMap = new Map<string, number>();
        for (const [coin, venues] of data) {
            const hlVenue = venues.find(v => v[0] === 'HlPerp');
            if (hlVenue && hlVenue[1]) {
                fundingMap.set(coin, parseFloat(hlVenue[1].fundingRate));
            }
        }
        return fundingMap;
    } catch (error) {
        log('Failed to fetch predicted fundings: %O', error);
        return new Map();
    }
}

// ═══════════════════════════════════════════════════════════════
// ASSET PROCESSING
// ═══════════════════════════════════════════════════════════════

function getSectorForAsset(assetName: string): string {
    for (const [sector, assets] of Object.entries(SECTOR_DEFINITIONS)) {
        if (assets.includes(assetName.toUpperCase())) {
            return sector;
        }
    }
    return 'other';
}

function processAssets(
    universe: any[],
    contexts: any[],
    predictedFundings: Map<string, number>
): EnrichedAsset[] {
    const assets: EnrichedAsset[] = [];

    for (let i = 0; i < universe.length; i++) {
        const meta = universe[i];
        const ctx = contexts[i];

        if (!meta || !ctx) continue;

        const name = meta.name;
        const isDelisted = meta.isDelisted === true;
        const onlyIsolated = meta.onlyIsolated === true;

        // Skip delisted assets
        if (isDelisted) continue;

        const markPx = parseFloat(ctx.markPx) || 0;
        const prevDayPx = parseFloat(ctx.prevDayPx) || markPx;
        const priceChange24h = prevDayPx > 0 ? ((markPx - prevDayPx) / prevDayPx) * 100 : 0;

        const dayNtlVlm = parseFloat(ctx.dayNtlVlm) || 0;
        const openInterest = parseFloat(ctx.openInterest) || 0;
        const fundingRate = parseFloat(ctx.funding) || 0;

        // Quality score based on liquidity and stability
        const qualityScore = calculateAssetQualityScore(dayNtlVlm, openInterest, meta.maxLeverage);

        assets.push({
            name,
            sector: getSectorForAsset(name),
            maxLeverage: meta.maxLeverage || 1,
            szDecimals: meta.szDecimals || 0,
            isDelisted,
            onlyIsolated,
            markPx,
            midPx: parseFloat(ctx.midPx) || markPx,
            oraclePx: parseFloat(ctx.oraclePx) || markPx,
            fundingRate,
            openInterest: openInterest * markPx, // Convert to USD
            dayNtlVlm,
            premium: parseFloat(ctx.premium) || 0,
            prevDayPx,
            priceChange24h,
            predictedFunding: predictedFundings.get(name),
            qualityScore
        });
    }

    return assets;
}

function calculateAssetQualityScore(volume: number, oi: number, maxLeverage: number): number {
    // Normalize components (log scale for volume/OI)
    const volumeScore = Math.min(1, Math.log10(Math.max(1, volume)) / 9); // Max at $1B
    const oiScore = Math.min(1, Math.log10(Math.max(1, oi)) / 8); // Max at $100M
    const leverageScore = Math.min(1, maxLeverage / 50); // Prefer high leverage (liquid)

    return (volumeScore * 0.4) + (oiScore * 0.4) + (leverageScore * 0.2);
}

// ═══════════════════════════════════════════════════════════════
// PAIR ANALYSIS
// ═══════════════════════════════════════════════════════════════

function getBarsPerDay(interval: string): number {
    const m = interval.match(/^(\d+)([mhd])$/i);
    if (!m) return 24;
    const n = Number(m[1] || '1');
    const unit = m[2]?.toLowerCase();
    switch (unit) {
        case 'm': return (24 * 60) / n;
        case 'h': return 24 / n;
        case 'd': return 1 / n;
        default: return 24;
    }
}

/**
 * Fetch candles directly via API (bypasses SDK rate limit issues)
 */
async function fetchCandlesDirect(
    coin: string,
    interval: string,
    startTime: number,
    endTime: number
): Promise<Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>> {
    const data = await hlInfoRequest<any[]>({
        type: 'candleSnapshot',
        req: { coin, interval, startTime, endTime }
    });
    return data || [];
}

async function analyzePair(
    asset1: EnrichedAsset,
    asset2: EnrichedAsset,
    config: DiscoveryConfig
): Promise<PairCandidate | null> {
    try {
        const interval = '1h';
        const barsPerDay = getBarsPerDay(interval);
        const requiredCandles = Math.ceil(config.cointegrationDays * barsPerDay) + 50;

        // Calculate time range
        const endTime = Date.now();
        const startTime = endTime - (requiredCandles * 60 * 60 * 1000); // 1h candles

        // Fetch candles sequentially to avoid rate limits
        const candles1 = await fetchCandlesDirect(asset1.name, interval, startTime, endTime);
        await new Promise(r => setTimeout(r, 500)); // Small delay between requests
        const candles2 = await fetchCandlesDirect(asset2.name, interval, startTime, endTime);

        if (candles1.length < config.minDataDays * barsPerDay ||
            candles2.length < config.minDataDays * barsPerDay) {
            return null;
        }

        // Parse candles - direct API returns { t, o, h, l, c, v }
        const prices1 = candles1.map(c => Number(c.c)).filter(n => Number.isFinite(n) && n > 0);
        const prices2 = candles2.map(c => Number(c.c)).filter(n => Number.isFinite(n) && n > 0);

        const dataCheck = ensureMinimumDataRequirements(prices1, prices2);
        if (!dataCheck.isValid) return null;

        const { alignedA: alignedPrices1, alignedB: alignedPrices2 } = alignSeries(prices1, prices2);

        // Correlation (30-day)
        const corrBars = Math.floor(config.correlationDays * barsPerDay);
        const corrPrices1 = alignedPrices1.slice(-Math.min(alignedPrices1.length, corrBars));
        const corrPrices2 = alignedPrices2.slice(-Math.min(alignedPrices2.length, corrBars));
        const returns1 = logReturns(corrPrices1);
        const returns2 = logReturns(corrPrices2);
        const correlation = pearson(returns1, returns2) ?? 0;

        if (correlation < config.minCorrelation) {
            return null;
        }

        // Cointegration (90-day)
        const logPrices1 = logPrices(alignedPrices1);
        const logPrices2 = logPrices(alignedPrices2);
        const cointegBars = Math.floor(config.cointegrationDays * barsPerDay);
        const cointegLog1 = logPrices1.slice(-Math.min(logPrices1.length, cointegBars));
        const cointegLog2 = logPrices2.slice(-Math.min(logPrices2.length, cointegBars));

        const olsResult = olsRegression(cointegLog1, cointegLog2);
        if (!olsResult || !Number.isFinite(olsResult.slope)) return null;

        const hedgeRatio = olsResult.slope;
        const rSquared = olsResult.rSquared;

        // Calculate spread for ADF test
        const spread: number[] = [];
        const minLen = Math.min(cointegLog1.length, cointegLog2.length);
        for (let i = 0; i < minLen; i++) {
            const s = cointegLog1[i]! - hedgeRatio * cointegLog2[i]!;
            if (Number.isFinite(s)) spread.push(s);
        }

        const adfResult = adfTest(spread);
        const isCointegrated = adfResult?.isStationary ?? false;
        const halfLife = adfResult?.halfLife ?? null;

        // Filter by half-life
        if (halfLife !== null && halfLife > config.maxHalfLife) {
            return null;
        }

        // Calculate quality score for the pair
        const combinedVolume = asset1.dayNtlVlm + asset2.dayNtlVlm;
        const combinedOI = asset1.openInterest + asset2.openInterest;
        const fundingDelta = Math.abs(asset1.fundingRate - asset2.fundingRate);

        const qualityScore = calculatePairQualityScore(
            correlation,
            isCointegrated,
            halfLife,
            rSquared,
            combinedVolume,
            combinedOI
        );

        return {
            pair: [asset1.name, asset2.name],
            sector: asset1.sector === asset2.sector ? asset1.sector : `${asset1.sector}+${asset2.sector}`,
            correlation,
            isCointegrated,
            halfLifeDays: halfLife,
            hedgeRatio,
            rSquared,
            combinedVolume,
            combinedOI,
            fundingDelta,
            qualityScore
        };

    } catch (error) {
        log('Error analyzing pair %s/%s: %O', asset1.name, asset2.name, error);
        return null;
    }
}

function calculatePairQualityScore(
    correlation: number,
    isCointegrated: boolean,
    halfLife: number | null,
    rSquared: number,
    volume: number,
    oi: number
): number {
    // Correlation component (0-1)
    const corrScore = Math.min(1, Math.max(0, correlation));

    // Cointegration bonus
    const cointegScore = isCointegrated ? 1 : 0.3;

    // Half-life score (prefer shorter, but not too short)
    let halfLifeScore = 0.5;
    if (halfLife !== null) {
        if (halfLife >= 5 && halfLife <= 20) {
            halfLifeScore = 1; // Ideal range
        } else if (halfLife < 5) {
            halfLifeScore = 0.6; // Too fast, might be noise
        } else if (halfLife <= 45) {
            halfLifeScore = 0.8; // Acceptable
        } else {
            halfLifeScore = 0.3; // Too slow
        }
    }

    // R² score
    const r2Score = Math.min(1, rSquared);

    // Liquidity score (log scale)
    const volumeScore = Math.min(1, Math.log10(Math.max(1, volume)) / 9);
    const oiScore = Math.min(1, Math.log10(Math.max(1, oi)) / 8);
    const liquidityScore = (volumeScore + oiScore) / 2;

    // Weighted combination
    return (
        corrScore * 0.25 +
        cointegScore * 0.25 +
        halfLifeScore * 0.20 +
        r2Score * 0.15 +
        liquidityScore * 0.15
    );
}

// ═══════════════════════════════════════════════════════════════
// MAIN DISCOVERY LOGIC
// ═══════════════════════════════════════════════════════════════

async function discoverPairs(config: DiscoveryConfig): Promise<DiscoveryResult> {
    console.log('📡 Fetching Hyperliquid universe...');

    // Fetch data sequentially to avoid rate limit on startup
    const metaAndCtx = await fetchMetaAndContexts();
    await new Promise(r => setTimeout(r, 2000)); // Wait 2s between requests
    const predictedFundings = await fetchPredictedFundings();

    console.log(`   Found ${metaAndCtx.universe.length} perpetual assets`);

    // Process and enrich assets
    const allAssets = processAssets(metaAndCtx.universe, metaAndCtx.contexts, predictedFundings);

    // Filter by minimum requirements
    const eligibleAssets = allAssets.filter(a =>
        a.dayNtlVlm >= config.minVolume24h &&
        a.openInterest >= config.minOpenInterest &&
        !a.onlyIsolated &&
        a.sector !== 'legacy'  // Exclude legacy/low-liquidity assets
    );

    console.log(`   ${eligibleAssets.length} assets meet liquidity requirements`);

    // Group by sector
    const sectorGroups = new Map<string, EnrichedAsset[]>();
    for (const asset of eligibleAssets) {
        const group = sectorGroups.get(asset.sector) || [];
        group.push(asset);
        sectorGroups.set(asset.sector, group);
    }

    // Print sector breakdown
    const sectorBreakdown: Record<string, number> = {};
    console.log('\n📊 Sector breakdown:');
    for (const [sector, assets] of sectorGroups) {
        sectorBreakdown[sector] = assets.length;
        if (assets.length >= 2) {
            console.log(`   ${sector}: ${assets.length} assets (${assets.map(a => a.name).slice(0, 5).join(', ')}${assets.length > 5 ? '...' : ''})`);
        }
    }

    // Generate and analyze pairs
    console.log('\n🔍 Analyzing pair candidates...');

    const allPairs: PairCandidate[] = [];
    const pairsBySector: Record<string, PairCandidate[]> = {};

    // Count total pairs to analyze
    let totalPairs = 0;
    for (const [, assets] of sectorGroups) {
        if (assets.length >= 2) {
            totalPairs += (assets.length * (assets.length - 1)) / 2;
        }
    }
    console.log(`   Total pair combinations to analyze: ${totalPairs}`);
    console.log(`   Estimated time: ~${Math.ceil(totalPairs * 6 / 60)} minutes (rate limited)\n`);

    let pairCount = 0;

    // Intra-sector pairs
    for (const [sector, assets] of sectorGroups) {
        if (assets.length < 2) continue;

        const sectorPairs: PairCandidate[] = [];
        console.log(`\n📂 Analyzing ${sector} (${assets.length} assets)...`);

        // Generate all combinations within sector
        for (let i = 0; i < assets.length; i++) {
            for (let j = i + 1; j < assets.length; j++) {
                const asset1 = assets[i]!;
                const asset2 = assets[j]!;
                pairCount++;

                const progress = `[${pairCount}/${totalPairs}]`;
                log('%s Analyzing %s/%s (%s)', progress, asset1.name, asset2.name, sector);
                process.stdout.write(`\r   ${progress} ${asset1.name}/${asset2.name}...`);

                const pair = await analyzePair(asset1, asset2, config);
                if (pair) {
                    sectorPairs.push(pair);
                    allPairs.push(pair);
                    process.stdout.write(` ✅ corr=${pair.correlation.toFixed(2)}`);
                } else {
                    process.stdout.write(` ❌`);
                }

                // Rate limiting: candleSnapshot = 20 + (candles/60) weight
                // For 2160 candles (90 days), weight = 20 + 36 = 56 per request
                // 2 requests per pair = 112 weight
                // 1200 weight/min limit → ~10 pairs/min → 6 seconds between pairs
                await new Promise(r => setTimeout(r, 6000));
            }
        }

        // Sort by quality and take top N per sector
        sectorPairs.sort((a, b) => b.qualityScore - a.qualityScore);
        pairsBySector[sector] = sectorPairs.slice(0, config.maxPairsPerSector);

        console.log(`\n   ✓ ${sector}: ${sectorPairs.length} valid pairs found`);
    }

    // Cross-sector pairs (optional)
    if (config.allowCrossSector) {
        console.log('\n🌐 Analyzing cross-sector pairs...');

        // Only pair major assets across sectors
        const majorAssets = eligibleAssets
            .filter(a => a.qualityScore > 0.6)
            .slice(0, 20);

        for (let i = 0; i < majorAssets.length; i++) {
            for (let j = i + 1; j < majorAssets.length; j++) {
                const asset1 = majorAssets[i]!;
                const asset2 = majorAssets[j]!;

                // Skip same sector (already done)
                if (asset1.sector === asset2.sector) continue;

                const pair = await analyzePair(asset1, asset2, {
                    ...config,
                    minCorrelation: config.crossSectorMinCorr
                });

                if (pair) {
                    allPairs.push(pair);
                }

                // Same rate limiting as intra-sector
                await new Promise(r => setTimeout(r, 6000));
            }
        }
    }

    // Sort all pairs by quality
    allPairs.sort((a, b) => b.qualityScore - a.qualityScore);
    const topPairs = allPairs.slice(0, config.totalMaxPairs);

    // Generate watchlist
    const watchlist: [string, string][] = topPairs.map(p => p.pair);

    return {
        timestamp: new Date().toISOString(),
        config,
        universeStats: {
            totalAssets: allAssets.length,
            eligibleAssets: eligibleAssets.length,
            sectorBreakdown
        },
        topPairs,
        pairsBySector,
        watchlist
    };
}

// ═══════════════════════════════════════════════════════════════
// OUTPUT FORMATTING
// ═══════════════════════════════════════════════════════════════

function formatDiscoveryResults(result: DiscoveryResult): string {
    const lines: string[] = [
        '═══════════════════════════════════════════════════════════════',
        '                    PAIR DISCOVERY RESULTS',
        `                    ${result.timestamp}`,
        '═══════════════════════════════════════════════════════════════',
        '',
        `Universe: ${result.universeStats.totalAssets} total → ${result.universeStats.eligibleAssets} eligible`,
        '',
        'TOP PAIRS BY QUALITY SCORE:',
        '─────────────────────────────────────────────────────────────────',
        'Rank | Pair           | Sector       | Corr  | Coint | HL(d) | Score',
        '─────────────────────────────────────────────────────────────────'
    ];

    result.topPairs.forEach((p, i) => {
        const rank = String(i + 1).padStart(4);
        const pair = `${p.pair[0]}/${p.pair[1]}`.padEnd(14);
        const sector = p.sector.slice(0, 12).padEnd(12);
        const corr = p.correlation.toFixed(2).padStart(5);
        const coint = p.isCointegrated ? '  ✅  ' : '  ❌  ';
        const hl = p.halfLifeDays ? `${p.halfLifeDays.toFixed(0)}`.padStart(5) : '  N/A';
        const score = p.qualityScore.toFixed(2).padStart(5);

        lines.push(`${rank} | ${pair} | ${sector} | ${corr} | ${coint} | ${hl} | ${score}`);
    });

    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('');
    lines.push('WATCHLIST FOR SCANNER:');
    lines.push('─────────────────────────────────────────────────────────────────');

    // Format as environment variable
    const watchlistEnv = result.watchlist.map(([a, b]) => `${a}:${b}`).join(',');
    lines.push(`SCAN_WATCHLIST="${watchlistEnv}"`);

    lines.push('');
    lines.push('WATCHLIST ARRAY (for code):');
    lines.push('─────────────────────────────────────────────────────────────────');
    lines.push('[');
    result.watchlist.forEach(([a, b]) => {
        lines.push(`    ['${a}', '${b}'],`);
    });
    lines.push(']');

    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log('🔬 Pair Discovery Scanner starting...\n');
    console.log('Configuration:');
    console.log(`   Min Volume 24h: $${DEFAULT_CONFIG.minVolume24h.toLocaleString()}`);
    console.log(`   Min Open Interest: $${DEFAULT_CONFIG.minOpenInterest.toLocaleString()}`);
    console.log(`   Min Correlation: ${DEFAULT_CONFIG.minCorrelation}`);
    console.log(`   Max Half-Life: ${DEFAULT_CONFIG.maxHalfLife} days`);
    console.log(`   Cross-Sector Pairing: ${DEFAULT_CONFIG.allowCrossSector ? 'Enabled' : 'Disabled'}`);
    console.log('');

    try {
        const result = await discoverPairs(DEFAULT_CONFIG);

        // Print formatted results
        const output = formatDiscoveryResults(result);
        console.log('\n' + output);

        // Save results
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `sim_data/discovery-${timestamp}.json`;
        await fs.writeFile(filename, JSON.stringify(result, null, 2));
        console.log(`\n📁 Full results saved to: ${filename}`);

        // Save watchlist separately
        const watchlistFile = 'sim_data/watchlist.json';
        await fs.writeFile(watchlistFile, JSON.stringify({
            generatedAt: result.timestamp,
            watchlist: result.watchlist,
            topPairs: result.topPairs.slice(0, 15)
        }, null, 2));
        console.log(`📋 Watchlist saved to: ${watchlistFile}`);

    } catch (error) {
        console.error('❌ Discovery error:', error);
        process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});

