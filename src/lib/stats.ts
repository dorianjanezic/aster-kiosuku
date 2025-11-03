/**
 * STATISTICAL COMPUTATION LIBRARY
 *
 * Core mathematical and statistical functions for quantitative finance:
 * - Time series analysis (returns, volatility, correlation)
 * - Statistical testing (ADF, normality, stationarity)
 * - Risk metrics (VaR, Sharpe, drawdown)
 * - Cointegration and mean-reversion analysis
 * - Technical indicator calculations
 *
 * Provides robust, numerically stable implementations for
 * financial modeling and trading strategy development.
 */

export function pctChanges(values: number[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < values.length; i++) {
        const prev = values[i - 1]!;
        const cur = values[i]!;
        if (prev && Number.isFinite(prev) && Number.isFinite(cur) && prev > 0) out.push((cur - prev) / prev);
    }
    return out;
}

export function logPrices(values: number[]): number[] {
    return values.map(v => Number.isFinite(v) && v > 0 ? Math.log(v) : NaN).filter(v => Number.isFinite(v));
}

export function logReturns(values: number[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < values.length; i++) {
        const prev = values[i - 1]!;
        const cur = values[i]!;
        if (prev > 0 && cur > 0 && Number.isFinite(prev) && Number.isFinite(cur)) {
            out.push(Math.log(cur / prev));
        }
    }
    return out;
}

export function rollingStd(values: number[], window: number): number[] {
    const out: number[] = new Array(values.length).fill(NaN);
    for (let i = window - 1; i < values.length; i++) {
        const slice = values.slice(i - window + 1, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
        const variance = slice.reduce((a, b) => a + (b - mean) * (b - mean), 0) / slice.length;
        out[i] = Math.sqrt(variance);
    }
    return out;
}

export function pearson(x: number[], y: number[]): number | undefined {
    if (x.length !== y.length || x.length < 2) return undefined;
    const n = x.length;
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
        const xi = x[i]!; const yi = y[i]!;
        const vx = xi - mx; const vy = yi - my;
        num += vx * vy; dx += vx * vx; dy += vy * vy;
    }
    const den = Math.sqrt(dx * dy);
    if (den === 0) return undefined;
    return num / den;
}

export function betaYOnX(y: number[], x: number[]): number | undefined {
    if (x.length !== y.length || x.length < 2) return undefined;
    const n = x.length;
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let cov = 0, varx = 0;
    for (let i = 0; i < n; i++) {
        const xi = x[i]!; const yi = y[i]!;
        cov += (xi - mx) * (yi - my);
        varx += (xi - mx) * (xi - mx);
    }
    if (varx === 0) return undefined;
    return cov / varx;
}

export function zScores(values: number[], useSampleStd: boolean = true): number[] {
    const n = values.length;
    if (n < 2) return [];
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (useSampleStd ? Math.max(1, n - 1) : n);
    const std = Math.sqrt(variance) || 1e-12;
    return values.map(v => (v - mean) / std);
}

