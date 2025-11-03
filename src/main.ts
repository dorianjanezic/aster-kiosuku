/**
 * MAIN APPLICATION ENTRY POINT
 *
 * This is the central orchestrator for the Aster Trading Agent system.
 * Responsibilities:
 * - Environment configuration loading
 * - Market data initialization and periodic refresh
 * - Trading agent scheduling and execution
 * - System lifecycle management
 */

import { loadConfig } from './config/index.js';
import { PublicClient } from './http/publicClient.js';
import { MarketsService } from './services/marketsService.js';
import { SchedulerLoop } from './scheduler/loop.js';
import { startHttpServer } from './server.js';

async function start() {
    // Initialize environment variables from .env file
    try { (await import('dotenv')).config(); } catch { }

    // Load application configuration (API keys, intervals, URLs)
    const cfg = loadConfig();

    // Initialize HTTP client for exchange communication
    const client = new PublicClient(cfg.asterBaseUrl, cfg.asterBasePath);

    // Initialize market data service for periodic data refresh
    const markets = new MarketsService(client);

    // Perform initial market data refresh and save to disk
    await markets.refreshAndSave('sim_data/markets.json');

    // Set up periodic market data refresh (default: every 24 hours)
    setInterval(() => {
        markets.refreshAndSave('sim_data/markets.json').catch((e) => console.error(e));
    }, cfg.marketsRefreshMs);

    // Start the main trading loop (runs pair trading agent periodically)
    new SchedulerLoop(cfg.loopIntervalMs).start();

    console.log('App started. Loop:', cfg.loopIntervalMs, 'ms. Markets refresh every', cfg.marketsRefreshMs, 'ms');

    // Start lightweight HTTP health server
    try { startHttpServer(); } catch (e) { console.error('Failed to start HTTP server', e); }
}

start().catch((err) => {
    console.error(err);
});

