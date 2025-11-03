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
};

export function loadConfig(): AppConfig {
    return {
        asterBaseUrl: process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com',
        asterBasePath: process.env.ASTER_BASE_PATH || '/fapi/v1',
        marketsRefreshMs: Number(process.env.MARKETS_REFRESH_MS || 24 * 60 * 60 * 1000),
        loopIntervalMs: Number(process.env.LOOP_INTERVAL_MS || 10 * 60 * 1000),
        asterApiKey: process.env.ASTER_API_KEY,
        asterApiSecret: process.env.ASTER_API_SECRET
    };
}

