import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PublicClient } from './http/publicClient.js';

export function startHttpServer(portFromEnv?: number) {
    const app = express();

    // CORS for frontend on Vercel
    const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
    app.use((req: Request, res: Response, next: NextFunction) => {
        res.header('Access-Control-Allow-Origin', allowedOrigin);
        res.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });

    app.get('/healthz', (_req: Request, res: Response) => {
        res.json({
            status: 'ok',
            pid: process.pid,
            uptimeSeconds: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
        });
    });

    // ---------- DB Helper ----------
    async function getDb() {
        const mod = await import('./db/sqlite.js');
        return mod.getDb();
    }

    // ---------- /api/cycles ----------
    const InputCycleEventSchema = z.object({ ts: z.number(), type: z.string(), data: z.unknown() });
    const SlimCycleEventSchema = z.object({ ts: z.number(), type: z.enum(['user', 'decision']), data: z.unknown() });
    app.get('/api/cycles', async (_req: Request, res: Response) => {
        try {
            const db = await getDb();
            const rows = db.prepare('SELECT ts, type, data_json FROM cycles ORDER BY ts DESC LIMIT 500').all() as Array<{ ts: number; type: string; data_json: string }>;
            const events: Array<z.infer<typeof SlimCycleEventSchema>> = rows.flatMap((r) => {
                const data = (() => { try { return JSON.parse(r.data_json); } catch { return null; } })();
                if (r.type === 'user' || r.type === 'user_raw') {
                    const content = typeof (data as any)?.content === 'string' ? (data as any).content : data;
                    return [{ ts: r.ts, type: 'user', data: content } as any];
                }
                if (r.type === 'decision' || r.type === 'assistant_raw') {
                    const decision = (data as any)?.parsed ?? (data as any)?.raw ?? data;
                    return [{ ts: r.ts, type: 'decision', data: decision } as any];
                }
                return [] as any[];
            });
            res.json({ events });
        } catch (e) {
            res.json({ events: [] });
        }
    });

    // ---------- /api/pairs ----------
    const PriceSchema = z.object({ last: z.number().optional(), bestBid: z.number().optional(), bestAsk: z.number().optional(), mid: z.number().optional() });
    const PairSchema = z.object({
        long: z.string(),
        short: z.string(),
        corr: z.number().optional(),
        beta: z.number().optional(),
        hedgeRatio: z.number().optional(),
        cointegration: z.any().optional(),
        spreadZ: z.number().optional(),
        fundingNet: z.number().optional(),
        scores: z.any().optional(),
        notes: z.array(z.string()).optional(),
        sector: z.string().optional(),
        prices: z.object({ long: PriceSchema, short: PriceSchema }).optional()
    });
    const PairsFileSchema = z.object({ asOf: z.number().optional(), pairs: z.array(PairSchema) });
    app.get('/api/pairs', async (_req: Request, res: Response) => {
        try {
            const db = await getDb();
            const row = db.prepare('SELECT data_json FROM pairs_snapshot ORDER BY as_of DESC LIMIT 1').get() as { data_json: string } | undefined;
            const parsed = row ? (() => { try { return JSON.parse(row.data_json); } catch { return { pairs: [] }; } })() : { pairs: [] };
            const data = PairsFileSchema.parse(parsed ?? { pairs: [] });
            res.json(data);
        } catch {
            res.status(500).json({ error: 'Failed to read pairs data' });
        }
    });

    // ---------- /api/portfolio ----------
    app.get('/api/portfolio', async (_req: Request, res: Response) => {
        try {
            const db = await getDb();
            const row = db.prepare('SELECT ts, phase, account_json, positions_json FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1').get() as { ts: number; phase: string; account_json: string; positions_json: string } | undefined;
            if (!row) return res.json({ summary: { baseBalance: Number(process.env.PORTFOLIO_BASE_BALANCE || 10000), totalNotional: 0, totalUpnl: 0, equity: Number(process.env.PORTFOLIO_BASE_BALANCE || 10000) }, positions: [], pairs: [] });
            const account = (() => { try { return JSON.parse(row.account_json); } catch { return null; } })();
            const positionsArr = (() => { try { return JSON.parse(row.positions_json); } catch { return []; } })();
            const rawPositions = Array.isArray(positionsArr) ? positionsArr : [];
            // Best-effort live price refresh for shown positions
            const uniqueSymbols = Array.from(new Set(rawPositions.map((p: any) => p?.symbol).filter(Boolean)));
            const client = new PublicClient(process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com', process.env.ASTER_BASE_PATH || '/fapi/v1');
            const liveMap = new Map<string, number>();
            try {
                for (const s of uniqueSymbols) {
                    try {
                        const t = await client.getTicker(s);
                        if (typeof t?.price === 'number') liveMap.set(s, t.price);
                    } catch { }
                }
            } catch { }
            // Normalize to { symbol, netQty, avgEntry, mid, notional, upnl }
            const positions = rawPositions.map((p: any) => {
                const symbol = p?.symbol;
                const qty = typeof p?.qty === 'number' ? p.qty : (typeof p?.positionAmt === 'number' ? p.positionAmt : 0);
                const direction = p?.direction || p?.positionSide; // LONG/SHORT
                const netQty = direction === 'SHORT' ? -Math.abs(qty) : Math.abs(qty);
                const avgEntry = typeof p?.entryPrice === 'number' ? p.entryPrice : null;
                const mid = liveMap.get(symbol) ?? (typeof p?.mid === 'number' ? p.mid : null);
                const upnl = typeof p?.unrealizedPnl === 'number' && Number.isFinite(p.unrealizedPnl) && mid == null && avgEntry == null
                    ? p.unrealizedPnl
                    : ((avgEntry != null && mid != null) ? (mid - avgEntry) * netQty : 0);
                const notional = (mid != null) ? Math.abs(netQty) * mid : null;
                return { symbol, netQty, avgEntry, mid, notional, upnl };
            });
            const totalNotional = positions.reduce((a: number, p: any) => a + (p?.notional ?? 0), 0);
            const totalUpnl = positions.reduce((a: number, p: any) => a + (p?.upnl ?? 0), 0);
            const startingBalance = Number(process.env.PORTFOLIO_BASE_BALANCE || 10000);
            const base = (typeof account?.balanceUsd === 'number') ? account.balanceUsd : startingBalance;
            const equity = base + totalUpnl;
            res.json({ summary: { baseBalance: startingBalance, balance: base, totalNotional, totalUpnl, equity }, positions, pairs: [] });
        } catch {
            res.status(500).json({ error: 'Failed to compute portfolio' });
        }
    });

    // ---------- /api/orders ----------
    app.get('/api/orders', async (req: Request, res: Response) => {
        try {
            const db = await getDb();
            const limitRaw = (req.query.limit as string) ?? '200';
            const limit = Math.max(1, Math.min(1000, Number(limitRaw)));
            const rows = db.prepare('SELECT raw_json FROM orders ORDER BY ts DESC LIMIT ?').all(limit) as Array<{ raw_json: string }>;
            const events = rows.map(r => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter(Boolean);
            res.json({ events });
        } catch {
            res.status(500).json({ error: 'Failed to read orders data' });
        }
    });

    // ---------- /api/markets ----------
    app.get('/api/markets', async (req: Request, res: Response) => {
        try {
            const db = await getDb();
            const row = db.prepare('SELECT as_of as asOf, data_json FROM markets_snapshot ORDER BY as_of DESC LIMIT 1').get() as { asOf: number; data_json: string } | undefined;
            if (!row) return res.json({ asOf: Date.now(), markets: [] });
            const data = (() => { try { return JSON.parse(row.data_json); } catch { return { markets: [] }; } })();
            return res.json({ asOf: row.asOf, markets: Array.isArray(data?.markets) ? data.markets : [] });
        } catch {
            res.status(500).json({ error: 'Failed to read markets' });
        }
    });

    const port = portFromEnv ?? (process.env.PORT ? Number(process.env.PORT) : 3000);
    return app.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`HTTP server listening on ${port}`);
    });
}