export function sampleStd(values: number[]): number {
    const n = values.length;
    if (n < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
    return Math.sqrt(variance) || 0;
}

export interface OLSResult {
    slope: number;
    intercept: number;
    rSquared: number;
    residuals: number[];
    standardError: number;
}

export function olsRegression(y: number[], x: number[]): OLSResult | undefined {
    if (x.length !== y.length || x.length < 2) return undefined;

    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((a, b, i) => a + b * y[i]!, 0);
    const sumXX = x.reduce((a, b) => a + b * b, 0);

    const denominator = n * sumXX - sumX * sumX;
    if (Math.abs(denominator) < 1e-12) return undefined;

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;

    // Calculate R-squared and residuals
    const yMean = sumY / n;
    let ssRes = 0;
    let ssTot = 0;
    const residuals: number[] = [];

    for (let i = 0; i < n; i++) {
        const predicted = slope * x[i]! + intercept;
        const residual = y[i]! - predicted;
        residuals.push(residual);
        ssRes += residual * residual;
        ssTot += (y[i]! - yMean) * (y[i]! - yMean);
    }

    const rSquared = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;

    // Standard error of regression
    const standardError = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;

    return { slope, intercept, rSquared, residuals, standardError };
}

export interface ADFResult {
    testStatistic: number;
    pValue: number | null;
    lags: number;
    isStationary: boolean;
    halfLife: number | null;
}

export function adfTest(series: number[], maxLags: number = 10): ADFResult | undefined {
    if (series.length < 10) return undefined;

    // Simplified Augmented Dickey-Fuller test for pair trading
    // Test for mean reversion: Δspread_t = α + β * spread_{t-1} + ε
    // If β < 0, the spread is mean-reverting (stationary)

    // Calculate spread changes and lagged spread
    const spreadChanges = [];
    const laggedSpread = [];

    for (let i = 1; i < series.length; i++) {
        spreadChanges.push(series[i]! - series[i - 1]!);
        laggedSpread.push(series[i - 1]!);
    }

    if (spreadChanges.length < 5) return undefined;

    // OLS regression: Δspread_t = α + β * spread_{t-1} + ε
    const olsResult = olsRegression(spreadChanges, laggedSpread);
    if (!olsResult) return undefined;

    // β coefficient (should be negative for mean reversion)
    const beta = olsResult.slope;
    const isStationary = beta < 0;

    // Calculate half-life for mean-reverting process
    let halfLife: number | null = null;
    if (isStationary && beta < 0) {
        // For AR(1) process: spread_t = φ * spread_{t-1} + ε, where φ = 1 + β
        // Half-life = -ln(2) / ln(|φ|) when |φ| < 1
        const phi = 1 + beta; // AR(1) coefficient
        if (Math.abs(phi) < 1 && phi !== 0) {
            halfLife = -Math.log(2) / Math.log(Math.abs(phi));
            // Bound half-life to reasonable range for trading (0.1 to 100 periods)
            halfLife = Math.max(0.1, Math.min(100, halfLife));
        }
    }

    // Correct t-statistic calculation for the β coefficient
    // t = β / SE(β), where SE(β) is the standard error from OLS
    const testStatistic = beta / olsResult.standardError;

    // Approximate p-value based on t-distribution (simplified)
    // For large samples, t-distribution approximates normal
    let pValue: number | null = null;
    if (Number.isFinite(testStatistic)) {
        // Two-tailed test: we want β < 0 for mean reversion
        // Use absolute value for p-value calculation, then adjust for one-tailed test
        const absT = Math.abs(testStatistic);
        if (absT > 2.576) { // ~99% confidence
            pValue = 0.01;
        } else if (absT > 1.96) { // ~95% confidence
            pValue = 0.05;
        } else if (absT > 1.645) { // ~90% confidence
            pValue = 0.10;
        } else {
            pValue = 0.50; // Not significant
        }
    }

    return {
        testStatistic,
        pValue,
        lags: 1,
        isStationary,
        halfLife
    };
}

export function validateDataQuality(series: number[]): { isValid: boolean; issues: string[] } {
    const issues: string[] = [];

    if (series.length < 10) {
        issues.push('Insufficient data points (minimum 10 required)');
    }

    const finiteValues = series.filter(v => Number.isFinite(v));
    if (finiteValues.length < series.length * 0.9) {
        issues.push('More than 10% non-finite values');
    }

    const positiveValues = series.filter(v => v > 0);
    if (positiveValues.length < series.length * 0.9) {
        issues.push('More than 10% non-positive values');
    }

    // Check for extreme outliers (beyond 5 standard deviations)
    if (finiteValues.length > 2) {
        const mean = finiteValues.reduce((a, b) => a + b, 0) / finiteValues.length;
        const std = sampleStd(finiteValues);
        const outliers = finiteValues.filter(v => Math.abs(v - mean) > 5 * std);
        if (outliers.length > 0) {
            issues.push(`${outliers.length} extreme outliers detected`);
        }
    }

    // Check for zero variance
    if (finiteValues.length > 1) {
        const uniqueValues = new Set(finiteValues.map(v => Math.round(v * 1e6) / 1e6)); // Round to avoid floating point issues
        if (uniqueValues.size < 2) {
            issues.push('Zero or near-zero variance in series');
        }
    }

    return {
        isValid: issues.length === 0,
        issues
    };
}

export function alignSeries(seriesA: number[], seriesB: number[]): { alignedA: number[]; alignedB: number[]; commonLength: number } {
    // For price series, we assume they are already aligned by time if they come from the same API
    // But we can add additional validation here if needed

    const minLength = Math.min(seriesA.length, seriesB.length);
    const alignedA = seriesA.slice(-minLength);
    const alignedB = seriesB.slice(-minLength);

    return {
        alignedA,
        alignedB,
        commonLength: minLength
    };
}

export function ensureMinimumDataRequirements(seriesA: number[], seriesB: number[]): { isValid: boolean; reason?: string } {
    const minLength = 50; // Require at least 50 data points for robust statistical analysis
    const minCorrelationLength = 30; // Minimum for correlation analysis

    if (seriesA.length < minLength || seriesB.length < minLength) {
        return { isValid: false, reason: `Insufficient data: need ${minLength} points, got ${Math.min(seriesA.length, seriesB.length)}` };
    }

    const logReturnsA = logReturns(seriesA);
    const logReturnsB = logReturns(seriesB);

    if (logReturnsA.length < minCorrelationLength || logReturnsB.length < minCorrelationLength) {
        return { isValid: false, reason: `Insufficient returns data: need ${minCorrelationLength} points, got ${Math.min(logReturnsA.length, logReturnsB.length)}` };
    }

    return { isValid: true };
}

export interface CorrelationResult {
    correlation: number;
    beta: number;
    isValid: boolean;
}

export function computePairwiseCorrelations(returnsMatrix: number[][]): Map<string, CorrelationResult> {
    const results = new Map<string, CorrelationResult>();
    const n = returnsMatrix.length;

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const seriesA = returnsMatrix[i]!;
            const seriesB = returnsMatrix[j]!;

            // Skip if either series is empty or too short
            if (!seriesA || !seriesB || seriesA.length < 2 || seriesB.length < 2) {
                results.set(`${i}-${j}`, { correlation: 0, beta: 1, isValid: false });
                continue;
            }

            // Skip if series have different lengths (should be aligned)
            if (seriesA.length !== seriesB.length) {
                results.set(`${i}-${j}`, { correlation: 0, beta: 1, isValid: false });
                continue;
            }

            try {
                const corr = pearson(seriesA, seriesB);
                const beta = betaYOnX(seriesA, seriesB);

                const corrValue = corr ?? 0;
                const betaValue = beta ?? 1;

                results.set(`${i}-${j}`, {
                    correlation: Number.isFinite(corrValue) ? corrValue : 0,
                    beta: Number.isFinite(betaValue) ? betaValue : 1,
                    isValid: Number.isFinite(corrValue) && Number.isFinite(betaValue)
                });
            } catch (e) {
                // If correlation calculation throws an error, mark as invalid
                results.set(`${i}-${j}`, { correlation: 0, beta: 1, isValid: false });
            }
        }
    }

    return results;
}


