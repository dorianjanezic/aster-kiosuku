/**
 * MARKETS SERVICE
 *
 * Manages market data collection, processing, and persistence.
 * Handles periodic refresh of trading pairs, symbols, and market metadata
 * from the exchange API. Provides unified market data interface for
 * the trading system, ensuring fresh and reliable market information.
 *
 * Key Responsibilities:
 * - Market data fetching and caching
 * - Periodic data refresh scheduling
 * - Market metadata enrichment
 * - Data persistence to disk
 */

// import { promises as fs } from 'fs';
import { PublicClient } from '../http/publicClient.js';
import { fetchConsolidatedMarkets } from '../lib/consolidateMarkets.js';

export class MarketsService {
    constructor(private client: PublicClient) { }

    async refreshAndSave(_filePath: string): Promise<void> {
        const { markets } = await fetchConsolidatedMarkets(this.client);
        const { getDb } = await import('../db/sqlite.js');
        const { SqliteRepo } = await import('./sqliteRepo.js');
        const repo = new SqliteRepo(await getDb());
        repo.insertMarketsSnapshot(Date.now(), { markets });
    }
}

