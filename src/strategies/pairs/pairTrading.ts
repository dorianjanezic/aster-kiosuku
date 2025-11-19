/**
 * PAIR TRADING STRATEGY ENGINE
 *
 * Core statistical arbitrage implementation that identifies and evaluates
 * cointegrated asset pairs for mean-reversion trading opportunities.
 *
 * Key Features:
 * - Multi-asset correlation analysis across sectors/ecosystems
 * - Enhanced technical indicators (RSI divergence, ADX regime, volume)
 * - Cointegration testing with ADF statistics
 * - Quality scoring combining fundamentals, technicals, and sentiment
 * - Risk-adjusted position sizing and entry criteria
 *
 * This module transforms raw market data into actionable trading signals
 * through rigorous statistical analysis and technical confirmation.
 */

import { promises as fs } from 'fs';
import {
    pctChanges,
    logPrices,
    logReturns,
    pearson,
    betaYOnX,
    zScores,
    sampleStd,
    olsRegression,
    adfTest,
    validateDataQuality,
    alignSeries,
    ensureMinimumDataRequirements,
    computePairwiseCorrelations,
    CorrelationResult
} from '../../lib/stats.js';
import { PublicClient } from '../../http/publicClient.js';
// import { JsonlLedger } from '../../persistence/jsonlLedger.js';
import { SqlEventLedger } from '../../persistence/sqlEventLedger.js';
import { computeTechnicalsFromKlines } from '../../tech/indicators.js';
import createDebug from 'debug';

// Enhanced technical analysis for pair trading
function calculateEnhancedTechnicals(longKlines: any[], shortKlines: any[]) {
    if (!longKlines?.length || !shortKlines?.length) {
        return {
            rsiDivergence: 0,
            volumeConfirmation: 0,
            regimeScore: 0,
            adxTrend: 25,
            volumeTrend: 0
        };
    }

    const longTech = computeTechnicalsFromKlines(longKlines);
    const shortTech = computeTechnicalsFromKlines(shortKlines);

    // RSI Divergence: Compare RSI trends between assets
    const longRsi = longTech?.oscillators?.rsi?.value || 50;
    const shortRsi = shortTech?.oscillators?.rsi?.value || 50;
    const longRsiSlope = longTech?.oscillators?.rsi?.slope || 0;
    const shortRsiSlope = shortTech?.oscillators?.rsi?.slope || 0;

    // Bullish divergence: Long RSI improving vs Short RSI, or vice versa for short positions
    let rsiDivergence = 0;
    if (longRsiSlope > 0.1 && shortRsiSlope < -0.1) rsiDivergence = 0.8; // Bullish divergence
    else if (longRsiSlope < -0.1 && shortRsiSlope > 0.1) rsiDivergence = -0.8; // Bearish divergence
    else if (Math.abs(longRsiSlope - shortRsiSlope) > 0.2) rsiDivergence = Math.sign(longRsiSlope - shortRsiSlope) * 0.5;

    // Volume Confirmation: Both assets should have aligned volume trends
    const longVolume = longTech?.volume?.latest || 0;
    const shortVolume = shortTech?.volume?.latest || 0;
    const longVolAvg = longTech?.volume?.avg14 || 0;
    const shortVolAvg = shortTech?.volume?.avg14 || 0;

    let volumeConfirmation = 0;
    if (longVolAvg > 0 && shortVolAvg > 0) {
        const longVolRatio = longVolume / longVolAvg;
        const shortVolRatio = shortVolume / shortVolAvg;
        // Both above average volume = confirmation
        if (longVolRatio > 1.1 && shortVolRatio > 1.1) volumeConfirmation = 0.6;
        else if (longVolRatio < 0.9 && shortVolRatio < 0.9) volumeConfirmation = -0.4; // Both low volume = weak
        else volumeConfirmation = Math.min(0.3, Math.abs(longVolRatio - 1) + Math.abs(shortVolRatio - 1)) * -0.5;
    }

    // Market Regime Score: ADX indicates trend strength, low ADX = ranging (good for pairs)
    const longAdx = longTech?.oscillators?.adx?.adx || 25;
    const shortAdx = shortTech?.oscillators?.adx?.adx || 25;
    const avgAdx = (longAdx + shortAdx) / 2;

    // Low ADX (< 20) = ranging market, good for pair trading
    // High ADX (> 30) = trending market, less ideal for pairs
    let regimeScore = 0;
    if (avgAdx < 20) regimeScore = 0.8; // Strong ranging, excellent for pairs
    else if (avgAdx < 25) regimeScore = 0.4; // Mild ranging
    else if (avgAdx < 30) regimeScore = -0.2; // Mild trending
    else regimeScore = -0.6; // Strong trending, poor for pairs

    // Volume Trend: Overall volume direction
    const volumeTrend = (longVolAvg > 0 ? (longVolume - longVolAvg) / longVolAvg : 0) * 0.5 +
        (shortVolAvg > 0 ? (shortVolume - shortVolAvg) / shortVolAvg : 0) * 0.5;

    return {
        rsiDivergence,
        volumeConfirmation,
        regimeScore,
        adxTrend: avgAdx,
        volumeTrend
    };
}

