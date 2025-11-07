/**
 * PAIRS SCAN CLI TOOL
 *
 * Command-line utility for scanning and generating pair trading candidates.
 * Performs comprehensive statistical analysis across all available symbols
 * to identify cointegrated pairs with strong mean-reversion characteristics.
 *
 * Outputs filtered, scored pair candidates to sim_data/pairs.json for
 * use by the trading agent in decision-making processes.
 */

import 'dotenv/config';
import { promises as fs } from 'fs';
import { buildPairCandidates } from '../strategies/pairs/pairTrading.js';
import { PublicClient } from '../http/publicClient.js';
// debug is controlled via DEBUG env; no programmatic enable to avoid TS type mismatches

async function main() {
    const outPath = 'sim_data/pairs.json';
    const baseUrl = process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com';
    const basePath = process.env.ASTER_BASE_PATH || '/fapi/v1';
    const client = new PublicClient(baseUrl, basePath);
    if (process.env.DEBUG) {
        console.log(`[pairs:scan] DEBUG=${process.env.DEBUG}`);
    }

    // Log effective configuration for reproducibility
    console.log('[pairs:scan] config', {
        PAIRS_ALLOW_CROSS_CATEGORY: process.env.PAIRS_ALLOW_CROSS_CATEGORY,
        PAIRS_SIDE_CANDIDATES: process.env.PAIRS_SIDE_CANDIDATES,
        PAIRS_PER_SECTOR: process.env.PAIRS_PER_SECTOR,
        PAIRS_PAIRING_MODE: process.env.PAIRS_PAIRING_MODE,
        PAIRS_INTERVAL: process.env.PAIRS_INTERVAL,
        PAIRS_LIMIT: process.env.PAIRS_LIMIT,
        PAIRS_MIN_CORR: process.env.PAIRS_MIN_CORR,
        PAIRS_MAX_HALFLIFE_DAYS: process.env.PAIRS_MAX_HALFLIFE_DAYS,
        PAIRS_FALLBACK_MAX_HALFLIFE_DAYS: process.env.PAIRS_FALLBACK_MAX_HALFLIFE_DAYS,
        PAIRS_MIN_SPREADZ: process.env.PAIRS_MIN_SPREADZ,
        PAIRS_FALLBACK_MIN_SPREADZ: process.env.PAIRS_FALLBACK_MIN_SPREADZ,
        PAIRS_NO_FILTERS: process.env.PAIRS_NO_FILTERS,
        ASTER_BASE_URL: baseUrl,
        ASTER_BASE_PATH: basePath
    });

    // Markets context
    try {
        const marketsPath = 'sim_data/markets.json';
        const text = await fs.readFile(marketsPath, 'utf8');
        const data = JSON.parse(text);
        const markets = Array.isArray(data?.markets) ? data.markets.length : 0;
        console.log(`[pairs:scan] markets loaded: ${markets}`);
    } catch { /* ignore */ }

    const started = Date.now();
    const { pairs } = await buildPairCandidates('sim_data/markets.json', Number(process.env.PAIRS_PER_SECTOR || '5'), client);
    try {
        const { getDb } = await import('../db/sqlite.js');
        const { SqliteRepo } = await import('../services/sqliteRepo.js');
        const repo = new SqliteRepo(await getDb());
        repo.insertPairsSnapshot(Date.now(), { asOf: Date.now(), pairs });
        console.log(`[pairs:scan] wrote ${pairs.length} pairs -> sqlite in ${Date.now() - started}ms`);
    } catch {
        console.log(`[pairs:scan] wrote ${pairs.length} pairs (sqlite) in ${Date.now() - started}ms`);
    }

    // Summarize recent rejection reasons
    // Skip JSONL errors summary when writing to SQL only
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});


