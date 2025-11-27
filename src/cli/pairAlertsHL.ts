/**
 * HYPERLIQUID PAIR ALERTS
 * 
 * Scans pairs and sends Telegram alerts for trading signals.
 * Designed to run as a cron job (e.g., every hour).
 * 
 * Features:
 * - Scans predefined watchlist using Hyperliquid data
 * - Sends Telegram alerts for ENTRY and EXIT signals
 * - Tracks alert history to avoid duplicate notifications
 * - Configurable thresholds and watchlist
 * 
 * Usage: pnpm alerts:pairs:hl
 * 
 * Environment variables:
 * - TELEGRAM_BOT_TOKEN: Telegram bot token
 * - TELEGRAM_TARGET_CHAT_ID: Chat ID to send alerts to
 * - SCAN_WATCHLIST: Comma-separated pairs (e.g., "BTC:ETH,HYPE:ASTER")
 * - ALERT_COOLDOWN_HOURS: Hours between duplicate alerts (default: 4)
 */

import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
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

const log = createDebug('agent:pair-alerts');

/**
 * Simple RSI calculation (14-period)
 * Using Wilder's smoothing method
 */
function calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50;

    const changes: number[] = [];
    for (let i = 1; i < prices.length; i++) {
        changes.push(prices[i]! - prices[i - 1]!);
    }

    const recentChanges = changes.slice(-period * 2);
    
    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 0; i < Math.min(period, recentChanges.length); i++) {
        const change = recentChanges[i]!;
        if (change > 0) avgGain += change;
        else avgLoss += Math.abs(change);
    }
    avgGain /= period;
    avgLoss /= period;

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
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

interface AlertConfig {
    interval: string;
    // Multi-timeframe windows (in days)
    cointegrationDays: number;  // Long-term: for ADF test (90 days)
    zScoreDays: number;         // Medium-term: for Z-score (30 days)
    hedgeRatioDays: number;     // Short-term: for position sizing (7 days)
    correlationDays: number;    // Medium-term: for correlation (30 days)
    // Thresholds
    entryThreshold: number;
    exitThreshold: number;
    cooldownHours: number;
}

const CONFIG: AlertConfig = {
    interval: process.env.PAIRS_INTERVAL || '1h',
    // Multi-timeframe windows per Pear Protocol methodology
    cointegrationDays: Number(process.env.COINTEGRATION_DAYS || '90'),
    zScoreDays: Number(process.env.ZSCORE_DAYS || '30'),
    hedgeRatioDays: Number(process.env.HEDGE_RATIO_DAYS || '7'),
    correlationDays: Number(process.env.CORRELATION_DAYS || '30'),
    // Thresholds
    entryThreshold: 2.0,
    exitThreshold: 0.5,
    cooldownHours: Number(process.env.ALERT_COOLDOWN_HOURS || '4'),
};

// Default watchlist (using Hyperliquid asset names)
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
    ['SUI', 'APT'],     // Layer 1 pair
    ['INJ', 'ATOM'],    // Cosmos ecosystem
];

const ALERT_HISTORY_PATH = path.resolve(process.cwd(), 'sim_data/alert_history.json');

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface AlertHistory {
    [pairKey: string]: {
        lastAlertTime: number;
        lastAction: string;
        lastZScore: number;
    };
}

interface PairSignal {
    pair: [string, string];
    action: 'ENTER' | 'EXIT' | 'WATCH';
    direction: 'LONG' | 'SHORT';
    longSymbol: string;
    shortSymbol: string;
    // Multi-timeframe metrics
    rollingZScore: {
        value: number;
        windowDays: number;
    };
    fullZScore: {
        value: number;
        windowDays: number;
    };
    correlation: {
        value: number;
        windowDays: number;
    };
    hedgeRatio: {
        value: number;
        rSquared: number;
        windowDays: number;
    };
    cointegration: {
        isCointegrated: boolean;
        halfLifeDays: number | null;
        windowDays: number;
    };
    rsi: {
        [symbol: string]: number;
    };
    positionSizing: {
        longPercent: number;
        shortPercent: number;
    };
}

// ═══════════════════════════════════════════════════════════════
// ALERT HISTORY MANAGEMENT
// ═══════════════════════════════════════════════════════════════

