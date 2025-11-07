/**
 * STATE SERVICE
 *
 * Manages trading system state including portfolio positions,
 * account balances, and active pair tracking. Provides real-time
 * state snapshots for decision-making and risk monitoring.
 *
 * Key Features:
 * - Portfolio state aggregation from exchange/simulator
 * - Position tracking with P&L calculations
 * - Active pair state management
 * - State persistence and recovery
 * - Real-time state updates for trading decisions
 */

// import { readLastLines } from '../persistence/jsonlLedger.js';
import type { SimulatedExchange } from '../sim/simulatedExchange.js';

export type SimPosition = {
    positionId: string;
    symbol: string;
    direction: 'LONG' | 'SHORT';
    entryPrice: number;
    qty: number;
    unrealizedPnl?: number;
    leverage?: number;
};

export type SimAccount = {
    balanceUsd: number;
    equityUsd: number;
    unrealizedPnlUsd: number;
    marginUsedUsd: number;
    availableMarginUsd: number;
    openPositionsCount: number;
};

export class StateService {
    constructor(private ordersFile = 'sim_data/orders.jsonl', private sim?: SimulatedExchange) { }

    async getAccountState(): Promise<SimAccount> {
        const baseBalance = 10000;
        const positions = this.sim ? this.sim.listPositions() : [];
        const unrealized = positions.reduce((acc, p) => acc + (p.unrealizedPnl || 0), 0);
        // Sum realized PnL from recent pair_exit events in orders ledger
        let realizedSum = 0;
        try {
            const lines = await this.getRecentOrders(500, 30 * 24 * 60 * 60 * 1000); // last 30 days
            for (const e of lines as any[]) {
                if (e?.type === 'pair_exit' && typeof e?.data?.realizedPnlUsd === 'number') {
                    realizedSum += e.data.realizedPnlUsd;
                }
            }
        } catch { /* ignore */ }
        const equity = baseBalance + realizedSum + unrealized;
        // Approximate margin usage: notional/leverage summed across positions
        const marginUsed = positions.reduce((acc, p: any) => {
            const lev = typeof p.leverage === 'number' && p.leverage > 0 ? p.leverage : 1;
            const price = this.sim ? this.sim.getTicker(p.symbol).price : (p.entryPrice || 0);
            const notional = Math.abs(price * (p.positionAmt || 0));
            return acc + (notional / lev);
        }, 0);
        return {
            balanceUsd: baseBalance + realizedSum,
            equityUsd: equity,
            unrealizedPnlUsd: unrealized,
            marginUsedUsd: marginUsed,
            availableMarginUsd: Math.max(0, equity - marginUsed),
            openPositionsCount: positions.length
        };
    }

    async getRecentOrders(maxLines = 100, maxAgeMs = 10 * 60 * 1000): Promise<Array<unknown>> {
        const cutoff = Date.now() - maxAgeMs;
        try {
            const { getDb } = await import('../db/sqlite.js');
            const { SqliteRepo } = await import('../services/sqliteRepo.js');
            const repo = new SqliteRepo(await getDb());
            const rows = repo.getRecentOrders(maxLines, cutoff);
            return rows;
        } catch {
            return [];
        }
    }
}

