/**
 * HYPERLIQUID PAIR SCANNER
 * 
 * Scans predefined pair watchlist using Hyperliquid candlestick data.
 * Computes statistical metrics and identifies trading opportunities.
 * 
 * Features:
 * - Uses Hyperliquid API for candlestick data
 * - Computes correlation, cointegration, Z-score, beta
 * - Ranks pairs by signal strength
 * - Outputs actionable alerts
 * 
 * Usage: pnpm scan:pairs:hl
 * 
 * Environment variables:
 * - PAIRS_INTERVAL: Candle interval (default: 1h)
 * - PAIRS_LIMIT: Number of candles (default: 750 = ~31 days)
 * - SCAN_WATCHLIST: Comma-separated pairs (e.g., "BTC:ETH,HYPE:ASTER")
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
import { getHyperliquidService } from '../services/hyperliquidService.js';

const log = createDebug('agent:scan-pairs');

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

interface ScanConfig {
    interval: string;
    // Multi-timeframe windows (in days)
    cointegrationDays: number;  // Long-term: for ADF test (90 days)
    zScoreDays: number;         // Medium-term: for Z-score (30 days)
    hedgeRatioDays: number;     // Short-term: for position sizing (7 days)
    correlationDays: number;    // Medium-term: for correlation (30 days)
    // Thresholds
    entryThreshold: number;
    exitThreshold: number;
    minCorrelation: number;
    maxHalfLife: number;
}

const DEFAULT_CONFIG: ScanConfig = {
    interval: process.env.PAIRS_INTERVAL || '1h',
    // Multi-timeframe windows per Pear Protocol methodology
    cointegrationDays: Number(process.env.COINTEGRATION_DAYS || '90'),
    zScoreDays: Number(process.env.ZSCORE_DAYS || '30'),
    hedgeRatioDays: Number(process.env.HEDGE_RATIO_DAYS || '7'),
    correlationDays: Number(process.env.CORRELATION_DAYS || '30'),
    // Thresholds
    entryThreshold: 2.0,
    exitThreshold: 0.5,
    minCorrelation: 0.3,
    maxHalfLife: 60,
};

// Default watchlist of pairs to scan (using Hyperliquid asset names)
const DEFAULT_WATCHLIST: [string, string][] = [
    ['BTC', 'ETH'],
    ['HYPE', 'ASTER'],
    ['HYPE', 'MON'],
    ['XPL', 'WLD'],
    ['SOL', 'ETH'],
    ['DOGE', 'kPEPE'],  // SHIB not available, use PEPE instead
    ['LINK', 'UNI'],
    ['ARB', 'OP'],
    ['AVAX', 'SOL'],
    ['NEAR', 'APT'],
    ['SUI', 'APT'],     // Added: Layer 1 pair
    ['INJ', 'ATOM'],    // Added: Cosmos ecosystem
];

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface PairScanResult {
    pair: [string, string];
    // Correlation (30-day window)
    correlation: {
        value: number;
        strength: string;
        windowDays: number;
    };
    // Cointegration (90-day window)
    cointegration: {
        isCointegrated: boolean;
        adfStatistic: number;
        pValue: number | null;
        halfLifeDays: number | null;
        windowDays: number;
    };
    // Rolling Z-Score (30-day window)
    zScore: {
        value: number;
        signal: string;
        windowDays: number;
    };
    // Hedge Ratio / Beta (7-day window for position sizing)
    hedgeRatio: {
        value: number;
        rSquared: number;
        windowDays: number;
    };
    // Spread volatility
    spreadVolatility: number;
    // RSI (14-period)
    rsi: {
        [symbol: string]: number;
    };
    // Composite quality score
    compositeScore: number;
    // Trading recommendation
    recommendation: {
        action: 'ENTER' | 'EXIT' | 'WAIT';
        direction: 'LONG' | 'SHORT';
        longSymbol: string;
        shortSymbol: string;
        signalStrength: 'Strong' | 'Moderate' | 'Weak';
    };
    // Position sizing based on 7-day hedge ratio
    positionSizing: {
        longSymbol: string;
        longPercent: number;
        shortSymbol: string;
        shortPercent: number;
        hedgeRatioUsed: number;
        windowDays: number;
    };
    // Metadata
    metadata: {
        timestamp: string;
        interval: string;
        candlesFetched: number;
    };
}

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function getCorrelationStrength(corr: number): string {
    const abs = Math.abs(corr);
    if (abs >= 0.8) return 'Very Strong';
    if (abs >= 0.6) return 'Strong';
    if (abs >= 0.4) return 'Moderate';
    if (abs >= 0.2) return 'Weak';
    return 'Very Weak';
}

function getZScoreSignal(z: number): string {
    const abs = Math.abs(z);
    if (abs >= 2.0) return 'Extreme';
    if (abs >= 1.5) return 'Strong';
    if (abs >= 1.0) return 'Moderate';
    return 'Weak';
}

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
 * Convert Hyperliquid candle format to array format for technicalindicators library
 * Hyperliquid: { t, o, h, l, c, v }
 * Expected: [timestamp, open, high, low, close, volume, ...]
 */