type Market = {
    symbol: string;
    categories?: {
        sector?: string;
        ecosystem?: string;
        type?: string;
        computed?: { liquidityTier?: 'T1' | 'T2' | 'T3'; volatilityBucket?: string };
        metrics?: { liquidityScore?: number; atrPct14?: number; fundingMean?: number; fundingVariance?: number; quoteVolume?: number };
    };
};

// Approximate number of bars per day for a given kline interval string (e.g. "1h", "4h", "1d").
function getBarsPerDay(interval: string): number {
    const m = interval.match(/^(\d+)([mhd])$/i);
    if (!m) return 24; // Default to 1h bars
    const n = Number(m[1] || '1');
    const unit = m[2]?.toLowerCase();
    if (!Number.isFinite(n) || n <= 0) return 24;
    switch (unit) {
        case 'm': {
            const minutesPerDay = 24 * 60;
            return minutesPerDay / n;
        }
        case 'h': {
            const hoursPerDay = 24;
            return hoursPerDay / n;
        }
        case 'd':
            return 1 / n;
        default:
            return 24;
    }
}

export type PairCandidate = {
    sector?: string;
    ecosystem?: string;
    assetType?: string;
    long: string;
    short: string;
    corr?: number;
    beta?: number;
    hedgeRatio?: number;
    cointegration?: { adfT?: number; p?: number | null; lags?: number; halfLife?: number | null; stationary?: boolean };
    spreadZ?: number;
    // Standard deviation of the log spread series used for ADF (spread volatility)
    spreadVol?: number;
    // Log price ratio z-score over a recent window (e.g. 14–30 days)
    ratioZ?: number;
    fundingNet?: number; // estimated per-period net funding carry for dollar-neutral sizing
    // Enhanced technical indicators
    technicals?: {
        rsiDivergence?: number; // -1 (bearish divergence) to +1 (bullish divergence)
        volumeConfirmation?: number; // Volume trend alignment (-1 to +1)
        regimeScore?: number; // Market regime suitability for pair trading (-1 trending, +1 mean-reverting)
        adxTrend?: number; // ADX value indicating trend strength
        volumeTrend?: number; // Volume trend direction and strength
    };
    scores: { long: number; short: number; composite: number };
    notes: string[];
};

