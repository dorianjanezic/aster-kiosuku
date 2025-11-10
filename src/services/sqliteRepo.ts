import type Database from 'better-sqlite3';

export class SqliteRepo {
    constructor(private db: Database.Database) {}

    insertOrder(event: any): void {
        const stmt = this.db.prepare(`
INSERT OR IGNORE INTO orders (ts, type, symbol, side, status, price, executedQty, orderId, pair_long, pair_short, realizedPnlUsd, raw_json)
VALUES (@ts, @type, @symbol, @side, @status, @price, @executedQty, @orderId, @pair_long, @pair_short, @realizedPnlUsd, @raw_json)
`);
        const payload = {
            ts: Number(event?.ts) || Date.now(),
            type: String(event?.type || ''),
            symbol: event?.data?.symbol ?? null,
            side: event?.data?.side ?? null,
            status: event?.data?.status ?? null,
            price: event?.data?.price ?? null,
            executedQty: event?.data?.executedQty ?? null,
            orderId: event?.data?.orderId ?? event?.orderId ?? null,
            pair_long: event?.data?.pair?.long ?? null,
            pair_short: event?.data?.pair?.short ?? null,
            realizedPnlUsd: event?.data?.realizedPnlUsd ?? null,
            raw_json: JSON.stringify(event)
        };
        stmt.run(payload);
    }

    insertCycle(ts: number, type: string, data: any): void {
        const stmt = this.db.prepare(`
INSERT OR IGNORE INTO cycles (ts, type, data_json) VALUES (?, ?, ?)
`);
        stmt.run(ts, type, JSON.stringify(data));
    }

    insertPortfolioSnapshot(ts: number, phase: 'pre' | 'post' | string, account: any, positions: any[]): void {
        const stmt = this.db.prepare(`
INSERT OR IGNORE INTO portfolio_snapshots (ts, phase, account_json, positions_json) VALUES (?, ?, ?, ?)
`);
        stmt.run(ts, phase, JSON.stringify(account), JSON.stringify(positions));
    }

    upsertActivePair(pairKey: string, long: string, short: string, entry: { time: number; spreadZ?: number | null; halfLife?: number | null }): void {
        const stmt = this.db.prepare(`
INSERT INTO active_pairs (pair_key, long_symbol, short_symbol, entry_time, entry_spread_z, entry_half_life)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(pair_key) DO UPDATE SET long_symbol=excluded.long_symbol, short_symbol=excluded.short_symbol
`);
        stmt.run(pairKey, long, short, entry.time, entry.spreadZ ?? null, entry.halfLife ?? null);
    }

    closeActivePair(pairKey: string, realized?: number | null): void {
        const stmt = this.db.prepare(`
UPDATE active_pairs SET closed_at = ?, realized_pnl_usd = COALESCE(realized_pnl_usd, 0) + COALESCE(?, 0) WHERE pair_key = ?
`);
        stmt.run(Date.now(), realized ?? null, pairKey);
    }

    insertPairsSnapshot(asOf: number, data: any): void {
        const stmt = this.db.prepare(`
INSERT OR REPLACE INTO pairs_snapshot (as_of, data_json) VALUES (?, ?)
`);
        stmt.run(asOf, JSON.stringify(data));
    }

    addRealizedToActivePair(pairKey: string, deltaRealized: number): void {
        const stmt = this.db.prepare(`
UPDATE active_pairs
SET realized_pnl_usd = COALESCE(realized_pnl_usd, 0) + COALESCE(?, 0)
WHERE pair_key = ? AND (closed_at IS NULL)
`);
        stmt.run(deltaRealized ?? 0, pairKey);
    }

    insertPairHistory(pairKey: string, row: {
        ts: number;
        spreadZ?: number | null;
        halfLife?: number | null;
        pnlUsd?: number | null;
        entrySpreadZ?: number | null;
        deltaSpreadZ?: number | null;
        entryHalfLife?: number | null;
        deltaHalfLife?: number | null;
        elapsedMs?: number | null;
    }): void {
        const stmt = this.db.prepare(`
INSERT OR IGNORE INTO pair_state_history (pair_key, ts, spread_z, half_life, pnl_usd, entry_spread_z, delta_spread_z, entry_half_life, delta_half_life, elapsed_ms)
VALUES (@pair_key, @ts, @spread_z, @half_life, @pnl_usd, @entry_spread_z, @delta_spread_z, @entry_half_life, @delta_half_life, @elapsed_ms)
`);
        stmt.run({
            pair_key: pairKey,
            ts: row.ts,
            spread_z: row.spreadZ ?? null,
            half_life: row.halfLife ?? null,
            pnl_usd: row.pnlUsd ?? null,
            entry_spread_z: row.entrySpreadZ ?? null,
            delta_spread_z: row.deltaSpreadZ ?? null,
            entry_half_life: row.entryHalfLife ?? null,
            delta_half_life: row.deltaHalfLife ?? null,
            elapsed_ms: row.elapsedMs ?? null
        });
    }

