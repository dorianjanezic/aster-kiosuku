/**
 * COMPUTE PAIR CLI TOOL
 *
 * Command-line utility for computing pair trading statistics between two specific markets.
 * Performs comprehensive statistical analysis including:
 * - Correlation analysis (Pearson coefficient)
 * - Cointegration testing (Augmented Dickey-Fuller test)
 * - Hedge ratio calculation (OLS regression)
 * - Spread analysis (Z-score and mean reversion)
 * - Risk metrics (beta, volatility, half-life)
 * - Technical indicators (RSI, funding rates)
 *
 * Usage: pnpm build && node dist/cli/computePair.js SYMBOL1 SYMBOL2
 *
 * Mathematical Foundation:
 * - Pairs trading exploits mean reversion in cointegrated asset pairs
 * - When spread deviates significantly from mean, bet on convergence
 * - Position sizing maintains dollar/volatility neutrality
 *
 * Output: Detailed analysis saved to JSON + formatted console output
 */

import 'dotenv/config';
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
} from '../lib/stats.js';
import { PublicClient } from '../http/publicClient.js';
// import { SqlEventLedger } from '../persistence/sqlEventLedger.js';
import { computeTechnicalsFromKlines } from '../tech/indicators.js';
import createDebug from 'debug';

// Helper function to describe correlation strength
function getCorrelationStrength(corr?: number): string {
    if (!corr || !Number.isFinite(corr)) return 'Unknown';
    const abs = Math.abs(corr);
    if (abs >= 0.8) return 'Very Strong';
    if (abs >= 0.6) return 'Strong';
    if (abs >= 0.4) return 'Moderate';
    if (abs >= 0.2) return 'Weak';
    return 'Very Weak';
}

// Helper function to describe Z-score signal strength
function getZScoreSignal(z: number): string {
    const abs = Math.abs(z);
    if (abs >= 2.0) return 'Extreme';
    if (abs >= 1.5) return 'Strong';
    if (abs >= 1.0) return 'Moderate';
    return 'Weak';
}

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