export async function buildPairCandidates(marketsPath = 'sim_data/markets.json', limitPerGroup = 5, client?: PublicClient): Promise<{ pairs: PairCandidate[] }> {
    const log = createDebug('agent:pairs');
    let data: any = {};
    try {
    const text = await fs.readFile(marketsPath, 'utf8');
        data = JSON.parse(text);
    } catch {
        try {
            const { getDb } = await import('../../db/sqlite.js');
            const { SqliteRepo } = await import('../../services/sqliteRepo.js');
            const repo = new SqliteRepo(await getDb());
            const latest = repo.getLatestMarkets();
            if (latest) data = latest;
        } catch {}
    }
    const ledger = new SqlEventLedger();
    const all = (data.markets || []) as Market[];
    log('markets loaded: %d', all.length);
    const markets: Market[] = (all || []).filter((m: any) => {
        if (!m?.symbol || !m?.categories) {
            void ledger.append('invalid_market', { symbol: m?.symbol, error: 'Missing symbol or categories' });
            return false;
        }
        return true;
    });
    log('markets valid: %d', markets.length);
    const http = client ?? new PublicClient(process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com', process.env.ASTER_BASE_PATH || '/fapi/v1');
    const noFilters = ((process.env.PAIRS_NO_FILTERS || '').toLowerCase() === '1' || (process.env.PAIRS_NO_FILTERS || '').toLowerCase() === 'true');
    const allowCrossCategory = ((process.env.PAIRS_ALLOW_CROSS_CATEGORY || '').toLowerCase() === '1' || (process.env.PAIRS_ALLOW_CROSS_CATEGORY || '').toLowerCase() === 'true');
    const sideCandidates = Math.max(2, Number(process.env.PAIRS_SIDE_CANDIDATES || '10'));
    const pairingMode = (process.env.PAIRS_PAIRING_MODE || 'extremes').toLowerCase();
    async function generateForGroup(groupKey: string, items: Market[], tag: 'sector' | 'ecosystem' | 'assetType' | 'global'): Promise<PairCandidate[]> {
        const tradable = noFilters ? items : items.filter(i => {
            const tier = i.categories?.computed?.liquidityTier;
            return (tier === 'T1' || tier === 'T2') && i.symbol.endsWith('USDT');
        });
        log('group %s[%s]: items=%d tradable=%d', tag, groupKey, items.length, tradable.length);
        if (tradable.length < 2) return [];
        const limit = Math.min(limitPerGroup, Math.ceil(tradable.length / 2));
        const symbols = tradable.map(t => t.symbol);
        const series = new Map<string, number[]>();
        const klines = new Map<string, any[]>(); // Store full klines for enhanced technicals
        const rsiValues: number[] = [];
        const klineErrors: string[] = [];

        // Fetch klines once for each symbol and compute both price series and RSI
        for (const t of tradable) {
            try {
                const kl = await http.getKlines(t.symbol, process.env.PAIRS_INTERVAL || '1h', Number(process.env.PAIRS_LIMIT || '500'));

                // Store full klines for enhanced technical analysis
                klines.set(t.symbol, kl as any[]);

                // Extract close prices for statistical analysis
                const closes = kl.map((k: any) => Number(k[4])).filter((n: any) => Number.isFinite(n) && n > 0);
                if (closes.length >= 30) { // Minimum requirement for analysis
                    series.set(t.symbol, closes);
                } else {
                    klineErrors.push(`${t.symbol}: insufficient valid close prices (${closes.length})`);
                }

                // Compute RSI for ranking
                try {
                    const tech: any = computeTechnicalsFromKlines(kl as any);
                    const rsi = Number(tech?.oscillators?.rsi?.value ?? 50);
                    rsiValues.push(Number.isFinite(rsi) ? rsi : 50);
                } catch (rsiError) {
                    rsiValues.push(50); // Default RSI
                    klineErrors.push(`${t.symbol}: RSI calculation failed - ${String(rsiError)}`);
                }

            } catch (e) {
                klineErrors.push(`${t.symbol}: kline fetch failed - ${String(e)}`);
                rsiValues.push(50); // Default RSI for failed fetches
            }
        }

        // Log any errors encountered
        if (klineErrors.length > 0) {
            log('group %s[%s]: kline errors=%d', tag, groupKey, klineErrors.length);
            for (const error of klineErrors) {
                void ledger.append('kline_error', { group: `${tag}:${groupKey}`, error });
            }
        }

        log('group %s[%s]: successful klines=%d/%d', tag, groupKey, series.size, symbols.length);
        const liq = tradable.map(t => t.categories?.metrics?.liquidityScore ?? 0);
        const vol = tradable.map(t => t.categories?.metrics?.atrPct14 ?? 0);
        const fund = tradable.map(t => t.categories?.metrics?.fundingMean ?? 0);
        const qv = tradable.map(t => t.categories?.metrics?.quoteVolume ?? 0);
        // Compute z-scores then cap to reduce outlier influence
        const cap = (arr: number[]) => arr.map(v => Math.max(-3, Math.min(3, v ?? 0)));
        const liqZ = cap(zScores(liq));
        const volZ = cap(zScores(vol));
        const fundZ = cap(zScores(fund));
        const qvZ = cap(zScores(qv));
        const rsiZ = cap(zScores(rsiValues));
        const W1 = Number(process.env.PAIRS_W_LIQ || '0.4');
        const W2 = Number(process.env.PAIRS_W_VOL || '0.3');
        const W3 = Number(process.env.PAIRS_W_FUND || '0.2');
        const W4 = Number(process.env.PAIRS_W_QV || '0.1');
        const W5 = Number(process.env.PAIRS_W_RSI || '0.2');
        const minCorr = Number(process.env.PAIRS_MIN_CORR || '0.7');
        const corrDays = Number(process.env.PAIRS_CORR_DAYS || '90');
        const ratioDaysDefault = Number(process.env.PAIRS_RATIO_DAYS || '21');
        const ratioDaysMin = Number(process.env.PAIRS_RATIO_MIN_DAYS || '14');
        const ratioDaysMax = Number(process.env.PAIRS_RATIO_MAX_DAYS || '30');
        const ratioDays = Math.min(
            Number.isFinite(ratioDaysMax) ? ratioDaysMax : 30,
            Math.max(Number.isFinite(ratioDaysMin) ? ratioDaysMin : 14, Number.isFinite(ratioDaysDefault) ? ratioDaysDefault : 21)
        );
        log('weights W1=%s W2=%s W3=%s W4=%s W5=%s minCorr=%s corrDays=%s ratioDays=%s', W1, W2, W3, W4, W5, minCorr, corrDays, ratioDays);
        // Align signs: favor higher liquidity, volume, funding, RSI
        const comp = tradable.map((_, i) => (W1 * (liqZ[i] ?? 0)) + (W2 * (volZ[i] ?? 0)) + (W3 * (fundZ[i] ?? 0)) + (W4 * (qvZ[i] ?? 0)) + (W5 * (rsiZ[i] ?? 0)));
        const ranked = tradable.map((t, i) => ({ t, s: comp[i], i, rsi: rsiValues[i] }))
            .sort((a, b) => (b.s ?? 0) - (a.s ?? 0));
        const topRaw = ranked.slice(0, Math.min(sideCandidates, ranked.length));
        const bottomRaw = ranked.slice(-Math.min(sideCandidates, ranked.length)).reverse();

        // Selection of candidate sides
        // Separation of Selection and Timing:
        // We relax the strict RSI gates (>55 / <45) to identify structurally cointegrated pairs
        // even if they are not currently at extreme RSI levels.
        // The ranking (which includes RSI score) still naturally biases top/bottom selection.
        let top = topRaw; 
        let bottom = bottomRaw;

        // If we still want to ensure some minimal separation, we can use very loose bounds or just rely on ranking.
        // For "noFilters", we use raw. For default, we essentially do the same but might log.
        if (!noFilters) {
             // Previously: top = topRaw.filter(r => r.rsi >= 55);
             // Now: we accept all top ranked candidates as potential short legs
             // and all bottom ranked as potential long legs.
             // Logic matches "Selection first, Timing later"
        }

        // Ensure we have at least one candidate from each side
        if (!top.length && topRaw.length) top = [topRaw[0]!];
        if (!bottom.length && bottomRaw.length) bottom = [bottomRaw[0]!];
        log('group %s[%s]: top=%d bottom=%d', tag, groupKey, top.length, bottom.length);
        if (pairingMode !== 'extremes') {
            log('group %s[%s]: pairingMode=%s', tag, groupKey, pairingMode);
        }

        // Pre-compute correlations and betas for all candidate pairs to optimize performance
        const pool = (pairingMode === 'corr_first' || pairingMode === 'pool')
            ? ranked.slice(0, Math.min(sideCandidates * 2, ranked.length))
            : ([] as typeof ranked).concat(top, bottom);
        const candidateSymbols = [...new Set(pool.map(t => t.t.symbol))];
        const symbolToIndex = new Map(candidateSymbols.map((s, i) => [s, i]));
        const returnsMatrix: number[][] = [];

        // Determine correlation lookback window in bars (approximate 90 days by default)
        const intervalStr = process.env.PAIRS_INTERVAL || '1h';
        const corrLookbackDays = Number(process.env.PAIRS_CORR_DAYS || '90');
        const barsPerDay = getBarsPerDay(intervalStr);
        const corrLookbackBars = Math.max(30, Math.floor(corrLookbackDays * barsPerDay)); // Ensure a minimum window

        // Build returns matrix for correlation computation
        for (const symbol of candidateSymbols) {
            const priceSeries = series.get(symbol);
            if (priceSeries && priceSeries.length >= 50) { // Ensure minimum data
                // Use only the most recent window for correlation estimation
                const clipped = priceSeries.slice(-Math.min(corrLookbackBars + 1, priceSeries.length));
                const returns = logReturns(clipped);
                if (returns.length >= 20) { // Ensure minimum returns data
                    returnsMatrix.push(returns);
                } else {
                    returnsMatrix.push([]); // Insufficient returns data
                }
            } else {
                returnsMatrix.push([]); // Insufficient price data
            }
        }

        const correlationMap = computePairwiseCorrelations(returnsMatrix);

        const out: PairCandidate[] = [];
        const seen = new Set<string>();
        let considered = 0; let skippedCorr = 0; let produced = 0;

        // Build concrete list of candidate pairs depending on strategy
        const pairCombos: Array<{ lo: any; hi: any }> = [];
        if (pairingMode === 'extremes') {
            for (const lo of bottom) {
                for (const hi of top) {
                    pairCombos.push({ lo, hi });
                }
            }
        } else {
            for (let i = 0; i < pool.length; i++) {
                for (let j = i + 1; j < pool.length; j++) {
                    pairCombos.push({ lo: pool[i]!, hi: pool[j]! });
                }
            }
        }

        for (const { lo, hi } of pairCombos) {
                if (lo.t.symbol === hi.t.symbol) continue;
                const key = `${tag}:${groupKey}|${lo.t.symbol}|${hi.t.symbol}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const a = series.get(lo.t.symbol);
                const b = series.get(hi.t.symbol);
                let corr: number | undefined; let beta: number | undefined;
                let hedgeRatio: number | undefined; let adfT: number | undefined; let adfP: number | null = null; let halfLife: number | null = null; let stationary = false; let spreadZ: number | undefined; let spreadVol: number | undefined; let fundingNet: number | undefined; let ratioZ: number | undefined;
                if (a && b) {
                    // Check minimum data requirements first
                    const dataReqCheck = ensureMinimumDataRequirements(a, b);
                    if (!dataReqCheck.isValid) {
                        void ledger.append('invalid_pair', { key, reason: 'insufficient_data', details: dataReqCheck.reason });
                        continue;
                    }

                    // Validate data quality
                    const aQuality = validateDataQuality(a);
                    const bQuality = validateDataQuality(b);
                    if (!aQuality.isValid || !bQuality.isValid) {
                        void ledger.append('invalid_pair', {
                            key,
                            reason: 'data_quality_issues',
                            aIssues: aQuality.issues,
                            bIssues: bQuality.issues
                        });
                        continue;
                    }

                    // Align series to ensure temporal synchronization
                    const { alignedA, alignedB } = alignSeries(a, b);
                    const pricesA = alignedA;
                    const pricesB = alignedB;

                    // Get pre-computed correlation and beta from the correlation map
                    const idxA = symbolToIndex.get(lo.t.symbol);
                    const idxB = symbolToIndex.get(hi.t.symbol);

                    if (idxA === undefined || idxB === undefined) {
                        void ledger.append('invalid_pair', { key, reason: 'correlation_data_missing' });
                        continue;
                    }

                    // Ensure consistent ordering (smaller index first)
                    const [idx1, idx2] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
                    const corrResult = correlationMap.get(`${idx1}-${idx2}`);

                    if (!corrResult || !corrResult.isValid) {
                        // Fallback: compute correlation/beta from aligned returns for this pair only
                        try {
                            const returnsA = logReturns(pricesA);
                            const returnsB = logReturns(pricesB);
                            const minLen = Math.min(returnsA.length, returnsB.length);
                            if (minLen >= 10) {
                                const rA = returnsA.slice(-minLen);
                                const rB = returnsB.slice(-minLen);
                                const fbCorr = pearson(rA, rB);
                                const fbBeta = betaYOnX(rA, rB);
                                if (Number.isFinite(fbCorr as number) && Number.isFinite(fbBeta as number)) {
                                    corr = fbCorr as number;
                                    beta = (fbBeta as number);
                                } else {
                                    void ledger.append('invalid_pair', { key, reason: 'correlation_fallback_failed' });
                                    continue;
                                }
                            } else {
                                void ledger.append('invalid_pair', { key, reason: 'correlation_insufficient_returns', lenA: returnsA.length, lenB: returnsB.length });
                                continue;
                            }
                        } catch {
                            void ledger.append('invalid_pair', { key, reason: 'correlation_calculation_failed' });
                            continue;
                        }
                    } else {
                        corr = corrResult.correlation;
                        // For beta, we want beta of long (lo) vs short (hi), so if we swapped indices, invert beta
                        beta = idxA < idxB ? corrResult.beta : (1 / corrResult.beta);
                    }


                    if (!noFilters) {
                        if ((corr ?? 0) < minCorr) {
                            skippedCorr++;
                            void ledger.append('invalid_pair', { key, reason: 'low_correlation', corr });
                            continue;
                        }
                    }

                    // Use log prices for cointegration analysis
                    const logPricesA = logPrices(pricesA);
                    const logPricesB = logPrices(pricesB);

                    // Rolling Beta / Hedge Ratio Calculation
                    // Use a shorter, recent window (e.g. 30 days) for OLS to capture the current structural relationship
                    // rather than a long-term average which may be invalid if the relationship has drifted.
                    const barsPerDay = getBarsPerDay(process.env.PAIRS_INTERVAL || '1h');
                    const hedgeLookbackDays = 30;
                    const hedgeLookbackBars = Math.floor(hedgeLookbackDays * barsPerDay);
                    
                    // Slice the series to the recent window for OLS and Spread calculation
                    const hedgeLogA = logPricesA.slice(-Math.min(logPricesA.length, hedgeLookbackBars));
                    const hedgeLogB = logPricesB.slice(-Math.min(logPricesB.length, hedgeLookbackBars));

                    // Calculate hedge ratio using proper OLS regression (y = long, x = short)
                    let olsResult;
                    try {
                        olsResult = olsRegression(hedgeLogA, hedgeLogB);
                    } catch (e) {
                        void ledger.append('invalid_pair', { key, reason: 'ols_regression_error', error: String(e) });
                        continue;
                    }

                    if (olsResult && Number.isFinite(olsResult.slope)) {
                        hedgeRatio = olsResult.slope;

                        // Calculate spread: long - hedgeRatio * short
                        // We calculate spread on the SAME recent window used for OLS to test current stationarity.
                        const spread: number[] = [];
                        for (let i = 0; i < hedgeLogA.length && i < hedgeLogB.length; i++) {
                            const spreadValue = hedgeLogA[i]! - hedgeRatio * hedgeLogB[i]!;
                            if (Number.isFinite(spreadValue)) {
                                spread.push(spreadValue);
                            }
                        }

                        // Calculate spread volatility and current spread z-score using sample standard deviation
                        // Use available data even if less than 30 points
                        if (spread.length >= 5) { // Minimum for meaningful stats
                            try {
                                spreadVol = sampleStd(spread);
                                const spreadZScores = zScores(spread, true); // Use sample std
                                spreadZ = spreadZScores[spreadZScores.length - 1] ?? 0;
                            } catch {
                                spreadVol = undefined;
                                spreadZ = 0; // Default to neutral if calculation fails
                            }
                        } else {
                            spreadVol = undefined;
                            spreadZ = 0; // Default to neutral if insufficient data
                        }

                        // Calculate log price ratio z-score over a recent window (e.g. 14–30 days)
                        try {
                            const ratioSeries: number[] = [];
                            const len = Math.min(logPricesA.length, logPricesB.length);
                            for (let i = 0; i < len; i++) {
                                const v = logPricesA[i]! - logPricesB[i]!;
                                if (Number.isFinite(v)) ratioSeries.push(v);
                            }
                            const minRatioBars = 20;
                            if (ratioSeries.length >= minRatioBars) {
                                const ratioLookbackBars = Math.max(
                                    minRatioBars,
                                    Math.floor(ratioDays * barsPerDay)
                                );
                                const windowSize = Math.min(ratioSeries.length, ratioLookbackBars);
                                const window = ratioSeries.slice(-windowSize);
                                const mean = window.reduce((a, b) => a + b, 0) / window.length;
                                const variance = window.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, window.length - 1);
                                const std = Math.sqrt(variance) || 1e-12;
                                const latest = window[window.length - 1]!;
                                ratioZ = (latest - mean) / std;
                            } else {
                                ratioZ = 0;
                            }
                        } catch {
                            ratioZ = 0;
                        }

                        // Perform ADF test on spread for cointegration
                        let adfResult;
                        try {
                            adfResult = adfTest(spread);
                        } catch (e) {
                            void ledger.append('invalid_pair', { key, reason: 'adf_test_error', error: String(e) });
                            continue;
                        }

                        if (adfResult) {
                            adfT = adfResult.testStatistic;
                            adfP = adfResult.pValue;
                            stationary = adfResult.isStationary;
                            halfLife = adfResult.halfLife;
                        } else {
                            void ledger.append('invalid_pair', { key, reason: 'adf_test_failed' });
                            continue;
                        }

                        // Compute pair-level net funding assuming dollar-neutral sizing
                        try {
                            const loFund = Number(lo.t.categories?.metrics?.fundingMean ?? 0);
                            const hiFund = Number(hi.t.categories?.metrics?.fundingMean ?? 0);
                            const b = typeof beta === 'number' && Number.isFinite(beta) ? beta : 1;
                            // Long pays loFund, short receives hiFund; scale short leg by beta for neutrality
                            fundingNet = (-loFund) + (b * hiFund);
                        } catch (e) {
                            void ledger.append('invalid_pair', { key, reason: 'funding_calculation_error', error: String(e) });
                            fundingNet = 0; // Default to zero
                        }
                    } else {
                        void ledger.append('invalid_pair', { key, reason: 'ols_regression_failed', rSquared: olsResult?.rSquared });
                        continue;
                    }
                }
                // Enforce strong mean-reversion filters unless disabled
                const strictHalf = Number(process.env.PAIRS_MAX_HALFLIFE_DAYS || '20');
                const fallbackHalf = Number(process.env.PAIRS_FALLBACK_MAX_HALFLIFE_DAYS || '40');
                const strictSpread = Number(process.env.PAIRS_MIN_SPREADZ || '0.8');
                const fallbackSpread = Number(process.env.PAIRS_FALLBACK_MIN_SPREADZ || '0.5');
                const maxAdfP = Number(process.env.PAIRS_MAX_ADF_P || '0.10');

                let relaxed = false;
                if (!noFilters) {
                    // Check for basic mean-reversion using ADF p-value threshold
                    if (stationary === false || adfP == null || adfP > maxAdfP) {
                        void ledger.append('invalid_pair', { key, reason: 'non_stationary', adfT, adfP, maxAdfP });
                        continue;
                    }
                    // Check half-life for reasonable mean-reversion speed
                    if (halfLife != null && halfLife > strictHalf) {
                        const hasFastHalfLife = out.some(p => (p.cointegration?.halfLife ?? Infinity) <= strictHalf);
                        if (halfLife <= fallbackHalf && !hasFastHalfLife) {
                            relaxed = true;
                        } else {
                            void ledger.append('invalid_pair', { key, reason: 'halflife_exceeds', halfLife });
                            continue;
                        }
                    }
                    // Check spread Z-score for mean-reversion opportunity
                    if (Math.abs(spreadZ ?? 0) < strictSpread) {
                        const hasStrictZ = out.some(p => Math.abs(p.spreadZ ?? 0) >= strictSpread);
                        if (Math.abs(spreadZ ?? 0) >= fallbackSpread && !hasStrictZ) {
                            relaxed = true;
                        } else {
                            void ledger.append('invalid_pair', { key, reason: 'spreadz_low', spreadZ });
                            continue;
                        }
                    }
                }
                // Calculate enhanced technical indicators
                const longKlines = klines.get(lo.t.symbol) || [];
                const shortKlines = klines.get(hi.t.symbol) || [];
                const enhancedTech = calculateEnhancedTechnicals(longKlines, shortKlines);

                const ls = lo.s ?? 0; const hs = hi.s ?? 0;
                const ratioZAbs = Math.abs(ratioZ ?? 0);
                // Enhanced composite scoring with technical indicators
                // 0.2*corr + 0.2*|spreadZ| + 0.15*loScore + 0.15*hiScore - 0.08*(halfLife/5) + 0.08*adfT + 0.07*|ratioZ| + 0.07*volConf + 0.08*regime
                const composite = (0.2 * Math.max(0, corr ?? 0)) +
                    (0.2 * Math.abs(spreadZ ?? 0)) +
                    (0.15 * (ls ?? 0)) +
                    (0.15 * (hs ?? 0)) -
                    (0.08 * ((halfLife ?? 0) / 5)) +
                    (0.08 * Math.max(-5, Math.min(0, adfT ?? 0))) + // Reward significant ADF statistics
                    (0.07 * ratioZAbs) + // Log price ratio z-score over recent window
                    (0.07 * (enhancedTech.volumeConfirmation ?? 0)) + // Volume confirmation
                    (0.08 * (enhancedTech.regimeScore ?? 0)); // Market regime suitability
                // Ensure we have valid statistical data before creating pair
                if (corr == null || beta == null || !Number.isFinite(corr) || !Number.isFinite(beta)) {
                    continue;
                }

                // Derive combined sector label when legs come from different categories
                const secLo = (lo.t as any)?.categories?.sector as (string | undefined);
                const secHi = (hi.t as any)?.categories?.sector as (string | undefined);
                const combinedSector = (secLo && secHi) ? (secLo === secHi ? secLo : `${secLo}/${secHi}`) : (secLo || secHi);

                // FIX: Assign long/short based on spreadZ direction for correct mean-reversion trades
                // Spread = log(A) - hedgeRatio * log(B)
                // If spreadZ > 0: spread is HIGH → short A (overvalued), long B (undervalued)
                // If spreadZ < 0: spread is LOW → long A (undervalued), short B (overvalued)
                const currentSpreadZ = spreadZ ?? 0;
                const actualLong = currentSpreadZ > 0 ? hi.t.symbol : lo.t.symbol;
                const actualShort = currentSpreadZ > 0 ? lo.t.symbol : hi.t.symbol;
                const actualLongSector = currentSpreadZ > 0 ? secHi : secLo;
                const actualShortSector = currentSpreadZ > 0 ? secLo : secHi;
                const actualLongScore = currentSpreadZ > 0 ? hs : ls;
                const actualShortScore = currentSpreadZ > 0 ? ls : hs;

                const base: Partial<PairCandidate> = {
                    long: actualLong,
                    short: actualShort,
                    corr: corr ?? 0,
                    beta: beta ?? 1,
                    hedgeRatio,
                    cointegration: (hedgeRatio != null) ? { adfT, p: adfP, lags: 0, halfLife, stationary } : undefined,
                    spreadZ: currentSpreadZ,
                    spreadVol: spreadVol ?? undefined,
                    ratioZ: ratioZ ?? 0,
                    fundingNet,
                    technicals: enhancedTech, // Add enhanced technical indicators
                    scores: { long: actualLongScore, short: actualShortScore, composite },
                    notes: ['enhanced-scores', `corr:${corr?.toFixed(3)}`, `beta:${beta?.toFixed(3)}`, `spreadZ:${currentSpreadZ.toFixed(2)}`, `ratioZ:${(ratioZ ?? 0).toFixed(2)}`, `adfT:${adfT?.toFixed(2)}`, `rsiDiv:${enhancedTech.rsiDivergence?.toFixed(2)}`, `regime:${enhancedTech.regimeScore?.toFixed(2)}`],
                    sector: combinedSector as any,
                    // Provide leg-level categories to consumers that want to render both
                    // (frontends use passthrough schemas so extra fields are fine)
                    longSector: actualLongSector as any,
                    shortSector: actualShortSector as any
                } as any;
                if (relaxed) (base as any).notes.push('relaxed-filter');
                if (tag === 'sector') (base as any).sector = groupKey;
                if (tag === 'ecosystem') (base as any).ecosystem = groupKey;
                if (tag === 'assetType') (base as any).assetType = groupKey;
                out.push(base as PairCandidate);
                produced++;
                if (out.length >= limit) break;
                considered++;
            }
        log('group %s[%s]: considered=%d produced=%d skippedCorr=%d limit=%d', tag, groupKey, considered, produced, skippedCorr, limit);
        return out;
    }

    const bySector = new Map<string, Market[]>();
    const byEco = new Map<string, Market[]>();
    const byType = new Map<string, Market[]>();
    for (const m of markets) {
        const sec = m.categories?.sector || 'Unknown';
        const eco = m.categories?.ecosystem || 'Unknown';
        const typ = m.categories?.type || 'Unknown';
        if (!bySector.has(sec)) bySector.set(sec, []);
        if (!byEco.has(eco)) byEco.set(eco, []);
        if (!byType.has(typ)) byType.set(typ, []);
        bySector.get(sec)!.push(m);
        byEco.get(eco)!.push(m);
        byType.get(typ)!.push(m);
    }

    const pairs: PairCandidate[] = [];
    for (const [k, items] of bySector.entries()) pairs.push(...await generateForGroup(k, items, 'sector'));
    for (const [k, items] of byEco.entries()) pairs.push(...await generateForGroup(k, items, 'ecosystem'));
    for (const [k, items] of byType.entries()) pairs.push(...await generateForGroup(k, items, 'assetType'));
    // Optional global group to allow cross-category pair building
    if (allowCrossCategory) {
        pairs.push(...await generateForGroup('ALL', markets, 'global'));
    }

    // De-duplicate across groups by long/short combo (keep first occurrence)
    const uniq: PairCandidate[] = [];
    const seenCombo = new Set<string>();
    for (const p of pairs) {
        const key = `${p.long}|${p.short}`;
        if (seenCombo.has(key)) continue;
        seenCombo.add(key);
        uniq.push(p);
    }

    log('pairs before dedupe=%d after=%d', pairs.length, uniq.length);
    return { pairs: uniq };
}

export {};
