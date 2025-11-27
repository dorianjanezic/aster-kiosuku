/**
 * PAIR VISUALIZATION CLI TOOL
 *
 * Generates ASCII charts and data visualizations for pair trading analysis.
 * Creates visual representations of:
 * - Price series comparison
 * - Spread with Z-score bands
 * - Rolling Z-score over time
 * - Entry/Exit signal zones
 *
 * Usage: pnpm build && node dist/cli/visualizePair.js SYMBOL1 SYMBOL2
 */

import 'dotenv/config';
import { promises as fs } from 'fs';
import {
    logPrices,
    logReturns,
    olsRegression,
    alignSeries,
    ensureMinimumDataRequirements,
} from '../lib/stats.js';
import { PublicClient } from '../http/publicClient.js';

function getBarsPerDay(interval: string): number {
    const m = interval.match(/^(\d+)([mhd])$/i);
    if (!m) return 24;
    const n = Number(m[1] || '1');
    const unit = m[2]?.toLowerCase();
    if (!Number.isFinite(n) || n <= 0) return 24;
    switch (unit) {
        case 'm': return (24 * 60) / n;
        case 'h': return 24 / n;
        case 'd': return 1 / n;
        default: return 24;
    }
}

// ASCII chart generator
function generateAsciiChart(
    data: number[],
    title: string,
    width: number = 60,
    height: number = 15,
    options: {
        showBands?: boolean;
        bandLevels?: number[];
        labels?: string[];
    } = {}
): string {
    if (data.length === 0) return 'No data available';

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    // Normalize data to chart height
    const normalize = (val: number) => Math.round(((val - min) / range) * (height - 1));

    // Sample data to fit width
    const step = Math.max(1, Math.floor(data.length / width));
    const sampledData = data.filter((_, i) => i % step === 0).slice(0, width);

    // Create chart grid
    const chart: string[][] = Array(height).fill(null).map(() => Array(width).fill(' '));

    // Plot data points
    sampledData.forEach((val, x) => {
        const y = height - 1 - normalize(val);
        if (y >= 0 && y < height && x < width) {
            chart[y][x] = '█';
        }
    });

    // Add horizontal bands if specified
    if (options.showBands && options.bandLevels) {
        options.bandLevels.forEach(level => {
            const y = height - 1 - normalize(level);
            if (y >= 0 && y < height) {
                for (let x = 0; x < width; x++) {
                    if (chart[y][x] === ' ') {
                        chart[y][x] = '─';
                    }
                }
            }
        });
    }

    // Build output string
    let output = `\n╔${'═'.repeat(width + 2)}╗\n`;
    output += `║ ${title.padEnd(width)} ║\n`;
    output += `╠${'═'.repeat(width + 2)}╣\n`;

    // Y-axis labels
    const yLabels = [max.toFixed(2), ((max + min) / 2).toFixed(2), min.toFixed(2)];

    chart.forEach((row, i) => {
        let label = '';
        if (i === 0) label = yLabels[0].padStart(8);
        else if (i === Math.floor(height / 2)) label = yLabels[1].padStart(8);
        else if (i === height - 1) label = yLabels[2].padStart(8);
        else label = '        ';

        output += `║${label} │${row.join('')}│║\n`;
    });

    output += `╠${'═'.repeat(width + 2)}╣\n`;

    // X-axis labels
    const startLabel = 'Start';
    const endLabel = 'Now';
    const xAxisPadding = width - startLabel.length - endLabel.length;
    output += `║         │${startLabel}${' '.repeat(xAxisPadding)}${endLabel}│║\n`;

    output += `╚${'═'.repeat(width + 2)}╝\n`;

    return output;
}

// Generate sparkline (compact inline chart)
function generateSparkline(data: number[], width: number = 30): string {
    const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    const step = Math.max(1, Math.floor(data.length / width));
    const sampledData = data.filter((_, i) => i % step === 0).slice(0, width);

    return sampledData.map(val => {
        const normalized = (val - min) / range;
        const charIndex = Math.min(chars.length - 1, Math.floor(normalized * chars.length));
        return chars[charIndex];
    }).join('');
}

// Generate Z-score histogram
function generateZScoreHistogram(zScores: number[], width: number = 40): string {
    const bins = [-3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3];
    const counts = new Array(bins.length - 1).fill(0);

    zScores.forEach(z => {
        for (let i = 0; i < bins.length - 1; i++) {
            if (z >= bins[i] && z < bins[i + 1]) {
                counts[i]++;
                break;
            }
        }
    });

    const maxCount = Math.max(...counts);
    const scale = maxCount > 0 ? (width - 10) / maxCount : 1;

    let output = '\n📊 Z-Score Distribution:\n';
    output += '─'.repeat(width) + '\n';

    for (let i = 0; i < counts.length; i++) {
        const binLabel = `${bins[i].toFixed(1)} to ${bins[i + 1].toFixed(1)}`;
        const barLength = Math.round(counts[i] * scale);
        const bar = '█'.repeat(barLength);
        const countStr = counts[i].toString().padStart(4);
        output += `${binLabel.padStart(12)} │${bar.padEnd(width - 18)}${countStr}\n`;
    }

    output += '─'.repeat(width) + '\n';
    return output;
}

