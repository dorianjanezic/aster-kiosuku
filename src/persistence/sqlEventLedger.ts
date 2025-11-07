import { getDb } from '../db/sqlite.js';
import { SqliteRepo } from '../services/sqliteRepo.js';

export class SqlEventLedger {
    private repoPromise: Promise<SqliteRepo>;
    constructor() {
        this.repoPromise = (async () => new SqliteRepo(await getDb()))();
    }

    async append(type: string, data: unknown): Promise<void> {
        const repo = await this.repoPromise;
        const ts = Date.now();
        // Route to appropriate tables
        if (type === 'order' || type === 'order_plan' || type === 'order_cancelled' || type === 'order_error' || type === 'pair_exit' || type === 'pair_reduce') {
            repo.insertOrder({ ts, type, data });
            return;
        }
        // Pair-building diagnostics → dedicated table
        if (type === 'invalid_pair' || type === 'kline_error' || type === 'invalid_market' || type === 'pairs_error') {
            repo.insertPairsEvent(ts, type, data);
            return;
        }
        if (type === 'portfolio' || type === 'portfolio_pre' || type === 'portfolio_post') {
            const phase = type === 'portfolio' ? 'post' : (type.endsWith('_pre') ? 'pre' : 'post');
            const obj: any = data || {};
            repo.insertPortfolioSnapshot(ts, phase, obj.account ?? obj, obj.positions ?? []);
            return;
        }
        if (type === 'pairs' || type === 'pairs_snapshot') {
            const obj: any = data || {};
            const asOf = Number(obj.asOf) || ts;
            repo.insertPairsSnapshot(asOf, obj);
            return;
        }
        // Default to cycles event
        repo.insertCycle(ts, type, data);
    }
}


