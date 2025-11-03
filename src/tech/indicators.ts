/**
 * TECHNICAL INDICATORS LIBRARY
 *
 * Comprehensive technical analysis toolkit for trading signals:
 * - Momentum indicators (RSI, MACD, Stochastic)
 * - Trend indicators (ADX, EMA, SMA, VWAP)
 * - Volatility indicators (ATR, Bollinger Bands)
 * - Volume analysis and price action metrics
 *
 * Processes kline data to extract actionable technical signals
 * used in pair trading strategy evaluation and entry/exit decisions.
 */

import { RSI, MACD, BollingerBands, ATR, EMA, ADX, SMA, VWAP } from 'technicalindicators';

type Kline = [number, number, number, number, number, number, number, number, number, number, number];

const lastOf = <T,>(a: T[]): T | undefined => (a && a.length ? a[a.length - 1] : undefined);
const takeLast = <T,>(a: T[], n = 5): T[] => (a && a.length ? a.slice(Math.max(0, a.length - n)) : []);

const slope = (arr?: number[]): number => {
    const a: number[] = Array.isArray(arr) ? arr : [];
    if (a.length < 2) return 0;
    const last = a[a.length - 1] as number;
    const first = a[0] as number;
    return (last - first) / (a.length - 1);
};

export function computeTechnicalsFromKlines(klines: Kline[]) {
    // Coerce to numbers to avoid NaNs when upstream provides strings
    const closes = klines.map(k => Number(k[4]));
    const highs = klines.map(k => Number(k[2]));
    const lows = klines.map(k => Number(k[3]));
    const volumes = klines.map(k => Number(k[5]));

    const rsi = RSI.calculate({ period: 14, values: closes });
    const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
    const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
    const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const ema10 = EMA.calculate({ period: 10, values: closes });
    const ema20 = EMA.calculate({ period: 20, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    const ema100 = EMA.calculate({ period: 100, values: closes });
    const ema200 = EMA.calculate({ period: 200, values: closes });
    const sma20 = SMA.calculate({ period: 20, values: closes });
    const sma50 = SMA.calculate({ period: 50, values: closes });
    const sma100 = SMA.calculate({ period: 100, values: closes });
    const sma200 = SMA.calculate({ period: 200, values: closes });
    const adx = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const vwap = VWAP.calculate({ high: highs, low: lows, close: closes, volume: volumes });

    const macdSeries = {
        macd: takeLast(macd.map(m => m.MACD)),
        signal: takeLast(macd.map(m => m.signal)),
        histogram: takeLast(macd.map(m => m.histogram))
    };
    const bbSeries = {
        upper: takeLast(bb.map(b => b.upper)),
        middle: takeLast(bb.map(b => b.middle)),
        lower: takeLast(bb.map(b => b.lower))
    };
    const adxSeries = {
        adx: takeLast(adx.map(d => d.adx)),
        pdi: takeLast(adx.map(d => d.pdi)),
        mdi: takeLast(adx.map(d => d.mdi))
    };

    const rsiLast5 = takeLast(rsi, 5);
    const macdHistLast5 = takeLast(macd.map(m => (typeof m.histogram === 'number' ? m.histogram : 0)), 5);
    const atrAvg14 = (() => {
        const a = takeLast(atr, 14);
        if (!a.length) return undefined;
        return a.reduce((acc, v) => acc + v, 0) / a.length;
    })();
    const volLatest = lastOf(volumes);
    const volAvg14 = (() => {
        const a = takeLast(volumes, 14);
        if (!a.length) return undefined;
        return a.reduce((acc, v) => acc + v, 0) / a.length;
    })();

    const srWindow = klines.slice(-48);
    const srHighs = srWindow.map(k => k[2]);
    const srLows = srWindow.map(k => k[3]);
    const support = srLows.length ? Math.min(...srLows) : undefined;
    const resistance = srHighs.length ? Math.max(...srHighs) : undefined;

    return {
        trend: {
            ema20: lastOf(ema20),
            ema50: lastOf(ema50),
            ema100: lastOf(ema100),
            ema200: lastOf(ema200)
        },
        oscillators: {
            rsi: { value: lastOf(rsi), slope: slope(rsiLast5) },
            macd: { MACD: lastOf(macd)?.MACD, signal: lastOf(macd)?.signal, histogram: lastOf(macd)?.histogram, histSlope: slope(macdHistLast5) },
            adx: lastOf(adx)
        },
        bands: {
            middle: lastOf(bb)?.middle,
            upper: lastOf(bb)?.upper,
            lower: lastOf(bb)?.lower
        },
        volatility: {
            atr: lastOf(atr),
            atrAvg14
        },
        movingAverages: {
            sma20: lastOf(sma20),
            sma50: lastOf(sma50),
            sma100: lastOf(sma100),
            sma200: lastOf(sma200),
            ema10: lastOf(ema10),
            ema20: lastOf(ema20),
            ema50: lastOf(ema50),
            ema100: lastOf(ema100),
            ema200: lastOf(ema200),
            vwap: lastOf(vwap)
        },
        supportResistance: { support, resistance },
        volume: { latest: volLatest, avg14: volAvg14 },
        series: {
            rsi: rsiLast5,
            macd: macdSeries,
            bb: bbSeries,
            atr: takeLast(atr),
            ema20: takeLast(ema20),
            ema50: takeLast(ema50),
            adx: adxSeries
        }
    };
}


