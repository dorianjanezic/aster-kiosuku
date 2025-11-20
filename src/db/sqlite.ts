import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';

let dbInstance: Database.Database | undefined;

function getDbPath(): string {
    const base = process.env.DB_PATH || path.join(process.cwd(), 'sim_data', 'state.db');
    return base;
}

async function ensureSchema(db: Database.Database): Promise<void> {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    // Prefer project schema file when available
    const candidates = [
        path.join(process.cwd(), 'docs', 'sqlite-schema.sql'),
        path.join(process.cwd(), '..', '..', 'docs', 'sqlite-schema.sql')
    ];
    let schemaSql: string | undefined;
    for (const p of candidates) {
        try {
            schemaSql = await fs.readFile(p, 'utf8');
            break;
        } catch { }
    }
    if (!schemaSql) {
        schemaSql = `
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  symbol TEXT,
  side TEXT,
  status TEXT,
  price REAL,
  executedQty REAL,
  orderId TEXT,
  pair_long TEXT,
  pair_short TEXT,
  realizedPnlUsd REAL,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_ts ON orders(ts);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  phase TEXT NOT NULL,
  account_json TEXT NOT NULL,
  positions_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_portfolio_ts ON portfolio_snapshots(ts);

CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cycles_ts ON cycles(ts);
CREATE INDEX IF NOT EXISTS idx_cycles_type_ts ON cycles(type, ts);

CREATE TABLE IF NOT EXISTS active_pairs (
  pair_key TEXT PRIMARY KEY,
  long_symbol TEXT NOT NULL,
  short_symbol TEXT NOT NULL,
  direction TEXT NOT NULL,    -- 'FIRST_LONG' or 'SECOND_LONG'
  entry_time INTEGER NOT NULL,
  entry_spread_z REAL,
  entry_half_life REAL,
  closed_at INTEGER,
  realized_pnl_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_active_pairs_open ON active_pairs(closed_at);

CREATE TABLE IF NOT EXISTS pair_state_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_key TEXT NOT NULL,
  ts INTEGER NOT NULL,
  spread_z REAL,
  half_life REAL,
  pnl_usd REAL,
  entry_spread_z REAL,
  delta_spread_z REAL,
  entry_half_life REAL,
  delta_half_life REAL,
  elapsed_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pair_history_pair_ts ON pair_state_history(pair_key, ts);

CREATE TABLE IF NOT EXISTS pairs_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairs_snapshot_as_of ON pairs_snapshot(as_of);

CREATE TABLE IF NOT EXISTS markets_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_markets_snapshot_as_of ON markets_snapshot(as_of);
CREATE TABLE IF NOT EXISTS pairs_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL
);
`;
    }
    db.exec(schemaSql);
    // Ensure auxiliary tables that may not be present in docs schema
    try {
        db.exec(`
CREATE TABLE IF NOT EXISTS pairs_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL
);
`);
    } catch { }
    // Idempotency/uniques
    try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique ON orders(ts, type, COALESCE(orderId, ""))'); } catch { }
    try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_unique ON portfolio_snapshots(ts, phase)'); } catch { }
    try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pairs_snapshot_asof ON pairs_snapshot(as_of)'); } catch { }
    try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_snapshot_asof ON markets_snapshot(as_of)'); } catch { }
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_pairs_events_type_ts ON pairs_events(type, ts)'); } catch { }
}

export async function getDb(): Promise<Database.Database> {
    if (dbInstance) return dbInstance;
    const dbPath = getDbPath();
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    await ensureSchema(db);
    dbInstance = db;
    return db;
}

export function closeDb(): void {
    if (!dbInstance) return;
    try { dbInstance.close(); } catch { }
    dbInstance = undefined;
}