function convertCandlesToKlines(candles: { time: number; open: string; high: string; low: string; close: string; volume: string }[]): any[] {
    return candles.map(c => [
        c.time,                    // 0: timestamp
        Number(c.open),            // 1: open
        Number(c.high),            // 2: high
        Number(c.low),             // 3: low
        Number(c.close),           // 4: close
        Number(c.volume),          // 5: volume
        0, 0, 0, 0, 0              // 6-10: padding for compatibility
    ]);
}

/**
 * Simple RSI calculation (14-period)
 * Using Wilder's smoothing method
 */
function calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50; // Default to neutral

    const changes: number[] = [];
    for (let i = 1; i < prices.length; i++) {
        changes.push(prices[i]! - prices[i - 1]!);
    }

    // Get last 'period' changes for initial calculation
    const recentChanges = changes.slice(-period * 2); // Use more data for smoothing
    
    let avgGain = 0;
    let avgLoss = 0;

    // Initial average
    for (let i = 0; i < Math.min(period, recentChanges.length); i++) {
        const change = recentChanges[i]!;
        if (change > 0) avgGain += change;
        else avgLoss += Math.abs(change);
    }
    avgGain /= period;
    avgLoss /= period;

    // Wilder's smoothing for remaining periods
    for (let i = period; i < recentChanges.length; i++) {
        const change = recentChanges[i]!;
        if (change > 0) {
            avgGain = (avgGain * (period - 1) + change) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
        }
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// ═══════════════════════════════════════════════════════════════
// MAIN SCANNER (Multi-Timeframe)
// ═══════════════════════════════════════════════════════════════

async function scanPair(
    symbol1: string,
    symbol2: string,
    config: ScanConfig
): Promise<PairScanResult | null> {
    const hl = getHyperliquidService();
    
    try {
        log('Scanning pair: %s / %s', symbol1, symbol2);

        // Calculate required candles for longest timeframe (cointegration = 90 days)
        const barsPerDay = getBarsPerDay(config.interval);
        const requiredCandles = Math.ceil(config.cointegrationDays * barsPerDay) + 50; // Extra buffer

        // Fetch candlestick data from Hyperliquid
        const [candles1, candles2] = await Promise.all([
            hl.getCandlesticks(symbol1, config.interval, requiredCandles),
            hl.getCandlesticks(symbol2, config.interval, requiredCandles)
        ]);

        log('Fetched %d candles for %s, %d for %s', 
            candles1.length, symbol1, candles2.length, symbol2);

        // Extract close prices
        const prices1 = candles1.map(c => Number(c.close)).filter(n => Number.isFinite(n) && n > 0);
        const prices2 = candles2.map(c => Number(c.close)).filter(n => Number.isFinite(n) && n > 0);

        // Check data requirements
        const dataCheck = ensureMinimumDataRequirements(prices1, prices2);
        if (!dataCheck.isValid) {
            log('Insufficient data for %s/%s: %s', symbol1, symbol2, dataCheck.reason);
            return null;
        }

        // Align series
        const { alignedA: alignedPrices1, alignedB: alignedPrices2 } = alignSeries(prices1, prices2);

        // Log prices for all calculations
        const logPrices1 = logPrices(alignedPrices1);
        const logPrices2 = logPrices(alignedPrices2);

        // ═══════════════════════════════════════════════════════════════
        // MULTI-TIMEFRAME CALCULATIONS
        // ═══════════════════════════════════════════════════════════════

        // Calculate bar counts for each timeframe
        const cointegrationBars = Math.floor(config.cointegrationDays * barsPerDay);
        const zScoreBars = Math.floor(config.zScoreDays * barsPerDay);
        const hedgeRatioBars = Math.floor(config.hedgeRatioDays * barsPerDay);
        const correlationBars = Math.floor(config.correlationDays * barsPerDay);

        // ─────────────────────────────────────────────────────────────────
        // 1. CORRELATION (30-day window)
        // ─────────────────────────────────────────────────────────────────
        const corrPrices1 = alignedPrices1.slice(-Math.min(alignedPrices1.length, correlationBars));
        const corrPrices2 = alignedPrices2.slice(-Math.min(alignedPrices2.length, correlationBars));
        const returns1 = logReturns(corrPrices1);
        const returns2 = logReturns(corrPrices2);
        const correlation = pearson(returns1, returns2) ?? 0;

        // ─────────────────────────────────────────────────────────────────
        // 2. COINTEGRATION (90-day window)
        // ─────────────────────────────────────────────────────────────────
        const cointegLog1 = logPrices1.slice(-Math.min(logPrices1.length, cointegrationBars));
        const cointegLog2 = logPrices2.slice(-Math.min(logPrices2.length, cointegrationBars));
        
        // Calculate spread using 90-day hedge ratio for cointegration test
        const cointegOls = olsRegression(cointegLog1, cointegLog2);
        const cointegBeta = cointegOls?.slope ?? 0;
        
        const cointegSpread: number[] = [];
        const cointegLength = Math.min(cointegLog1.length, cointegLog2.length);
        for (let i = 0; i < cointegLength; i++) {
            const spreadValue = cointegLog1[i]! - cointegBeta * cointegLog2[i]!;
            if (Number.isFinite(spreadValue)) {
                cointegSpread.push(spreadValue);
            }
        }
        
        const adfResult = adfTest(cointegSpread);
        const isCointegrated = adfResult?.isStationary ?? false;
        const halfLife = adfResult?.halfLife ?? null;
        const adfStatistic = adfResult?.testStatistic ?? 0;
        const adfPValue = adfResult?.pValue ?? null;

        // ─────────────────────────────────────────────────────────────────
        // 3. HEDGE RATIO / BETA (7-day window for position sizing)
        // ─────────────────────────────────────────────────────────────────
        const hedgeLog1 = logPrices1.slice(-Math.min(logPrices1.length, hedgeRatioBars));
        const hedgeLog2 = logPrices2.slice(-Math.min(logPrices2.length, hedgeRatioBars));

        const hedgeOls = olsRegression(hedgeLog1, hedgeLog2);
        if (!hedgeOls || !Number.isFinite(hedgeOls.slope)) {
            log('OLS failed for %s/%s', symbol1, symbol2);
            return null;
        }

        const hedgeRatio = hedgeOls.slope;
        const hedgeRSquared = hedgeOls.rSquared;

        // ─────────────────────────────────────────────────────────────────
        // 4. ROLLING Z-SCORE (30-day window)
        // ─────────────────────────────────────────────────────────────────
        const zScoreLog1 = logPrices1.slice(-Math.min(logPrices1.length, zScoreBars));
        const zScoreLog2 = logPrices2.slice(-Math.min(logPrices2.length, zScoreBars));
        
        // Use 30-day hedge ratio for Z-score calculation
        const zScoreOls = olsRegression(zScoreLog1, zScoreLog2);
        const zScoreBeta = zScoreOls?.slope ?? hedgeRatio;
        
        const zScoreSpread: number[] = [];
        const zScoreLength = Math.min(zScoreLog1.length, zScoreLog2.length);
        for (let i = 0; i < zScoreLength; i++) {
            const spreadValue = zScoreLog1[i]! - zScoreBeta * zScoreLog2[i]!;
            if (Number.isFinite(spreadValue)) {
                zScoreSpread.push(spreadValue);
            }
        }

        if (zScoreSpread.length < 10) {
            log('Insufficient spread data for %s/%s', symbol1, symbol2);
            return null;
        }

        const rollingMean = zScoreSpread.reduce((a, b) => a + b, 0) / zScoreSpread.length;
        const rollingVariance = zScoreSpread.reduce((a, b) => a + (b - rollingMean) ** 2, 0) / (zScoreSpread.length - 1);
        const rollingStd = Math.sqrt(rollingVariance);
        const currentSpread = zScoreSpread[zScoreSpread.length - 1]!;
        const spreadZ = rollingStd > 0 ? (currentSpread - rollingMean) / rollingStd : 0;

        // ─────────────────────────────────────────────────────────────────
        // 5. SPREAD VOLATILITY (using 30-day spread)
        // ─────────────────────────────────────────────────────────────────
        const spreadReturns: number[] = [];
        for (let i = 1; i < zScoreSpread.length; i++) {
            const ret = zScoreSpread[i]! - zScoreSpread[i - 1]!;
            if (Number.isFinite(ret)) spreadReturns.push(ret);
        }
        let spreadVol = 0;
        if (spreadReturns.length >= 5) {
            const meanReturn = spreadReturns.reduce((a, b) => a + b, 0) / spreadReturns.length;
            const variance = spreadReturns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / (spreadReturns.length - 1);
            spreadVol = Math.sqrt(variance);
        }

        // ─────────────────────────────────────────────────────────────────
        // 6. RSI (14-period)
        // ─────────────────────────────────────────────────────────────────
        const rsi1 = calculateRSI(prices1);
        const rsi2 = calculateRSI(prices2);
        
        log('RSI values: %s=%.1f, %s=%.1f', symbol1, rsi1, symbol2, rsi2);

        // ─────────────────────────────────────────────────────────────────
        // 7. COMPOSITE SCORE
        // ─────────────────────────────────────────────────────────────────
        const compositeScore = (
            0.25 * Math.max(0, correlation) +
            0.25 * Math.abs(spreadZ) +
            0.20 * Math.max(-5, Math.min(0, adfStatistic)) +
            -0.10 * (halfLife ? Math.min(halfLife, 100) : 50) +
            0.10 * (rsi1 / 100) +
            0.10 * (rsi2 / 100)
        );

        // ─────────────────────────────────────────────────────────────────
        // 8. TRADING RECOMMENDATION
        // ─────────────────────────────────────────────────────────────────
        // Spread = log(symbol1) - β * log(symbol2)
        // If spreadZ > 0: spread is ABOVE mean → expect it to fall → SHORT spread
        // If spreadZ < 0: spread is BELOW mean → expect it to rise → LONG spread
        const absZ = Math.abs(spreadZ);
        const isEntrySignal = absZ >= config.entryThreshold;
        const isExitSignal = absZ <= config.exitThreshold;

        const direction: 'LONG' | 'SHORT' = spreadZ > 0 ? 'SHORT' : 'LONG';
        const longSymbol = spreadZ > 0 ? symbol2 : symbol1;
        const shortSymbol = spreadZ > 0 ? symbol1 : symbol2;

        let action: 'ENTER' | 'EXIT' | 'WAIT' = 'WAIT';
        if (isEntrySignal) {
            action = 'ENTER';
        } else if (isExitSignal) {
            action = 'EXIT';
        }

        const signalStrength: 'Strong' | 'Moderate' | 'Weak' = 
            absZ >= 2.0 ? 'Strong' : absZ >= 1.5 ? 'Moderate' : 'Weak';

        // ─────────────────────────────────────────────────────────────────
        // 9. POSITION SIZING (using 7-day hedge ratio)
        // ─────────────────────────────────────────────────────────────────
        // Pear Protocol: Long : Short = |hedge_ratio| : 1
        const absHedgeRatio = Math.abs(hedgeRatio);
        const longPercent = (absHedgeRatio / (1 + absHedgeRatio)) * 100;
        const shortPercent = (1 / (1 + absHedgeRatio)) * 100;

        // ─────────────────────────────────────────────────────────────────
        // BUILD RESULT WITH TIMEFRAME LABELS
        // ─────────────────────────────────────────────────────────────────
        return {
            pair: [symbol1, symbol2],
            // Correlation (30-day)
            correlation: {
                value: correlation,
                strength: getCorrelationStrength(correlation),
                windowDays: config.correlationDays
            },
            // Cointegration (90-day)
            cointegration: {
                isCointegrated,
                adfStatistic,
                pValue: adfPValue,
                halfLifeDays: halfLife,
                windowDays: config.cointegrationDays
            },
            // Z-Score (30-day)
            zScore: {
                value: spreadZ,
                signal: getZScoreSignal(spreadZ),
                windowDays: config.zScoreDays
            },
            // Hedge Ratio (7-day)
            hedgeRatio: {
                value: hedgeRatio,
                rSquared: hedgeRSquared,
                windowDays: config.hedgeRatioDays
            },
            // Spread volatility
            spreadVolatility: spreadVol,
            // RSI
            rsi: {
                [symbol1]: rsi1,
                [symbol2]: rsi2
            },
            // Composite score
            compositeScore,
            // Recommendation
            recommendation: {
                action,
                direction,
                longSymbol,
                shortSymbol,
                signalStrength
            },
            // Position sizing (based on 7-day hedge ratio)
            positionSizing: {
                longSymbol,
                longPercent,
                shortSymbol,
                shortPercent,
                hedgeRatioUsed: hedgeRatio,
                windowDays: config.hedgeRatioDays
            },
            // Metadata
            metadata: {
                timestamp: new Date().toISOString(),
                interval: config.interval,
                candlesFetched: candles1.length
            }
        };

    } catch (error) {
        log('Error scanning %s/%s: %O', symbol1, symbol2, error);
        return null;
    }
}

async function scanAllPairs(
    watchlist: [string, string][],
    config: ScanConfig
): Promise<PairScanResult[]> {
    const results: PairScanResult[] = [];
    
    for (const [sym1, sym2] of watchlist) {
        const result = await scanPair(sym1, sym2, config);
        if (result) {
            results.push(result);
        }
        // Small delay between pairs to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
    }

    // Sort by absolute Z-score (best opportunities first)
    results.sort((a, b) => Math.abs(b.zScore.value) - Math.abs(a.zScore.value));

    return results;
}

function formatScanResults(results: PairScanResult[], config: ScanConfig): string {
    const lines: string[] = [
        '═══════════════════════════════════════════════════════════════',
        '                    PAIR SCANNER RESULTS',
        `                    ${new Date().toISOString()}`,
        '═══════════════════════════════════════════════════════════════',
        '',
        `Timeframes: Cointegration=${config.cointegrationDays}d | Z-Score=${config.zScoreDays}d | Hedge Ratio=${config.hedgeRatioDays}d`,
        ''
    ];

    // Entry signals first
    const entrySignals = results.filter(r => r.recommendation.action === 'ENTER');
    if (entrySignals.length > 0) {
        lines.push('🟢 ENTRY SIGNALS:');
        lines.push('─────────────────────────────────────────────────────────────────');
        for (const r of entrySignals) {
            lines.push(`  ${r.pair[0]}/${r.pair[1]}: Z=${r.zScore.value.toFixed(2)} (${r.zScore.signal})`);
            lines.push(`    → ${r.recommendation.direction} spread: Long ${r.recommendation.longSymbol}, Short ${r.recommendation.shortSymbol}`);
            lines.push(`    → Correlation: ${r.correlation.value.toFixed(2)} | Hedge(7d): ${r.hedgeRatio.value.toFixed(4)} | R²: ${r.hedgeRatio.rSquared.toFixed(2)}`);
            lines.push(`    → Position: Long ${r.positionSizing.longPercent.toFixed(0)}%, Short ${r.positionSizing.shortPercent.toFixed(0)}%`);
            lines.push('');
        }
    }

    // Exit signals
    const exitSignals = results.filter(r => r.recommendation.action === 'EXIT');
    if (exitSignals.length > 0) {
        lines.push('🔴 EXIT SIGNALS (at equilibrium):');
        lines.push('─────────────────────────────────────────────────────────────────');
        for (const r of exitSignals) {
            lines.push(`  ${r.pair[0]}/${r.pair[1]}: Z=${r.zScore.value.toFixed(2)} (equilibrium)`);
        }
        lines.push('');
    }

    // Watchlist (moderate signals)
    const watchlist = results.filter(r => 
        r.recommendation.action === 'WAIT' && Math.abs(r.zScore.value) >= 1.0
    );
    if (watchlist.length > 0) {
        lines.push('🟡 WATCHLIST (approaching entry):');
        lines.push('─────────────────────────────────────────────────────────────────');
        for (const r of watchlist) {
            lines.push(`  ${r.pair[0]}/${r.pair[1]}: Z=${r.zScore.value.toFixed(2)} (${r.zScore.signal})`);
            lines.push(`    → Corr(30d): ${r.correlation.value.toFixed(2)} | Cointegrated(90d): ${r.cointegration.isCointegrated ? '✅' : '❌'}`);
        }
        lines.push('');
    }

    // Summary table with timeframe labels
    lines.push(`FULL SCAN SUMMARY:`);
    lines.push(`  Z-Score: ${config.zScoreDays}d | Hedge Ratio: ${config.hedgeRatioDays}d | Cointegration: ${config.cointegrationDays}d`);
    lines.push('─────────────────────────────────────────────────────────────────');
    lines.push('Pair          | Z(30d)  | Corr  | β(7d)  | R²   | HL(90d)   | Signal');
    lines.push('─────────────────────────────────────────────────────────────────');
    for (const r of results) {
        const pair = `${r.pair[0]}/${r.pair[1]}`.padEnd(13);
        const z = r.zScore.value.toFixed(2).padStart(7);
        const corr = r.correlation.value.toFixed(2).padStart(5);
        const beta = r.hedgeRatio.value.toFixed(3).padStart(6);
        const rsq = r.hedgeRatio.rSquared.toFixed(2).padStart(4);
        const hl = r.cointegration.halfLifeDays ? `${r.cointegration.halfLifeDays.toFixed(0)}d`.padStart(9) : 'N/A'.padStart(9);
        const sig = r.recommendation.action.padStart(6);
        lines.push(`${pair} | ${z} | ${corr} | ${beta} | ${rsq} | ${hl} | ${sig}`);
    }
    lines.push('═══════════════════════════════════════════════════════════════');

    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log('🔍 Hyperliquid Pair Scanner starting...\n');

    const hl = getHyperliquidService();
    
    try {
        // Initialize Hyperliquid connection
        await hl.initialize();
        console.log(`✅ Connected to Hyperliquid (${hl.getAllAssetNames().length} assets)\n`);

        // Parse watchlist from environment, file, or use default
        let watchlist = DEFAULT_WATCHLIST;
        let watchlistSource = 'default';
        
        if (process.env.SCAN_WATCHLIST) {
            // Priority 1: Environment variable
            watchlist = process.env.SCAN_WATCHLIST.split(',').map(p => {
                const [a, b] = p.trim().split(':');
                return [a!, b!] as [string, string];
            });
            watchlistSource = 'env:SCAN_WATCHLIST';
        } else {
            // Priority 2: Try to load from watchlist.json
            try {
                const watchlistFile = await fs.readFile('sim_data/watchlist.json', 'utf-8');
                const data = JSON.parse(watchlistFile);
                if (data.watchlist && Array.isArray(data.watchlist) && data.watchlist.length > 0) {
                    watchlist = data.watchlist;
                    watchlistSource = `file:sim_data/watchlist.json (${data.generatedAt || 'unknown date'})`;
                }
            } catch {
                // Fall through to default
                watchlistSource = 'default (no watchlist.json found)';
            }
        }
        
        console.log(`📋 Watchlist source: ${watchlistSource}`);

        console.log(`📋 Scanning ${watchlist.length} pairs...`);
        console.log(`   Timeframes: Cointegration=${DEFAULT_CONFIG.cointegrationDays}d | Z-Score=${DEFAULT_CONFIG.zScoreDays}d | Hedge=${DEFAULT_CONFIG.hedgeRatioDays}d\n`);

        // Run the scan
        const results = await scanAllPairs(watchlist, DEFAULT_CONFIG);

        // Output results
        const output = formatScanResults(results, DEFAULT_CONFIG);
        console.log(output);

        // Save results to file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `sim_data/scan-hl-${timestamp}.json`;
        await fs.writeFile(filename, JSON.stringify(results, null, 2));
        console.log(`\n📁 Results saved to: ${filename}`);

        // Disconnect
        await hl.disconnect();

    } catch (error) {
        console.error('❌ Scanner error:', error);
        await hl.disconnect();
        process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});