    insertMarketsSnapshot(asOf: number, data: any): void {
        const stmt = this.db.prepare(`
INSERT OR REPLACE INTO markets_snapshot (as_of, data_json) VALUES (?, ?)
`);
        stmt.run(asOf, JSON.stringify(data));
    }

    insertPairsEvent(ts: number, type: string, data: any): void {
        const stmt = this.db.prepare(`
INSERT INTO pairs_events (ts, type, data_json) VALUES (?, ?, ?)
`);
        stmt.run(ts, type, JSON.stringify(data));
    }

    // Stats lookups
    getLatestPairHistory(pairKey: string): { spreadZ?: number | null; halfLife?: number | null } | null {
        const row = this.db.prepare('SELECT spread_z as spreadZ, half_life as halfLife FROM pair_state_history WHERE pair_key = ? ORDER BY ts DESC LIMIT 1').get(pairKey) as { spreadZ: number | null; halfLife: number | null } | undefined;
        if (!row) return null;
        return { spreadZ: row.spreadZ, halfLife: row.halfLife };
    }

    getLatestPairStatsFromSnapshot(longSymbol: string, shortSymbol: string): { spreadZ?: number | null; halfLife?: number | null } | null {
        const row = this.db.prepare('SELECT data_json FROM pairs_snapshot ORDER BY as_of DESC LIMIT 1').get() as { data_json: string } | undefined;
        if (!row) return null;
        try {
            const data = JSON.parse(row.data_json);
            const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
            const found = pairs.find((p: any) => p?.long === longSymbol && p?.short === shortSymbol);
            if (!found) return null;
            const hz = (found as any)?.cointegration?.halfLife ?? null;
            const sz = (found as any)?.spreadZ ?? null;
            return { spreadZ: sz, halfLife: hz };
        } catch {
            return null;
        }
    }

    // Reads
    getRecentOrders(limit = 100, sinceTs?: number): any[] {
        const where = sinceTs ? 'WHERE ts >= ?' : '';
        const stmt = this.db.prepare(`SELECT raw_json FROM orders ${where} ORDER BY ts DESC LIMIT ?`);
        const rows = sinceTs ? stmt.all(sinceTs, limit) : stmt.all(limit);
        return rows.map((r: any) => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean);
    }

    getLatestMarkets(): any | null {
        const row = this.db.prepare('SELECT as_of as asOf, data_json as json FROM markets_snapshot ORDER BY as_of DESC LIMIT 1').get() as { asOf: number; json: string } | undefined;
        if (!row) return null;
        try { return { asOf: row.asOf, ...(JSON.parse(row.json) || {}) }; } catch { return null; }
    }

    getActivePairsBaseline(): Record<string, { entryTime: number; entrySpreadZ?: number; entryHalfLife?: number | null }> {
        const rows = this.db.prepare('SELECT pair_key, entry_time, entry_spread_z, entry_half_life FROM active_pairs WHERE closed_at IS NULL OR closed_at IS NULL').all() as Array<{ pair_key: string; entry_time: number; entry_spread_z: number | null; entry_half_life: number | null }>;
        const out: Record<string, any> = {};
        for (const r of rows) {
            out[r.pair_key] = { entryTime: r.entry_time, entrySpreadZ: r.entry_spread_z ?? undefined, entryHalfLife: r.entry_half_life ?? null };
        }
        return out;
    }

    getOpenActivePairs(): Array<{ pairKey: string; long: string; short: string; entryTime: number; entrySpreadZ?: number | null; entryHalfLife?: number | null; realizedPnlUsd?: number | null }> {
        const rows = this.db.prepare('SELECT pair_key as pairKey, long_symbol as long, short_symbol as short, entry_time as entryTime, entry_spread_z as entrySpreadZ, entry_half_life as entryHalfLife, realized_pnl_usd as realizedPnlUsd FROM active_pairs WHERE closed_at IS NULL').all() as Array<any>;
        return rows || [];
    }
}


