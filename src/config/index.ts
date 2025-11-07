/**
 * APPLICATION CONFIGURATION
 *
 * Central configuration management for the trading system.
 * Loads environment variables and provides typed configuration
 * for all system components including:
 * - Exchange API endpoints and credentials
 * - Timing intervals for market data and trading cycles
 * - Risk parameters and system settings
 *
 * Ensures consistent configuration across all modules.
 */

export type AppConfig = {
    asterBaseUrl: string;
    asterBasePath: string;
    marketsRefreshMs: number;
    loopIntervalMs: number;
    asterApiKey?: string;
    asterApiSecret?: string;
    // Pair building defaults
    pairs: {
        allowCrossCategory: boolean;
        sideCandidates: number;
        perSector: number;
        pairingMode: 'extremes' | 'corr_first' | 'pool';
        interval: string;
        limit: number;
        minCorr: number;
        maxHalfLifeDays: number;
        fallbackMaxHalfLifeDays: number;
        minSpreadZ: number;
        fallbackMinSpreadZ: number;
        noFilters: boolean;
        weights: { liq: number; vol: number; fund: number; qv: number; rsi: number };
    };
};

export function loadConfig(): AppConfig {
    return {
        asterBaseUrl: process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com',
        asterBasePath: process.env.ASTER_BASE_PATH || '/fapi/v1',
        marketsRefreshMs: Number(process.env.MARKETS_REFRESH_MS || 24 * 60 * 60 * 1000),
        loopIntervalMs: Number(process.env.LOOP_INTERVAL_MS || 10 * 60 * 1000),
        asterApiKey: process.env.ASTER_API_KEY,
        asterApiSecret: process.env.ASTER_API_SECRET,
        pairs: {
            allowCrossCategory: ((process.env.PAIRS_ALLOW_CROSS_CATEGORY || '1').toLowerCase() === '1' || (process.env.PAIRS_ALLOW_CROSS_CATEGORY || '').toLowerCase() === 'true'),
            sideCandidates: Math.max(2, Number(process.env.PAIRS_SIDE_CANDIDATES || '50')),
            perSector: Math.max(1, Number(process.env.PAIRS_PER_SECTOR || '120')),
            pairingMode: (process.env.PAIRS_PAIRING_MODE || 'corr_first').toLowerCase() as any,
            interval: process.env.PAIRS_INTERVAL || '1h',
            limit: Number(process.env.PAIRS_LIMIT || '1200'),
            minCorr: Number(process.env.PAIRS_MIN_CORR || '0.60'),
            maxHalfLifeDays: Number(process.env.PAIRS_MAX_HALFLIFE_DAYS || '40'),
            fallbackMaxHalfLifeDays: Number(process.env.PAIRS_FALLBACK_MAX_HALFLIFE_DAYS || '40'),
            minSpreadZ: Number(process.env.PAIRS_MIN_SPREADZ || '0.5'),
            fallbackMinSpreadZ: Number(process.env.PAIRS_FALLBACK_MIN_SPREADZ || '0.5'),
            noFilters: ((process.env.PAIRS_NO_FILTERS || '').toLowerCase() === '1' || (process.env.PAIRS_NO_FILTERS || '').toLowerCase() === 'true'),
            weights: {
                liq: Number(process.env.PAIRS_W_LIQ || '0.4'),
                vol: Number(process.env.PAIRS_W_VOL || '0.3'),
                fund: Number(process.env.PAIRS_W_FUND || '0.2'),
                qv: Number(process.env.PAIRS_W_QV || '0.1'),
                rsi: Number(process.env.PAIRS_W_RSI || '0.2')
            }
        }
    };
}

export function applyConfigToEnv(cfg: AppConfig): void {
    // Apply pair defaults so existing modules reading process.env keep working
    process.env.PAIRS_ALLOW_CROSS_CATEGORY = cfg.pairs.allowCrossCategory ? '1' : '0';
    process.env.PAIRS_SIDE_CANDIDATES = String(cfg.pairs.sideCandidates);
    process.env.PAIRS_PER_SECTOR = String(cfg.pairs.perSector);
    process.env.PAIRS_PAIRING_MODE = cfg.pairs.pairingMode;
    process.env.PAIRS_INTERVAL = cfg.pairs.interval;
    process.env.PAIRS_LIMIT = String(cfg.pairs.limit);
    process.env.PAIRS_MIN_CORR = String(cfg.pairs.minCorr);
    process.env.PAIRS_MAX_HALFLIFE_DAYS = String(cfg.pairs.maxHalfLifeDays);
    process.env.PAIRS_FALLBACK_MAX_HALFLIFE_DAYS = String(cfg.pairs.fallbackMaxHalfLifeDays);
    process.env.PAIRS_MIN_SPREADZ = String(cfg.pairs.minSpreadZ);
    process.env.PAIRS_FALLBACK_MIN_SPREADZ = String(cfg.pairs.fallbackMinSpreadZ);
    process.env.PAIRS_NO_FILTERS = cfg.pairs.noFilters ? '1' : '0';
    process.env.PAIRS_W_LIQ = String(cfg.pairs.weights.liq);
    process.env.PAIRS_W_VOL = String(cfg.pairs.weights.vol);
    process.env.PAIRS_W_FUND = String(cfg.pairs.weights.fund);
    process.env.PAIRS_W_QV = String(cfg.pairs.weights.qv);
    process.env.PAIRS_W_RSI = String(cfg.pairs.weights.rsi);
}