async function computePair(symbol1: string, symbol2: string, client?: PublicClient): Promise<any> {
    const log = createDebug('agent:compute-pair');
    let data: any = {};

    // Load market data
    try {
        const text = await fs.readFile('sim_data/markets.json', 'utf8');
        data = JSON.parse(text);
    } catch {
        try {
            const { getDb } = await import('../db/sqlite.js');
            const { SqliteRepo } = await import('../services/sqliteRepo.js');
            const repo = new SqliteRepo(await getDb());
            const latest = repo.getLatestMarkets();
            if (latest) data = latest;
        } catch { }
    }

    // const ledger = new SqlEventLedger();
    const all = (data.markets || []) as any[];
    const markets: any[] = all.filter((m: any) => {
        if (!m?.symbol || !m?.categories) {
            console.warn(`Invalid market: ${m?.symbol || 'unknown'} - Missing symbol or categories`);
            return false;
        }
        return true;
    });

    log('markets loaded: %d', markets.length);

    // Find the two markets
    const market1 = markets.find(m => m.symbol === symbol1);
    const market2 = markets.find(m => m.symbol === symbol2);

    if (!market1) {
        throw new Error(`Market ${symbol1} not found`);
    }
    if (!market2) {
        throw new Error(`Market ${symbol2} not found`);
    }

    const http = client ?? new PublicClient(process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com', process.env.ASTER_BASE_PATH || '/fapi/v1');

    // Configuration: Use 1h candles, 750 periods (~31 days of data)
    // This provides sufficient history for robust statistical analysis
    const interval = process.env.PAIRS_INTERVAL || '1h';
    const limit = Number(process.env.PAIRS_LIMIT || '750');

    console.log(`Computing pair: ${symbol1} vs ${symbol2}`);
    console.log(`Using interval: ${interval}, limit: ${limit} candles (~${Math.round(limit / 24)} days)`);

    // Fetch historical price data (klines) for both symbols
    // Klines contain OHLCV data: [timestamp, open, high, low, close, volume]
    const [klines1, klines2] = await Promise.all([
        http.getKlines(symbol1, interval, limit),
        http.getKlines(symbol2, interval, limit)
    ]);

    console.log(`Fetched ${klines1.length} klines for ${symbol1}`);
    console.log(`Fetched ${klines2.length} klines for ${symbol2}`);

    // Extract close prices
    const prices1 = klines1.map((k: any) => Number(k[4])).filter((n: any) => Number.isFinite(n) && n > 0);
    const prices2 = klines2.map((k: any) => Number(k[4])).filter((n: any) => Number.isFinite(n) && n > 0);

    console.log(`Valid prices: ${prices1.length} for ${symbol1}, ${prices2.length} for ${symbol2}`);

    // Check minimum data requirements
    const dataReqCheck = ensureMinimumDataRequirements(prices1, prices2);
    if (!dataReqCheck.isValid) {
        throw new Error(`Insufficient data: ${dataReqCheck.reason}`);
    }

    // Validate data quality
    const quality1 = validateDataQuality(prices1);
    const quality2 = validateDataQuality(prices2);
    if (!quality1.isValid || !quality2.isValid) {
        console.warn('Data quality issues:');
        if (!quality1.isValid) console.warn(`  ${symbol1}: ${quality1.issues.join(', ')}`);
        if (!quality2.isValid) console.warn(`  ${symbol2}: ${quality2.issues.join(', ')}`);
    }

    // Align series
    const { alignedA: alignedPrices1, alignedB: alignedPrices2 } = alignSeries(prices1, prices2);

    // Compute returns for correlation
    const returns1 = logReturns(alignedPrices1);
    const returns2 = logReturns(alignedPrices2);

    // Calculate correlation coefficient
    // Correlation: Measures linear relationship between returns (-1 to +1)
    // High correlation indicates good pair candidates for statistical arbitrage
    const correlation = pearson(returns1, returns2);

    console.log(`Correlation: ${correlation?.toFixed(4) ?? 'N/A'} (${getCorrelationStrength(correlation)})`);

    // Use log prices for cointegration analysis
    const logPrices1 = logPrices(alignedPrices1);
    const logPrices2 = logPrices(alignedPrices2);

    // Rolling Hedge Ratio and Z-Score Calculation
    // Following Pear Protocol methodology for statistical arbitrage
    // Uses rolling windows to adapt to changing market conditions
    const barsPerDay = getBarsPerDay(interval);
    const lookbackDays = 30; // Rolling window for Z-score calculation
    const hedgeDays = 30;   // Window for hedge ratio updates
    const lookbackBars = Math.floor(lookbackDays * barsPerDay);
    const hedgeBars = Math.floor(hedgeDays * barsPerDay);

    // Calculate rolling beta (hedge ratio) using recent window
    const hedgeLog1 = logPrices1.slice(-Math.min(logPrices1.length, hedgeBars));
    const hedgeLog2 = logPrices2.slice(-Math.min(logPrices2.length, hedgeBars));

    const olsResult = olsRegression(hedgeLog1, hedgeLog2);
    if (!olsResult || !Number.isFinite(olsResult.slope)) {
        throw new Error('OLS regression failed');
    }

    const hedgeRatio = olsResult.slope;
    const beta = hedgeRatio; // Beta is the rolling hedge ratio per Pear Protocol

    console.log(`Hedge ratio (Beta): ${hedgeRatio.toFixed(6)}`);
    console.log(`OLS R-squared: ${olsResult.rSquared.toFixed(4)}`);
    console.log(`Beta (Rolling Hedge Ratio): ${beta.toFixed(4)}`);

    // Calculate full spread series using the rolling hedge ratio
    const fullSpread: number[] = [];
    const minLength = Math.min(logPrices1.length, logPrices2.length);
    for (let i = 0; i < minLength; i++) {
        const spreadValue = logPrices1[i]! - hedgeRatio * logPrices2[i]!;
        if (Number.isFinite(spreadValue)) {
            fullSpread.push(spreadValue);
        }
    }

    // Rolling Z-score: Use recent window for mean and std deviation
    // This adapts to changing spread dynamics (Pear Protocol approach)
    const rollingSpread = fullSpread.slice(-Math.min(fullSpread.length, lookbackBars));

    if (rollingSpread.length < 10) {
        throw new Error('Insufficient data for rolling Z-score calculation');
    }

    // Calculate rolling mean and standard deviation
    const rollingMean = rollingSpread.reduce((a, b) => a + b, 0) / rollingSpread.length;
    const rollingVariance = rollingSpread.reduce((a, b) => a + (b - rollingMean) ** 2, 0) / (rollingSpread.length - 1);
    const rollingStd = Math.sqrt(rollingVariance);

    // Current spread value (most recent)
    const currentSpread = rollingSpread[rollingSpread.length - 1]!;

    // Rolling Z-score calculation (Pear Protocol methodology)
    const spreadZ = rollingStd > 0 ? (currentSpread - rollingMean) / rollingStd : 0;

    // Calculate spread volatility using LOG RETURNS of spread (per Pear Protocol)
    // σ = √( 1 ÷ (N–1) × Σ ( rᵢ – r̄ )² ) where rᵢ are log returns of spread
    const spreadReturns: number[] = [];
    for (let i = 1; i < rollingSpread.length; i++) {
        const ret = rollingSpread[i]! - rollingSpread[i - 1]!;
        if (Number.isFinite(ret)) {
            spreadReturns.push(ret);
        }
    }

    let spreadVol = 0;
    if (spreadReturns.length >= 5) {
        const meanReturn = spreadReturns.reduce((a, b) => a + b, 0) / spreadReturns.length;
        const variance = spreadReturns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / (spreadReturns.length - 1);
        spreadVol = Math.sqrt(variance);
    }

    console.log(`Spread volatility (log returns): ${spreadVol?.toFixed(6) ?? 'N/A'}`);
    console.log(`Rolling Z-score: ${spreadZ.toFixed(2)} (${getZScoreSignal(spreadZ)})`);

    // Augmented Dickey-Fuller (ADF) test for cointegration
    // Tests if spread series is stationary (mean-reverting)
    // H0: spread has unit root (random walk, not cointegrated)
    // H1: spread is stationary (cointegrated, mean-reverting)
    // p-value < 0.05 suggests cointegration (reject H0)
    const adfResult = adfTest(fullSpread);
    let adfT = adfResult?.testStatistic ?? 0;
    let adfP = adfResult?.pValue ?? null;
    const stationary = adfResult?.isStationary ?? false;
    const halfLife = adfResult?.halfLife ?? null;

    console.log(`ADF test statistic: ${adfT.toFixed(2)}`);
    console.log(`ADF p-value: ${adfP?.toFixed(4) ?? 'N/A'}`);
    console.log(`Stationary (cointegrated): ${stationary}`);
    console.log(`Half-life: ${halfLife?.toFixed(2) ?? 'N/A'} days (${halfLife && halfLife < 60 ? 'Fast' : halfLife && halfLife < 120 ? 'Moderate' : 'Slow'} mean reversion)`);

    // Compute funding differential
    let fundingNet = 0;
    try {
        const fund1 = Number(market1.categories?.metrics?.fundingMean ?? 0);
        const fund2 = Number(market2.categories?.metrics?.fundingMean ?? 0);
        const b = typeof beta === 'number' && Number.isFinite(beta) ? beta : 1;
        // Long pays fund1, short receives fund2; beta-adjusted for proper rolling hedge sizing
        fundingNet = (-fund1) + (b * fund2);
    } catch (e) {
        console.warn('Funding calculation error:', e);
    }

    console.log(`Net funding (annualized): ${(fundingNet * 365 * 24 * 60).toFixed(4)}%`);

    // Compute technical indicators
    const tech1 = computeTechnicalsFromKlines(klines1 as any);
    const tech2 = computeTechnicalsFromKlines(klines2 as any);

    const rsi1 = Number(tech1?.oscillators?.rsi?.value ?? 50);
    const rsi2 = Number(tech2?.oscillators?.rsi?.value ?? 50);

    console.log(`RSI: ${symbol1}=${rsi1.toFixed(1)}, ${symbol2}=${rsi2.toFixed(1)}`);

    // Calculate composite quality score (weighted combination of all factors)
    // Higher scores = better pair trading opportunities
    // Weights prioritize: correlation, spread deviation, cointegration strength,
    //                     mean reversion speed, and technical confirmation
    const corrWeight = 0.25;    // Correlation strength
    const spreadZWeight = 0.25; // Current spread deviation opportunity
    const adfWeight = 0.20;     // Cointegration strength (ADF statistic)
    const halfLifeWeight = -0.10; // Penalize slow mean reversion (negative weight)
    const rsiWeight1 = 0.10;    // RSI positioning (normalized 0-1)
    const rsiWeight2 = 0.10;    // RSI positioning (normalized 0-1)

    const compositeScore = (
        corrWeight * Math.max(0, correlation ?? 0) +
        spreadZWeight * Math.abs(spreadZ) +
        adfWeight * Math.max(-5, Math.min(0, adfT)) +
        halfLifeWeight * (halfLife ? Math.min(halfLife, 100) : 50) +
        rsiWeight1 * (rsi1 / 100) +
        rsiWeight2 * (rsi2 / 100)
    );

    console.log(`Composite score: ${compositeScore.toFixed(4)} (${compositeScore > 0 ? 'Good' : 'Poor'} pair quality)`);

    // Determine trading direction based on spread Z-score
    // Pairs trading logic: Bet against extreme spread deviations
    // If spread Z > 0: spread is wide (overvalued asset up, undervalued asset down)
    //   → Short overvalued, Long undervalued to bet on convergence
    // If spread Z < 0: spread is narrow (undervalued asset up, overvalued asset down)
    //   → Long overvalued, Short undervalued to bet on convergence
    const longSymbol = spreadZ > 0 ? symbol2 : symbol1;
    const shortSymbol = spreadZ > 0 ? symbol1 : symbol2;
    const tradeDirection = spreadZ > 0 ? 'SHORT spread (long undervalued, short overvalued)' : 'LONG spread (long overvalued, short undervalued)';

    // Entry/Exit thresholds per Pear Protocol
    // Traders typically use thresholds: enter at ±2, exit at 0
    const entryThreshold = 2.0;
    const exitThreshold = 0.5;
    const isEntrySignal = Math.abs(spreadZ) >= entryThreshold;
    const isExitSignal = Math.abs(spreadZ) <= exitThreshold;

    // Position sizing per Pear Protocol: β × (Long A) = Short B
    // This ensures the portfolio is beta-neutral
    // Since β < 1 means short asset is LESS volatile, we need MORE capital in short
    // Formula: Short = |β| × Long, but we want equal volatility contribution
    // So: Long / (1 + |β|) and Short = Long × |β| / (1 + |β|) is WRONG
    // Correct: If β = 0.43, short asset moves 0.43x as much, so SHORT needs MORE capital
    // Long_$ × β = Short_$ for equal volatility → Short_$ = Long_$ × β
    // But to equalize: we need to INVERT - put MORE in the less volatile asset
    // Long_$ / |β| = Short_$ means Short gets more when β < 1
    const exampleBankroll = 10000; // Example for display
    const absBeta = Math.abs(beta);
    // Correct formula: Short = Long / |β| for volatility neutrality when β < 1
    // Total = Long + Short = Long + Long/|β| = Long × (1 + 1/|β|)
    // Long = Total / (1 + 1/|β|) = Total × |β| / (|β| + 1)
    // Short = Total / (1 + |β|)
    const longAmount = (exampleBankroll * absBeta) / (1 + absBeta);
    const shortAmount = exampleBankroll / (1 + absBeta);

    console.log(`\n=== TRADING RECOMMENDATION ===`);
    console.log(`Direction: ${tradeDirection}`);
    console.log(`Long: ${longSymbol}`);
    console.log(`Short: ${shortSymbol}`);
    console.log(`Rolling Z-score: ${spreadZ.toFixed(2)} (${Math.abs(spreadZ) > 1.5 ? 'Strong' : Math.abs(spreadZ) > 1.0 ? 'Moderate' : 'Weak'} signal)`);

    console.log(`\n=== ENTRY/EXIT SIGNALS ===`);
    console.log(`Entry threshold: ±${entryThreshold.toFixed(1)} → ${isEntrySignal ? '🟢 ENTRY SIGNAL' : '🔴 No entry signal'}`);
    console.log(`Exit threshold: ±${exitThreshold.toFixed(1)} → ${isExitSignal ? '🟢 EXIT SIGNAL' : '🔴 Hold position'}`);
    console.log(`Current |Z|: ${Math.abs(spreadZ).toFixed(2)}`);

    console.log(`\n=== POSITION SIZING (Beta-Neutral) ===`);
    console.log(`Beta: ${absBeta.toFixed(4)} (${shortSymbol} moves ${absBeta.toFixed(2)}x vs ${longSymbol})`);
    console.log(`Since β < 1, ${shortSymbol} is LESS volatile → needs MORE capital`);
    console.log(`Example with $${exampleBankroll.toLocaleString()} bankroll:`);
    console.log(`  Long ${longSymbol}: $${longAmount.toFixed(2)} (${(longAmount / exampleBankroll * 100).toFixed(1)}%)`);
    console.log(`  Short ${shortSymbol}: $${shortAmount.toFixed(2)} (${(shortAmount / exampleBankroll * 100).toFixed(1)}%)`);
    console.log(`  Ratio Long:Short = ${absBeta.toFixed(4)} : 1`);

    return {
        // ═══════════════════════════════════════════════════════════════
        // PAIR IDENTIFICATION
        // ═══════════════════════════════════════════════════════════════
        pair: {
            symbol1,
            symbol2,
            description: `Statistical arbitrage pair: ${symbol1} (long leg) vs ${symbol2} (short leg)`
        },

        // ═══════════════════════════════════════════════════════════════
        // CORRELATION ANALYSIS
        // Measures the strength and direction of the linear relationship
        // between the hourly price movements of the two assets.
        // Range: -1 (inverse) to +1 (perfect positive correlation)
        // ═══════════════════════════════════════════════════════════════
        correlation: {
            value: correlation ?? 0,
            strength: getCorrelationStrength(correlation),
            description: 'Pearson correlation coefficient of log returns',
            interpretation: (correlation ?? 0) >= 0.6 ? 'Strong co-movement, good for pairs trading' :
                (correlation ?? 0) >= 0.4 ? 'Moderate co-movement, acceptable for pairs trading' :
                    'Weak co-movement, higher tracking error expected'
        },

        // ═══════════════════════════════════════════════════════════════
        // COINTEGRATION ANALYSIS
        // Tests whether the spread between assets is mean-reverting.
        // Uses Augmented Dickey-Fuller (ADF) test.
        // Cointegration ensures spread tends to revert to stable mean.
        // ═══════════════════════════════════════════════════════════════
        cointegration: {
            adfTestStatistic: adfT,
            adfPValue: adfP,
            isCointegrated: stationary,
            halfLifeDays: halfLife,
            description: 'Augmented Dickey-Fuller test for spread stationarity',
            interpretation: stationary
                ? `Spread is stationary (mean-reverting). Half-life: ${halfLife?.toFixed(1)} days`
                : 'Spread is non-stationary (random walk). Pair may not be suitable.'
        },

        // ═══════════════════════════════════════════════════════════════
        // ROLLING Z-SCORE
        // Measures how far the current spread is from its rolling mean,
        // in units of standard deviations. Uses 30-day rolling window.
        // High |Z| → spread is extended, potential mean reversion trade
        // ═══════════════════════════════════════════════════════════════
        rollingZScore: {
            value: spreadZ,
            absValue: Math.abs(spreadZ),
            signal: getZScoreSignal(spreadZ),
            lookbackDays: 30,
            description: 'Rolling Z-score of spread using 30-day window',
            interpretation: Math.abs(spreadZ) >= 2.0
                ? `Extreme deviation (${spreadZ.toFixed(2)}σ). Strong entry signal.`
                : Math.abs(spreadZ) >= 1.5
                    ? `Significant deviation (${spreadZ.toFixed(2)}σ). Moderate entry signal.`
                    : Math.abs(spreadZ) <= 0.5
                        ? `Near equilibrium (${spreadZ.toFixed(2)}σ). Exit zone.`
                        : `Mild deviation (${spreadZ.toFixed(2)}σ). No action recommended.`
        },

        // ═══════════════════════════════════════════════════════════════
        // BETA (ROLLING HEDGE RATIO)
        // Measures how much one asset moves relative to the other.
        // Used to determine position sizing for beta-neutral exposure.
        // β < 1 means short asset is less volatile than long asset.
        // ═══════════════════════════════════════════════════════════════
        beta: {
            value: beta,
            absValue: absBeta,
            description: 'Rolling hedge ratio from OLS regression on 30-day log prices',
            interpretation: absBeta < 1
                ? `${shortSymbol} moves ${(absBeta * 100).toFixed(0)}% as much as ${longSymbol}. Less volatile.`
                : `${shortSymbol} moves ${(absBeta * 100).toFixed(0)}% as much as ${longSymbol}. More volatile.`
        },

        // ═══════════════════════════════════════════════════════════════
        // VOLATILITY
        // Standard deviation of log returns of the spread.
        // Reflects typical magnitude of price swings in the spread.
        // Higher volatility → more opportunity but more risk.
        // ═══════════════════════════════════════════════════════════════
        volatility: {
            spreadVolatility: spreadVol,
            description: 'Standard deviation of spread log returns',
            interpretation: spreadVol > 0.03
                ? 'High volatility - larger swings, more risk'
                : spreadVol > 0.015
                    ? 'Moderate volatility - balanced risk/reward'
                    : 'Low volatility - smaller swings, steadier spread'
        },

        // ═══════════════════════════════════════════════════════════════
        // ENTRY/EXIT SIGNALS (Pear Protocol)
        // Entry: |Z| ≥ 2.0 (spread is 2+ std devs from mean)
        // Exit: |Z| ≤ 0.5 (spread has reverted close to mean)
        // ═══════════════════════════════════════════════════════════════
        signals: {
            entryThreshold,
            exitThreshold,
            isEntrySignal,
            isExitSignal,
            currentAbsZ: Math.abs(spreadZ),
            description: 'Entry/exit thresholds per Pear Protocol methodology',
            action: isEntrySignal
                ? `🟢 ENTER: ${spreadZ > 0 ? 'SHORT' : 'LONG'} spread`
                : isExitSignal
                    ? '🟢 EXIT: Close existing positions'
                    : '🔴 WAIT: No action recommended'
        },

        // ═══════════════════════════════════════════════════════════════
        // POSITION SIZING (Beta-Neutral)
        // Formula: Long:Short ratio = |β| : 1
        // When β < 1, short asset needs MORE capital to equalize volatility
        // This ensures P&L is driven by spread convergence, not market direction
        // ═══════════════════════════════════════════════════════════════
        positionSizing: {
            formula: `Long:Short ratio = |β| : 1 = ${absBeta.toFixed(4)} : 1`,
            exampleBankroll,
            longSymbol,
            longAmount,
            longPercent: (longAmount / exampleBankroll * 100).toFixed(1) + '%',
            shortSymbol,
            shortAmount,
            shortPercent: (shortAmount / exampleBankroll * 100).toFixed(1) + '%',
            description: 'Beta-neutral position sizing for volatility-adjusted exposure',
            interpretation: `Allocate ${(longAmount / exampleBankroll * 100).toFixed(0)}% to ${longSymbol}, ${(shortAmount / exampleBankroll * 100).toFixed(0)}% to ${shortSymbol}`
        },

        // ═══════════════════════════════════════════════════════════════
        // TECHNICAL INDICATORS
        // RSI values for each asset (14-period)
        // Funding rates for carry cost estimation
        // ═══════════════════════════════════════════════════════════════
        technicals: {
            rsi: {
                [symbol1]: rsi1,
                [symbol2]: rsi2,
                description: 'Relative Strength Index (14-period)'
            },
            fundingNet,
            fundingAnnualized: (fundingNet * 365 * 24 * 60).toFixed(4) + '%',
            description: 'Technical indicators and funding rate differential'
        },

        // ═══════════════════════════════════════════════════════════════
        // TRADING RECOMMENDATION
        // Final actionable recommendation based on all analysis
        // ═══════════════════════════════════════════════════════════════
        recommendation: {
            direction: tradeDirection,
            longSymbol,
            shortSymbol,
            signalStrength: Math.abs(spreadZ) > 1.5 ? 'Strong' : Math.abs(spreadZ) > 1.0 ? 'Moderate' : 'Weak',
            action: isEntrySignal
                ? `ENTER: Long ${longSymbol}, Short ${shortSymbol}`
                : isExitSignal
                    ? 'EXIT: Close all positions'
                    : 'WAIT: No trade recommended',
            description: 'Final trading recommendation based on statistical analysis'
        },

        // ═══════════════════════════════════════════════════════════════
        // COMPOSITE SCORE
        // Weighted combination of all quality factors
        // Higher score = better pair trading opportunity
        // ═══════════════════════════════════════════════════════════════
        quality: {
            compositeScore,
            rating: compositeScore > 0 ? 'Good' : 'Poor',
            description: 'Weighted composite score of pair quality factors',
            factors: {
                correlation: '25% weight',
                spreadDeviation: '25% weight',
                cointegration: '20% weight',
                halfLifePenalty: '-10% weight (slower = worse)',
                technicals: '20% weight'
            }
        },

        // ═══════════════════════════════════════════════════════════════
        // METADATA
        // ═══════════════════════════════════════════════════════════════
        metadata: {
            generatedAt: new Date().toISOString(),
            interval,
            candlesUsed: limit,
            rollingWindowDays: 30,
            methodology: 'Pear Protocol Statistical Arbitrage'
        }
    };
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length !== 2) {
        console.error('Usage: node dist/cli/computePair.js SYMBOL1 SYMBOL2');
        console.error('Example: node dist/cli/computePair.js BTCUSDT ETHUSDT');
        process.exit(1);
    }

    const [symbol1, symbol2] = args;

    const baseUrl = process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com';
    const basePath = process.env.ASTER_BASE_PATH || '/fapi/v1';
    const client = new PublicClient(baseUrl, basePath);

    try {
        const result = await computePair(symbol1, symbol2, client);

        // Save detailed results to file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `sim_data/pair-${symbol1}-${symbol2}-${timestamp}.json`;
        await fs.writeFile(filename, JSON.stringify(result, null, 2), 'utf8');
        console.log(`\nDetailed results saved to: ${filename}`);

    } catch (error) {
        console.error('Error computing pair:', error);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