async function loadAlertHistory(): Promise<AlertHistory> {
    try {
        const data = await fs.readFile(ALERT_HISTORY_PATH, 'utf-8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

async function saveAlertHistory(history: AlertHistory): Promise<void> {
    await fs.writeFile(ALERT_HISTORY_PATH, JSON.stringify(history, null, 2));
}

function shouldSendAlert(
    pairKey: string,
    action: string,
    history: AlertHistory,
    cooldownHours: number
): boolean {
    const entry = history[pairKey];
    if (!entry) return true;

    const hoursSinceLastAlert = (Date.now() - entry.lastAlertTime) / (1000 * 60 * 60);
    
    // Always alert if action changed (e.g., from WAIT to ENTER)
    if (entry.lastAction !== action) return true;
    
    // Respect cooldown for same action
    return hoursSinceLastAlert >= cooldownHours;
}

// ═══════════════════════════════════════════════════════════════
// TELEGRAM MESSAGING
// ═══════════════════════════════════════════════════════════════

async function sendTelegramMessage(message: string): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_TARGET_CHAT_ID;

    if (!botToken || !chatId) {
        console.log('⚠️ Telegram not configured. Message would be:');
        console.log(message);
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Telegram API error: ${error}`);
        }

        log('Telegram message sent successfully');
    } catch (error) {
        console.error('Failed to send Telegram message:', error);
    }
}

function formatAlertMessage(signals: PairSignal[], config: AlertConfig): string {
    const lines: string[] = [
        '🚨 *PAIR TRADING ALERTS*',
        ''
    ];

    // Entry signals
    const entrySignals = signals.filter(s => s.action === 'ENTER');
    if (entrySignals.length > 0) {
        lines.push('*🟢 ENTRY SIGNALS:*');
        for (const s of entrySignals) {
            lines.push(`\n*${s.pair[0]}/${s.pair[1]}*`);
            lines.push(`• Roll-Z(${s.rollingZScore.windowDays}d): \`${s.rollingZScore.value.toFixed(2)}\` ${Math.abs(s.rollingZScore.value) >= 2 ? '🔥' : ''}`);
            lines.push(`• Full-Z(${s.fullZScore.windowDays}d): \`${s.fullZScore.value.toFixed(2)}\``);
            lines.push(`• Direction: ${s.direction} spread`);
            lines.push(`• Long: ${s.longSymbol} (${s.positionSizing.longPercent.toFixed(0)}%)`);
            lines.push(`• Short: ${s.shortSymbol} (${s.positionSizing.shortPercent.toFixed(0)}%)`);
            lines.push(`• β(${s.hedgeRatio.windowDays}d): ${s.hedgeRatio.value.toFixed(3)} | R²: ${s.hedgeRatio.rSquared.toFixed(2)}`);
            lines.push(`• Corr: ${s.correlation.value.toFixed(2)} | Coint: ${s.cointegration.isCointegrated ? '✅' : '❌'} | HL: ${s.cointegration.halfLifeDays?.toFixed(0) ?? 'N/A'}d`);
        }
    }

    // Watch signals (approaching entry)
    const watchSignals = signals.filter(s => s.action === 'WATCH');
    
    // If no entry signals, show the BEST watch signal with full details
    if (entrySignals.length === 0 && watchSignals.length > 0) {
        // Sort by absolute Z-score (closest to entry threshold)
        const sortedWatch = [...watchSignals].sort((a, b) => Math.abs(b.rollingZScore.value) - Math.abs(a.rollingZScore.value));
        const best = sortedWatch[0]!;
        
        lines.push('*🟡 BEST WATCH (no entries):*');
        lines.push(`\n*${best.pair[0]}/${best.pair[1]}*`);
        lines.push(`• Roll-Z(${best.rollingZScore.windowDays}d): \`${best.rollingZScore.value.toFixed(2)}\` (entry at ±2.0)`);
        lines.push(`• Full-Z(${best.fullZScore.windowDays}d): \`${best.fullZScore.value.toFixed(2)}\``);
        lines.push(`• Direction: ${best.direction} spread`);
        lines.push(`• Long: ${best.longSymbol} (${best.positionSizing.longPercent.toFixed(0)}%)`);
        lines.push(`• Short: ${best.shortSymbol} (${best.positionSizing.shortPercent.toFixed(0)}%)`);
        lines.push(`• β(${best.hedgeRatio.windowDays}d): ${best.hedgeRatio.value.toFixed(3)} | R²: ${best.hedgeRatio.rSquared.toFixed(2)}`);
        lines.push(`• Corr: ${best.correlation.value.toFixed(2)} | Coint: ${best.cointegration.isCointegrated ? '✅' : '❌'} | HL: ${best.cointegration.halfLifeDays?.toFixed(0) ?? 'N/A'}d`);
        
        // Also show other watch signals as a list
        if (sortedWatch.length > 1) {
            lines.push('\n*Other approaching:*');
            for (const s of sortedWatch.slice(1, 4)) { // Show up to 3 more
                lines.push(`• ${s.pair[0]}/${s.pair[1]}: Roll-Z=${s.rollingZScore.value.toFixed(2)}`);
            }
        }
    } else if (watchSignals.length > 0) {
        // If there are entry signals, just show watch list briefly
        lines.push('\n*🟡 APPROACHING:*');
        for (const s of watchSignals) {
            lines.push(`• ${s.pair[0]}/${s.pair[1]}: Roll-Z=${s.rollingZScore.value.toFixed(2)}`);
        }
    }

    // Exit signals
    const exitSignals = signals.filter(s => s.action === 'EXIT');
    if (exitSignals.length > 0) {
        lines.push('\n*🔴 EXIT (equilibrium):*');
        for (const s of exitSignals) {
            lines.push(`• ${s.pair[0]}/${s.pair[1]}: Roll-Z=${s.rollingZScore.value.toFixed(2)}`);
        }
    }

    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// PAIR SCANNING
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

async function scanPair(
    symbol1: string,
    symbol2: string,
    config: AlertConfig
): Promise<PairSignal | null> {
    const hl = getHyperliquidService();

    try {
        // Calculate required candles for longest timeframe (cointegration = 90 days)
        const barsPerDay = getBarsPerDay(config.interval);
        const requiredCandles = Math.ceil(config.cointegrationDays * barsPerDay) + 50;

        const [candles1, candles2] = await Promise.all([
            hl.getCandlesticks(symbol1, config.interval, requiredCandles),
            hl.getCandlesticks(symbol2, config.interval, requiredCandles)
        ]);

        const prices1 = candles1.map(c => Number(c.close)).filter(n => Number.isFinite(n) && n > 0);
        const prices2 = candles2.map(c => Number(c.close)).filter(n => Number.isFinite(n) && n > 0);

        const dataCheck = ensureMinimumDataRequirements(prices1, prices2);
        if (!dataCheck.isValid) return null;

        const { alignedA: alignedPrices1, alignedB: alignedPrices2 } = alignSeries(prices1, prices2);
        const logPrices1 = logPrices(alignedPrices1);
        const logPrices2 = logPrices(alignedPrices2);

        // ─────────────────────────────────────────────────────────────────
        // MULTI-TIMEFRAME CALCULATIONS
        // ─────────────────────────────────────────────────────────────────
        const cointegrationBars = Math.floor(config.cointegrationDays * barsPerDay);
        const zScoreBars = Math.floor(config.zScoreDays * barsPerDay);
        const hedgeRatioBars = Math.floor(config.hedgeRatioDays * barsPerDay);
        const correlationBars = Math.floor(config.correlationDays * barsPerDay);

        // 1. CORRELATION (30-day window)
        const corrPrices1 = alignedPrices1.slice(-Math.min(alignedPrices1.length, correlationBars));
        const corrPrices2 = alignedPrices2.slice(-Math.min(alignedPrices2.length, correlationBars));
        const returns1 = logReturns(corrPrices1);
        const returns2 = logReturns(corrPrices2);
        const correlation = pearson(returns1, returns2) ?? 0;

        // 2. COINTEGRATION (90-day window)
        const cointegLog1 = logPrices1.slice(-Math.min(logPrices1.length, cointegrationBars));
        const cointegLog2 = logPrices2.slice(-Math.min(logPrices2.length, cointegrationBars));
        const cointegOls = olsRegression(cointegLog1, cointegLog2);
        const cointegBeta = cointegOls?.slope ?? 0;
        
        const cointegSpread: number[] = [];
        const cointegLength = Math.min(cointegLog1.length, cointegLog2.length);
        for (let i = 0; i < cointegLength; i++) {
            const spreadValue = cointegLog1[i]! - cointegBeta * cointegLog2[i]!;
            if (Number.isFinite(spreadValue)) cointegSpread.push(spreadValue);
        }
        
        const adfResult = adfTest(cointegSpread);
        const isCointegrated = adfResult?.isStationary ?? false;
        const halfLife = adfResult?.halfLife ?? null;

        // 3. HEDGE RATIO (7-day window for position sizing)
        const hedgeLog1 = logPrices1.slice(-Math.min(logPrices1.length, hedgeRatioBars));
        const hedgeLog2 = logPrices2.slice(-Math.min(logPrices2.length, hedgeRatioBars));
        const hedgeOls = olsRegression(hedgeLog1, hedgeLog2);
        if (!hedgeOls || !Number.isFinite(hedgeOls.slope)) return null;
        const hedgeRatio = hedgeOls.slope;
        const hedgeRSquared = hedgeOls.rSquared;

        // 4. ROLLING Z-SCORE (30-day window)
        const zScoreLog1 = logPrices1.slice(-Math.min(logPrices1.length, zScoreBars));
        const zScoreLog2 = logPrices2.slice(-Math.min(logPrices2.length, zScoreBars));
        const zScoreOls = olsRegression(zScoreLog1, zScoreLog2);
        const zScoreBeta = zScoreOls?.slope ?? hedgeRatio;
        
        const zScoreSpread: number[] = [];
        const zScoreLength = Math.min(zScoreLog1.length, zScoreLog2.length);
        for (let i = 0; i < zScoreLength; i++) {
            const spreadValue = zScoreLog1[i]! - zScoreBeta * zScoreLog2[i]!;
            if (Number.isFinite(spreadValue)) zScoreSpread.push(spreadValue);
        }
        if (zScoreSpread.length < 10) return null;

        const rollingMean = zScoreSpread.reduce((a, b) => a + b, 0) / zScoreSpread.length;
        const rollingVariance = zScoreSpread.reduce((a, b) => a + (b - rollingMean) ** 2, 0) / (zScoreSpread.length - 1);
        const rollingStd = Math.sqrt(rollingVariance);
        const currentSpreadRolling = zScoreSpread[zScoreSpread.length - 1]!;
        const rollingZ = rollingStd > 0 ? (currentSpreadRolling - rollingMean) / rollingStd : 0;

        // 4b. FULL Z-SCORE (90-day cointegration window)
        const fullMean = cointegSpread.reduce((a, b) => a + b, 0) / cointegSpread.length;
        const fullVariance = cointegSpread.reduce((a, b) => a + (b - fullMean) ** 2, 0) / (cointegSpread.length - 1);
        const fullStd = Math.sqrt(fullVariance);
        const currentSpreadFull = cointegSpread[cointegSpread.length - 1]!;
        const fullZ = fullStd > 0 ? (currentSpreadFull - fullMean) / fullStd : 0;

        // 5. RSI (14-period)
        const rsi1 = calculateRSI(prices1);
        const rsi2 = calculateRSI(prices2);

        // ─────────────────────────────────────────────────────────────────
        // TRADING SIGNALS (use rolling Z-score for signals)
        // ─────────────────────────────────────────────────────────────────
        const absZ = Math.abs(rollingZ);
        const direction: 'LONG' | 'SHORT' = rollingZ > 0 ? 'SHORT' : 'LONG';
        const longSymbol = rollingZ > 0 ? symbol2 : symbol1;
        const shortSymbol = rollingZ > 0 ? symbol1 : symbol2;

        let action: 'ENTER' | 'EXIT' | 'WATCH' = 'WATCH';
        if (absZ >= config.entryThreshold) {
            action = 'ENTER';
        } else if (absZ <= config.exitThreshold) {
            action = 'EXIT';
        } else if (absZ >= 1.5) {
            action = 'WATCH';
        }

        // Position sizing using 7-day hedge ratio
        const absHedgeRatio = Math.abs(hedgeRatio);
        const longPercent = (absHedgeRatio / (1 + absHedgeRatio)) * 100;
        const shortPercent = (1 / (1 + absHedgeRatio)) * 100;

        return {
            pair: [symbol1, symbol2],
            action,
            direction,
            longSymbol,
            shortSymbol,
            rollingZScore: {
                value: rollingZ,
                windowDays: config.zScoreDays
            },
            fullZScore: {
                value: fullZ,
                windowDays: config.cointegrationDays
            },
            correlation: {
                value: correlation,
                windowDays: config.correlationDays
            },
            hedgeRatio: {
                value: hedgeRatio,
                rSquared: hedgeRSquared,
                windowDays: config.hedgeRatioDays
            },
            cointegration: {
                isCointegrated,
                halfLifeDays: halfLife,
                windowDays: config.cointegrationDays
            },
            rsi: {
                [symbol1]: rsi1,
                [symbol2]: rsi2
            },
            positionSizing: {
                longPercent,
                shortPercent
            }
        };

    } catch (error) {
        log('Error scanning %s/%s: %O', symbol1, symbol2, error);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log('🔔 Hyperliquid Pair Alerter starting...\n');
    console.log(`   Timeframes: Cointegration=${CONFIG.cointegrationDays}d | Z-Score=${CONFIG.zScoreDays}d | Hedge=${CONFIG.hedgeRatioDays}d\n`);

    const hl = getHyperliquidService();

    try {
        await hl.initialize();
        console.log(`✅ Connected to Hyperliquid\n`);

        // Parse watchlist
        let watchlist = DEFAULT_WATCHLIST;
        if (process.env.SCAN_WATCHLIST) {
            watchlist = process.env.SCAN_WATCHLIST.split(',').map(p => {
                const [a, b] = p.trim().split(':');
                return [a!, b!] as [string, string];
            });
        }

        // Load alert history
        const history = await loadAlertHistory();

        // Scan all pairs
        const signals: PairSignal[] = [];
        const alertableSignals: PairSignal[] = [];

        for (const [sym1, sym2] of watchlist) {
            const signal = await scanPair(sym1, sym2, CONFIG);
            if (signal) {
                signals.push(signal);

                // Check if we should send an alert
                const pairKey = `${sym1}:${sym2}`;
                if (signal.action !== 'WATCH' || Math.abs(signal.rollingZScore.value) >= 1.5) {
                    if (shouldSendAlert(pairKey, signal.action, history, CONFIG.cooldownHours)) {
                        alertableSignals.push(signal);
                        
                        // Update history
                        history[pairKey] = {
                            lastAlertTime: Date.now(),
                            lastAction: signal.action,
                            lastZScore: signal.rollingZScore.value
                        };
                    }
                }
            }
            await new Promise(r => setTimeout(r, 500));
        }

        // Save updated history
        await saveAlertHistory(history);

        // Determine what to send
        let signalsToSend = [...alertableSignals];
        
        // If no ENTRY signals, always include the best watch signal
        const entrySignals = signals.filter(s => s.action === 'ENTER');
        if (entrySignals.length === 0) {
            // Get all watch signals, sorted by absolute Z-score (closest to entry)
            const watchSignals = signals
                .filter(s => s.action === 'WATCH')
                .sort((a, b) => Math.abs(b.rollingZScore.value) - Math.abs(a.rollingZScore.value));
            
            if (watchSignals.length > 0) {
                // Add top watch signals that aren't already in signalsToSend
                const existingPairs = new Set(signalsToSend.map(s => `${s.pair[0]}:${s.pair[1]}`));
                for (const ws of watchSignals.slice(0, 3)) {
                    const key = `${ws.pair[0]}:${ws.pair[1]}`;
                    if (!existingPairs.has(key)) {
                        signalsToSend.push(ws);
                        existingPairs.add(key);
                    }
                }
                console.log(`\n📊 No entry signals - including top watch signals`);
            }
        }

        // Send alerts if any
        if (signalsToSend.length > 0) {
            const message = formatAlertMessage(signalsToSend, CONFIG);
            await sendTelegramMessage(message);
            console.log(`\n📤 Sent alert with ${signalsToSend.length} signals to Telegram`);
        } else {
            console.log('\n✅ No signals to send');
        }

        // Print summary
        console.log('\n📊 Scan Summary:');
        console.log(`   Total pairs scanned: ${signals.length}`);
        console.log(`   Entry signals: ${signals.filter(s => s.action === 'ENTER').length}`);
        console.log(`   Watch signals: ${signals.filter(s => s.action === 'WATCH').length}`);
        console.log(`   Exit signals: ${signals.filter(s => s.action === 'EXIT').length}`);

        // Save full results
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `sim_data/alerts-hl-${timestamp}.json`;
        await fs.writeFile(filename, JSON.stringify(signals, null, 2));
        console.log(`\n📁 Full results saved to: ${filename}`);

        await hl.disconnect();

    } catch (error) {
        console.error('❌ Alerter error:', error);
        await hl.disconnect();
        process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});