async function visualizePair(symbol1: string, symbol2: string): Promise<void> {
    const baseUrl = process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com';
    const basePath = process.env.ASTER_BASE_PATH || '/fapi/v1';
    const http = new PublicClient(baseUrl, basePath);

    const interval = process.env.PAIRS_INTERVAL || '1h';
    const limit = Number(process.env.PAIRS_LIMIT || '750');
    const barsPerDay = getBarsPerDay(interval);
    const lookbackDays = 30;
    const lookbackBars = Math.floor(lookbackDays * barsPerDay);

    console.log(`\n🎨 Generating visualizations for ${symbol1} vs ${symbol2}...`);
    console.log(`   Interval: ${interval}, Candles: ${limit}\n`);

    // Fetch data
    const [klines1, klines2] = await Promise.all([
        http.getKlines(symbol1, interval, limit),
        http.getKlines(symbol2, interval, limit)
    ]);

    const prices1 = klines1.map((k: any) => Number(k[4])).filter((n: any) => Number.isFinite(n) && n > 0);
    const prices2 = klines2.map((k: any) => Number(k[4])).filter((n: any) => Number.isFinite(n) && n > 0);

    const dataReqCheck = ensureMinimumDataRequirements(prices1, prices2);
    if (!dataReqCheck.isValid) {
        throw new Error(`Insufficient data: ${dataReqCheck.reason}`);
    }

    const { alignedA: alignedPrices1, alignedB: alignedPrices2 } = alignSeries(prices1, prices2);

    // Calculate log prices and spread
    const logPrices1 = logPrices(alignedPrices1);
    const logPrices2 = logPrices(alignedPrices2);

    // Calculate hedge ratio
    const hedgeLog1 = logPrices1.slice(-Math.min(logPrices1.length, lookbackBars));
    const hedgeLog2 = logPrices2.slice(-Math.min(logPrices2.length, lookbackBars));
    const olsResult = olsRegression(hedgeLog1, hedgeLog2);
    const hedgeRatio = olsResult?.slope || 1;

    // Calculate spread series
    const spread: number[] = [];
    const minLength = Math.min(logPrices1.length, logPrices2.length);
    for (let i = 0; i < minLength; i++) {
        const spreadValue = logPrices1[i]! - hedgeRatio * logPrices2[i]!;
        if (Number.isFinite(spreadValue)) {
            spread.push(spreadValue);
        }
    }

    // Calculate rolling Z-scores
    const rollingZScores: number[] = [];
    const windowSize = Math.min(lookbackBars, spread.length);

    for (let i = windowSize; i <= spread.length; i++) {
        const window = spread.slice(i - windowSize, i);
        const mean = window.reduce((a, b) => a + b, 0) / window.length;
        const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / (window.length - 1);
        const std = Math.sqrt(variance);
        const z = std > 0 ? (window[window.length - 1]! - mean) / std : 0;
        rollingZScores.push(z);
    }

    // Calculate price ratio
    const priceRatio: number[] = [];
    for (let i = 0; i < minLength; i++) {
        const ratio = alignedPrices1[i]! / alignedPrices2[i]!;
        if (Number.isFinite(ratio)) {
            priceRatio.push(ratio);
        }
    }

    // Current values
    const currentZ = rollingZScores[rollingZScores.length - 1] || 0;
    const currentSpread = spread[spread.length - 1] || 0;
    const currentRatio = priceRatio[priceRatio.length - 1] || 0;

    // Generate visualizations
    console.log('═'.repeat(70));
    console.log('                    📈 PAIR TRADING VISUALIZATION');
    console.log('═'.repeat(70));

    // 1. Price comparison sparklines
    console.log('\n📊 PRICE SPARKLINES (normalized):');
    console.log(`${symbol1}: ${generateSparkline(alignedPrices1, 50)}`);
    console.log(`${symbol2}: ${generateSparkline(alignedPrices2, 50)}`);

    // 2. Price ratio chart
    console.log(generateAsciiChart(
        priceRatio.slice(-200),
        `Price Ratio: ${symbol1}/${symbol2}`,
        50,
        10
    ));

    // 3. Spread chart with Z-score bands
    const spreadMean = spread.slice(-lookbackBars).reduce((a, b) => a + b, 0) / Math.min(lookbackBars, spread.length);
    const spreadStd = Math.sqrt(
        spread.slice(-lookbackBars).reduce((a, b) => a + (b - spreadMean) ** 2, 0) / (Math.min(lookbackBars, spread.length) - 1)
    );

    console.log(generateAsciiChart(
        spread.slice(-200),
        `Spread (log prices) with ±2σ bands`,
        50,
        12,
        {
            showBands: true,
            bandLevels: [
                spreadMean + 2 * spreadStd,
                spreadMean + spreadStd,
                spreadMean,
                spreadMean - spreadStd,
                spreadMean - 2 * spreadStd
            ]
        }
    ));

    // 4. Rolling Z-score chart
    console.log(generateAsciiChart(
        rollingZScores.slice(-200),
        `Rolling Z-Score (30-day window)`,
        50,
        12,
        {
            showBands: true,
            bandLevels: [-2, -1, 0, 1, 2]
        }
    ));

    // 5. Z-score histogram
    console.log(generateZScoreHistogram(rollingZScores, 50));

    // 6. Summary statistics
    console.log('\n📋 SUMMARY STATISTICS:');
    console.log('─'.repeat(50));
    console.log(`Current Rolling Z-Score: ${currentZ.toFixed(4)}`);
    console.log(`Current Spread: ${currentSpread.toFixed(6)}`);
    console.log(`Current Price Ratio: ${currentRatio.toFixed(4)}`);
    console.log(`Hedge Ratio (Beta): ${hedgeRatio.toFixed(4)}`);
    console.log('─'.repeat(50));

    // 7. Signal interpretation
    console.log('\n🎯 SIGNAL INTERPRETATION:');
    if (Math.abs(currentZ) >= 2.0) {
        console.log(`   🟢 STRONG SIGNAL: Z = ${currentZ.toFixed(2)}`);
        console.log(`   → ${currentZ > 0 ? 'SHORT' : 'LONG'} spread recommended`);
    } else if (Math.abs(currentZ) >= 1.5) {
        console.log(`   🟡 MODERATE SIGNAL: Z = ${currentZ.toFixed(2)}`);
        console.log(`   → Consider ${currentZ > 0 ? 'SHORT' : 'LONG'} spread`);
    } else if (Math.abs(currentZ) <= 0.5) {
        console.log(`   ⚪ EXIT ZONE: Z = ${currentZ.toFixed(2)}`);
        console.log(`   → Close existing positions`);
    } else {
        console.log(`   🔴 WEAK SIGNAL: Z = ${currentZ.toFixed(2)}`);
        console.log(`   → No action recommended`);
    }

    // 8. Z-score zones visualization
    console.log('\n📏 Z-SCORE ZONES:');
    const zoneWidth = 40;
    const zPosition = Math.max(-3, Math.min(3, currentZ));
    const zIndex = Math.round(((zPosition + 3) / 6) * zoneWidth);

    let zoneBar = '';
    for (let i = 0; i <= zoneWidth; i++) {
        if (i === zIndex) {
            zoneBar += '▼';
        } else if (i <= zoneWidth * (1/6) || i >= zoneWidth * (5/6)) {
            zoneBar += '█'; // Entry zones (|Z| > 2)
        } else if (i <= zoneWidth * (2/6) || i >= zoneWidth * (4/6)) {
            zoneBar += '▓'; // Watch zones (1 < |Z| < 2)
        } else {
            zoneBar += '░'; // Neutral zone (|Z| < 1)
        }
    }

    console.log(`   -3    -2    -1     0     1     2     3`);
    console.log(`   [${zoneBar}]`);
    console.log(`   ${' '.repeat(zIndex + 3)}↑ Current: ${currentZ.toFixed(2)}`);
    console.log(`   █ Entry Zone  ▓ Watch Zone  ░ Neutral Zone`);

    console.log('\n' + '═'.repeat(70));

    // Save visualization data to file
    const vizData = {
        symbol1,
        symbol2,
        timestamp: new Date().toISOString(),
        interval,
        candles: limit,
        currentZ,
        currentSpread,
        currentRatio,
        hedgeRatio,
        zScoreHistory: rollingZScores.slice(-100),
        spreadHistory: spread.slice(-100),
        priceRatioHistory: priceRatio.slice(-100)
    };

    const filename = `sim_data/viz-${symbol1}-${symbol2}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await fs.writeFile(filename, JSON.stringify(vizData, null, 2), 'utf8');
    console.log(`\n📁 Visualization data saved to: ${filename}`);
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length !== 2) {
        console.error('Usage: node dist/cli/visualizePair.js SYMBOL1 SYMBOL2');
        console.error('Example: node dist/cli/visualizePair.js HYPEUSDT ASTERUSDT');
        process.exit(1);
    }

    const [symbol1, symbol2] = args;

    try {
        await visualizePair(symbol1, symbol2);
    } catch (error) {
        console.error('Error generating visualizations:', error);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

