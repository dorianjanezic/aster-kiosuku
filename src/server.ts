import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

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

    // ---------- Helpers ----------
    const cwd = process.cwd();
    const resolveFromSimData = async (...segments: string[]) => {
        const candidates = [
            path.join(cwd, 'sim_data', ...segments),
        ];
        for (const p of candidates) {
            try { await fs.access(p); return p; } catch {/* try next */ }
        }
        return path.join(cwd, ...segments);
    };

    // ---------- /api/cycles ----------
    const InputCycleEventSchema = z.object({ ts: z.number(), type: z.string(), data: z.unknown() });
    const SlimCycleEventSchema = z.object({ ts: z.number(), type: z.enum(['user', 'decision']), data: z.unknown() });
    app.get('/api/cycles', async (_req: Request, res: Response) => {
        try {
            const filePath = await resolveFromSimData('cycles.jsonl');
            const raw = await fs.readFile(filePath, 'utf8');
            const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const events: Array<z.infer<typeof SlimCycleEventSchema>> = [];
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    const ev = InputCycleEventSchema.parse(parsed);
                    if (ev.type === 'user_raw') {
                        const content = (ev.data as any)?.content;
                        if (typeof content === 'string') events.push({ ts: ev.ts, type: 'user', data: content });
                    } else if (ev.type === 'decision') {
                        const d: any = ev.data;
                        const decision = d?.parsed ?? d?.raw ?? d;
                        events.push({ ts: ev.ts, type: 'decision', data: decision });
                    }
                } catch { }
            }
            res.json({ events });
        } catch (e) {
            res.status(500).json({ error: 'Failed to read cycles data' });
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
            const jsonlPath = await resolveFromSimData('pairs.jsonl');
            const jsonPath = await resolveFromSimData('pairs.json');
            let parsed: any = null;
            try {
                const raw = await fs.readFile(jsonlPath, 'utf8');
                const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
                parsed = last?.data ?? null;
            } catch {
                try { parsed = JSON.parse(await fs.readFile(jsonPath, 'utf8')); } catch { }
            }
            if (!parsed) parsed = { pairs: [] };
            const data = PairsFileSchema.parse(parsed);
            res.json(data);
        } catch {
            res.status(500).json({ error: 'Failed to read pairs data' });
        }
    });

    // ---------- /api/portfolio ----------
    app.get('/api/portfolio', async (_req: Request, res: Response) => {
        try {
            // Prefer latest portfolio snapshot if available
            try {
                const portfolioPath = await resolveFromSimData('portfolio.jsonl');
                const raw = await fs.readFile(portfolioPath, 'utf8');
                const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
                if (last && last.type === 'portfolio' && last.data && typeof last.ts === 'number') {
                    const acc = last.data.account;
                    const positions = Array.isArray(last.data.positions) ? last.data.positions : [];
                    const totalNotional = positions.reduce((a: number, p: any) => a + Math.abs((p?.qty || 0) * (p?.mid || 0)), 0);
                    const totalUpnl = positions.reduce((a: number, p: any) => {
                        const mid = typeof p?.mid === 'number' ? p.mid : null;
                        const entry = typeof p?.entryPrice === 'number' ? p.entryPrice : null;
                        const qty = typeof p?.qty === 'number' ? p.qty : 0;
                        const recomputed = (mid != null && entry != null) ? (mid - entry) * qty : 0;
                        return a + recomputed;
                    }, 0);
                    const startingBalance = Number(process.env.PORTFOLIO_BASE_BALANCE || 10000);
                    return res.json({
                        summary: { baseBalance: startingBalance, totalNotional, totalUpnl, equity: acc?.equityUsd ?? ((acc?.balanceUsd ?? 10000) + totalUpnl) },
                        positions: positions.map((p: any) => {
                            const mid = (p as any).mid;
                            const qty = p.qty;
                            const upnl = (typeof mid === 'number' && typeof p.entryPrice === 'number') ? (mid - p.entryPrice) * qty : (p.unrealizedPnl ?? 0);
                            return { symbol: p.symbol, netQty: qty, avgEntry: p.entryPrice, mid: (p as any).mid ?? null, notional: (qty && mid != null) ? Math.abs(qty * mid) : null, upnl };
                        }),
                        pairs: []
                    });
                }
            } catch { /* fall through to compute */ }

            const ordersPath = await resolveFromSimData('orders.jsonl');
            const pairsJsonlPath = await resolveFromSimData('pairs.jsonl');
            const pairsJsonPath = await resolveFromSimData('pairs.json');
            const marketsPath = await resolveFromSimData('markets.json');
            const [ordersRaw, pairsRaw, marketsRaw] = await Promise.all([
                fs.readFile(ordersPath, 'utf8'),
                (async () => {
                    try {
                        const raw = await fs.readFile(pairsJsonlPath, 'utf8');
                        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                        const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
                        return JSON.stringify(last?.data ?? null);
                    } catch {
                        return await fs.readFile(pairsJsonPath, 'utf8').catch(() => 'null');
                    }
                })(),
                fs.readFile(marketsPath, 'utf8').catch(() => 'null'),
            ]);
            const pairs = pairsRaw && pairsRaw !== 'null' ? JSON.parse(pairsRaw) : { pairs: [] as any[] };
            const markets = marketsRaw && marketsRaw !== 'null' ? JSON.parse(marketsRaw) : { markets: [] as any[] };
            const priceMap = new Map<string, number>();
            for (const m of (markets.markets ?? [])) {
                if (typeof m.lastPrice === 'number') priceMap.set(m.symbol, m.lastPrice);
            }
            const lines = ordersRaw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const orders: Array<any> = [];
            let realizedSum = 0;
            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);
                    if (obj?.type === 'order' && obj?.data) orders.push(obj);
                    if (obj?.type === 'pair_exit' && typeof obj?.data?.realizedPnlUsd === 'number') realizedSum += obj.data.realizedPnlUsd;
                } catch { }
            }
            type RunningPos = { netQty: number; avgPrice: number | null };
            const posMap = new Map<string, RunningPos>();
            const fills = orders.filter(o => o.data.status === 'FILLED').sort((a, b) => a.ts - b.ts);
            for (const f of fills) {
                const symbol = f.data.symbol as string;
                const qtySigned = f.data.executedQty * (f.data.side === 'BUY' ? 1 : -1);
                const price = f.data.price as number;
                const cur = posMap.get(symbol) ?? { netQty: 0, avgPrice: null };
                if (cur.netQty === 0) { posMap.set(symbol, { netQty: qtySigned, avgPrice: price }); continue; }
                if (Math.sign(cur.netQty) === Math.sign(qtySigned)) {
                    const newQtyAbs = Math.abs(cur.netQty) + Math.abs(qtySigned);
                    const newAvg = (((cur.avgPrice ?? price) as number) * Math.abs(cur.netQty) + price * Math.abs(qtySigned)) / newQtyAbs;
                    posMap.set(symbol, { netQty: cur.netQty + qtySigned, avgPrice: newAvg });
                } else {
                    const remaining = cur.netQty + qtySigned;
                    if (remaining === 0) posMap.set(symbol, { netQty: 0, avgPrice: null });
                    else if (Math.sign(remaining) === Math.sign(cur.netQty)) posMap.set(symbol, { netQty: remaining, avgPrice: cur.avgPrice });
                    else posMap.set(symbol, { netQty: remaining, avgPrice: price });
                }
            }
            const positions = Array.from(posMap.entries())
                .filter(([, p]) => Math.abs(p.netQty) > 1e-12)
                .map(([symbol, p]) => {
                    const directMid = priceMap.get(symbol);
                    const pair = (pairs.pairs ?? []).find((pp: any) => pp.long === symbol || pp.short === symbol);
                    const pairMid = pair ? (pair.long === symbol ? pair.prices?.long?.mid : pair.prices?.short?.mid) : undefined;
                    const mid = (typeof directMid === 'number') ? directMid : (typeof pairMid === 'number' ? pairMid : null);
                    const notional = mid != null ? Math.abs(p.netQty) * (mid as number) : null;
                    const upnl = p.avgPrice != null && mid != null ? ((mid as number) - (p.avgPrice as number)) * p.netQty : 0;
                    return { symbol, netQty: p.netQty, avgEntry: p.avgPrice, mid, notional, upnl };
                });
            const totalNotional = positions.reduce((acc, p) => acc + (p.notional ?? 0), 0);
            const totalUpnl = positions.reduce((acc, p) => acc + (p.upnl ?? 0), 0);
            const startingBalance = Number(process.env.PORTFOLIO_BASE_BALANCE || 10000);
            const currentBalance = startingBalance + realizedSum;
            const equity = currentBalance + totalUpnl;
            const symbolToPos = new Map(positions.map(p => [p.symbol, p]));
            const pairSummaries: Array<{ key: string; long: string; short: string; upnl: number; notionalEntry: number; percent: number }> = [];

            // Helper: normalize pair key so A|B == B|A
            const normalizeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

            // Prefer actively tracked open pairs from pairs_state.json
            const addedKeys = new Set<string>(); // normalized keys
            try {
                const pairsStatePath = await resolveFromSimData('pairs_state.json');
                const stateTxt = await fs.readFile(pairsStatePath, 'utf8');
                const state: Record<string, any> = JSON.parse(stateTxt);
                for (const [id, s] of Object.entries(state || {})) {
                    if (!s || s.closedAt) continue; // only open pairs
                    const parts = id.split('|');
                    if (parts.length !== 2) continue;
                    const [longSym, shortSym] = parts as [string, string];
                    const norm = normalizeKey(longSym, shortSym);
                    if (addedKeys.has(norm)) continue;
                    const longPos = symbolToPos.get(longSym);
                    const shortPos = symbolToPos.get(shortSym);
                    if (!longPos || !shortPos) continue; // require both legs open
                    const upnl = (longPos.upnl ?? 0) + (shortPos.upnl ?? 0);
                    const notionalEntry = (Math.abs(longPos.netQty) * (longPos.avgEntry ?? 0)) + (Math.abs(shortPos.netQty) * (shortPos.avgEntry ?? 0));
                    const percent = notionalEntry > 0 ? upnl / notionalEntry : 0;
                    pairSummaries.push({ key: norm, long: longSym, short: shortSym, upnl, notionalEntry, percent });
                    addedKeys.add(norm);
                }
            } catch { /* pairs_state.json may not exist yet; ignore */ }

            // Fallback: only if no open pairs found in pairs_state.json
            if (pairSummaries.length === 0) {
                for (const pr of (pairs.pairs ?? [])) {
                    const norm = normalizeKey(pr.long, pr.short);
                    if (addedKeys.has(norm)) continue;
                    const longPos = symbolToPos.get(pr.long);
                    const shortPos = symbolToPos.get(pr.short);
                    if (!longPos || !shortPos) continue;
                    const upnl = (longPos.upnl ?? 0) + (shortPos.upnl ?? 0);
                    const notionalEntry = (Math.abs(longPos.netQty) * (longPos.avgEntry ?? 0)) + (Math.abs(shortPos.netQty) * (shortPos.avgEntry ?? 0));
                    const percent = notionalEntry > 0 ? upnl / notionalEntry : 0;
                    pairSummaries.push({ key: norm, long: pr.long, short: pr.short, upnl, notionalEntry, percent });
                    addedKeys.add(norm);
                }
            }
            res.json({ summary: { baseBalance: startingBalance, totalNotional, totalUpnl, equity }, positions, pairs: pairSummaries });
        } catch {
            res.status(500).json({ error: 'Failed to compute portfolio' });
        }
    });

    // ---------- /api/orders ----------
    app.get('/api/orders', async (req: Request, res: Response) => {
        try {
            const filePath = await resolveFromSimData('orders.jsonl');
            const raw = await fs.readFile(filePath, 'utf8');
            const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const limitRaw = (req.query.limit as string) ?? '200';
            const limit = Math.max(1, Math.min(1000, Number(limitRaw)));
            const recent = lines.slice(-limit);
            const events: any[] = [];
            for (const line of recent) {
                try { events.push(JSON.parse(line)); } catch { }
            }
            res.json({ events });
        } catch {
            res.status(500).json({ error: 'Failed to read orders data' });
        }
    });

    const port = portFromEnv ?? (process.env.PORT ? Number(process.env.PORT) : 3000);
    return app.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`HTTP server listening on ${port}`);
    });
}


