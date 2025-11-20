/**
 * PAIR TRADING AGENT ORCHESTRATOR
 *
 * Core trading engine that coordinates the entire pair trading workflow:
 * - Market data collection and pair candidate generation
 * - LLM-powered decision making with sentiment analysis
 * - Order execution and position management
 * - Risk monitoring and exit signal processing
 *
 * This is the heart of the trading system, orchestrating all components
 * to execute statistical arbitrage strategies with AI decision support.
 */

import { createProviderFromEnv, LLMProvider } from '../llm/provider.js';
import { createToolHandlers } from '../llm/tools.js';
// import { JsonlLedger } from '../persistence/jsonlLedger.js';
import { SqlEventLedger } from '../persistence/sqlEventLedger.js';
import { SimulatedExchange } from '../sim/simulatedExchange.js';
import { createExecutionProvider } from '../execution/provider.js';
import { PublicClient } from '../http/publicClient.js';
import createDebug from 'debug';
import { getSystemPrompt } from '../prompts/system.js';
import { getUserPrompt } from '../prompts/user.js';
// import { computeTechnicalsFromKlines } from '../tech/indicators.js';
import { buildPairCandidates } from '../strategies/pairs/pairTrading.js';
import { updateMarketsBuckets } from '../lib/buckets.js';
import { StateService } from '../services/stateService.js';
import type { SimPosition } from '../services/stateService.js';
import { pctChanges, pearson, betaYOnX } from '../lib/stats.js';
import { createCanonicalPairKey } from '../lib/pairUtils.js';

export class Orchestrator {
    private provider: LLMProvider;
    private log = createDebug('agent:orchestrator');

    constructor(private client: PublicClient, private sim: SimulatedExchange, private ledger: SqlEventLedger) {
        this.provider = createProviderFromEnv();
    }

    async runOnce(): Promise<void> {
        // Research disabled in no-tools mode

        // Disabled tools mode: prefetch state + technicals for majors and do a single JSON response
        const ordersLedger = new SqlEventLedger();
        const exec = createExecutionProvider((process.env.MODE as any) === 'live' ? 'live' : 'paper', this.sim);
        const handlers = createToolHandlers({ client: this.client, sim: this.sim, ledger: this.ledger, ordersLedger });
        const rawPositions = await handlers.get_positions();
        const positions: SimPosition[] = (rawPositions || []).map((p: any, idx: number) => ({
            positionId: `${p.symbol}:${p.positionSide}:${Number(p.entryPrice ?? 0)}`,
            symbol: p.symbol,
            direction: p.positionSide,
            entryPrice: p.entryPrice,
            qty: p.positionSide === 'LONG' ? p.positionAmt : -p.positionAmt,
            unrealizedPnl: p.unrealizedPnl,
            leverage: p.leverage
        }));
        const account = await handlers.get_account_state();
        // Refresh unrealized PnL for positions using fresh mids
        try {
            const symbols = Array.from(new Set(positions.map(p => p.symbol)));
            const priceMap = new Map<string, number>();
            await Promise.all(symbols.map(async (s) => {
                try { const t = await this.client.getTicker(s); priceMap.set(s, t.price); } catch { }
            }));
            for (const p of positions) {
                const mid = priceMap.get(p.symbol);
                if (typeof mid === 'number' && typeof p.entryPrice === 'number') {
                    const dir = p.direction === 'LONG' ? 1 : -1;
                    p.unrealizedPnl = (mid - p.entryPrice) * p.qty; // qty already signed by direction above
                }
            }
        } catch { }
        // recent orders (last 10 min)
        const stateSvc = new StateService('sim_data/orders.jsonl', this.sim);
        const recentOrders = await stateSvc.getRecentOrders(100);
        // Pair-focused mode: skip per-asset technicals/market snapshot for majors
        const technicals: Record<string, Record<string, any>> = {};
        const market: Record<string, any> = {};
        // Hourly pairs pipeline with rotation per cycle
        const pairsTtlMs = Number(process.env.PAIRS_TTL_MS || String(60 * 60 * 1000));
        let pairs: Array<{ sector?: string; ecosystem?: string; assetType?: string; long: string; short: string; corr?: number; beta?: number; scores?: any; spreadZ?: number; cointegration?: any; fundingNet?: number }> = [];
        let latestAsOf: number | null = null;
        try {
            const { getDb } = await import('../db/sqlite.js');
            const db = await getDb();
            const row = db.prepare('SELECT as_of as asOf, data_json FROM pairs_snapshot ORDER BY as_of DESC LIMIT 1').get() as { asOf: number; data_json: string } | undefined;
            if (row) {
                latestAsOf = row.asOf;
                try { const parsed = JSON.parse(row.data_json); pairs = Array.isArray(parsed?.pairs) ? parsed.pairs : []; } catch { pairs = []; }
            }
        } catch { }

        const isStale = !latestAsOf || (Date.now() - latestAsOf) > pairsTtlMs;
        if (isStale) {
            // Refresh markets/buckets and rebuild pairs snapshot
            try { await updateMarketsBuckets(this.client, 'sim_data/markets.json', { interval: '15m', limit: 200, concurrency: 6 }); this.log('buckets: refreshed'); } catch (e) { this.log('buckets error %o', e); }
            try {
                const perGroup = Number(process.env.PAIRS_PER_SECTOR || '10');
                const res = await buildPairCandidates('sim_data/markets.json', perGroup, this.client);
                pairs = res.pairs;

                // Attach reference prices if online
                const isOffline = ((process.env.ASTER_OFFLINE || '').toLowerCase() === '1' || (process.env.ASTER_OFFLINE || '').toLowerCase() === 'true');
                if (!isOffline) {
                    const symbols = Array.from(new Set(pairs.flatMap(p => [p.long, p.short])));
                    const priceMap = new Map<string, { last?: number; bestBid?: number; bestAsk?: number; mid?: number }>();
                    for (const s of symbols) {
                        try {
                            const [tkr, ob] = await Promise.all([
                                this.client.getTicker(s).catch(() => undefined),
                                this.client.getOrderbook(s, 5).catch(() => undefined)
                            ]);
                            const bestBid = ob?.bids?.[0]?.[0];
                            const bestAsk = ob?.asks?.[0]?.[0];
                            const mid = (bestBid != null && bestAsk != null) ? (bestBid + bestAsk) / 2 : undefined;
                            priceMap.set(s, { last: tkr?.price, bestBid, bestAsk, mid });
                        } catch (e) {
                            this.log('price fetch error for %s: %o', s, e);
                        }
                    }
                    pairs = pairs.map(p => ({
                        ...p,
                        prices: {
                            long: priceMap.get(p.long),
                            short: priceMap.get(p.short)
                        }
                    })) as any;
                }
                try { await this.ledger.append('pairs_snapshot', { asOf: Date.now(), pairs }); } catch { }
            } catch (e) {
                this.log('pairs building error: %o', e);
                await this.ledger.append('pairs_error', { error: String(e) });
            }
        }

        // Load active pair baselines from SQL
        let pairBaselines: Record<string, { entryTime: number; entrySpreadZ?: number; entryHalfLife?: number | null }> = {};
        try {
            const { getDb } = await import('../db/sqlite.js');
            const { SqliteRepo } = await import('../services/sqliteRepo.js');
            const repo = new SqliteRepo(await getDb());
            pairBaselines = repo.getActivePairsBaseline();
            this.log('loaded %d baselines from SQL. Keys: %o', Object.keys(pairBaselines).length, Object.keys(pairBaselines));
        } catch { }

        // Derive active pair performance from current open positions and latest pair stats
        const activePairs: Array<{ long: string; short: string; pnlUsd: number; spreadZ?: number; halfLife?: number | null; entrySpreadZ?: number; deltaSpreadZ?: number; entryHalfLife?: number | null; deltaHalfLife?: number | null; entryTime?: number; elapsedMs?: number }> = [];
        try {
            // Build map of current pair statistics from latest pair data
            // Use canonical keys to ensure we find stats regardless of current direction
            const pairStatsMap = new Map<string, { spreadZ?: number; halfLife?: number | null }>();

            // Add stats from current pairs using canonical keys
            for (const p of pairs) {
                const canonicalKey = createCanonicalPairKey(p.long, p.short);
                pairStatsMap.set(canonicalKey, {
                    spreadZ: (p as any)?.spreadZ,
                    halfLife: (p as any)?.cointegration?.halfLife ?? null
                });
            }

            // Optional: no file-based fallbacks when using SQL-only writes

            // Group positions by symbol for efficient lookup
            const positionBySymbol = new Map<string, typeof positions[0]>();
            for (const pos of positions) {
                positionBySymbol.set(pos.symbol, pos);
            }

            // Prefer authoritative list from SQL active_pairs; fallback to bootstrap if empty
            let authoritativePairs: Array<{ long: string; short: string; entryTime: number; entrySpreadZ?: number | null; entryHalfLife?: number | null }> = [];
            try {
                const { getDb } = await import('../db/sqlite.js');
                const { SqliteRepo } = await import('../services/sqliteRepo.js');
                const repo = new SqliteRepo(await getDb());
                authoritativePairs = repo.getOpenActivePairs().map(r => ({ long: r.long, short: r.short, entryTime: r.entryTime, entrySpreadZ: r.entrySpreadZ, entryHalfLife: r.entryHalfLife }));
            } catch { }

            if (authoritativePairs.length === 0) {
                // Bootstrap from open positions
                // Try to match positions with pairs from the current pairs snapshot to ensure structural validity
                const longs = positions.filter(p => p.direction === 'LONG').map(p => p.symbol);
                const shorts = positions.filter(p => p.direction === 'SHORT').map(p => p.symbol);
                const used = new Set<string>();

                // First, try to match with existing pairs from the snapshot
                for (const pair of pairs) {
                    const hasLong = longs.includes(pair.long) && !used.has(pair.long);
                    const hasShort = shorts.includes(pair.short) && !used.has(pair.short);

                    if (hasLong && hasShort) {
                        const canonicalKey = createCanonicalPairKey(pair.long, pair.short);
                        authoritativePairs.push({ long: pair.long, short: pair.short, entryTime: Date.now() });
                        used.add(pair.long);
                        used.add(pair.short);

                        // Bootstrap to SQL
                        try {
                            const { getDb } = await import('../db/sqlite.js');
                            const { SqliteRepo } = await import('../services/sqliteRepo.js');
                            const repo = new SqliteRepo(await getDb());
                            const stats = pairStatsMap.get(canonicalKey) || null;
                            repo.upsertActivePair(canonicalKey, pair.long, pair.short, {
                                time: Date.now(),
                                spreadZ: (stats as any)?.spreadZ ?? null,
                                halfLife: (stats as any)?.halfLife ?? null
                            });
                            pairBaselines[canonicalKey] = {
                                entryTime: Date.now(),
                                entrySpreadZ: (stats as any)?.spreadZ ?? undefined,
                                entryHalfLife: (stats as any)?.halfLife ?? null
                            } as any;
                        } catch { }
                    }
                }

                // Fallback: arbitrarily pair remaining unmatched positions (last resort)
                // This should rarely happen if pairs snapshot is recent
                const remainingLongs = longs.filter(s => !used.has(s));
                const remainingShorts = shorts.filter(s => !used.has(s));
                for (let i = 0; i < Math.min(remainingLongs.length, remainingShorts.length); i++) {
                    const lo = remainingLongs[i]!;
                    const sh = remainingShorts[i]!;
                    const canonicalKey = createCanonicalPairKey(lo, sh);
                    authoritativePairs.push({ long: lo, short: sh, entryTime: Date.now() });

                    try {
                        const { getDb } = await import('../db/sqlite.js');
                        const { SqliteRepo } = await import('../services/sqliteRepo.js');
                        const repo = new SqliteRepo(await getDb());
                        const stats = pairStatsMap.get(canonicalKey) || null;
                        repo.upsertActivePair(canonicalKey, lo, sh, {
                            time: Date.now(),
                            spreadZ: (stats as any)?.spreadZ ?? null,
                            halfLife: (stats as any)?.halfLife ?? null
                        });
                        pairBaselines[canonicalKey] = {
                            entryTime: Date.now(),
                            entrySpreadZ: (stats as any)?.spreadZ ?? undefined,
                            entryHalfLife: (stats as any)?.halfLife ?? null
                        } as any;
                    } catch { }
                }
            }

            const processedPairs = new Set<string>();
            for (const ap of authoritativePairs) {
                const longSymbol = ap.long;
                const shortSymbol = ap.short;
                const canonicalKey = createCanonicalPairKey(longSymbol, shortSymbol);
                if (processedPairs.has(canonicalKey)) continue;
                processedPairs.add(canonicalKey);

                // Debug baseline lookup
                const hasBaseline = canonicalKey in pairBaselines;
                this.log('processing %s (canonical: %s) - baseline found? %s', `${longSymbol}/${shortSymbol}`, canonicalKey, hasBaseline);

                const longPos = positionBySymbol.get(longSymbol);
                const shortPos = positionBySymbol.get(shortSymbol);
                if (!longPos || !shortPos) continue;

                // 1. Resolve current stats (from map or history) FIRST
                let currentStats = pairStatsMap.get(canonicalKey);
                if (!currentStats) {
                    try {
                        const { getDb } = await import('../db/sqlite.js');
                        const { SqliteRepo } = await import('../services/sqliteRepo.js');
                        const repo = new SqliteRepo(await getDb());
                        const hist = repo.getLatestPairHistory(canonicalKey);
                        if (hist && (hist.spreadZ != null || hist.halfLife != null)) {
                            currentStats = { spreadZ: hist.spreadZ ?? undefined, halfLife: hist.halfLife ?? null } as any;
                        } else {
                            const snap = repo.getLatestPairStatsFromSnapshot(longSymbol, shortSymbol);
                            if (snap && (snap.spreadZ != null || snap.halfLife != null)) {
                                currentStats = { spreadZ: snap.spreadZ ?? undefined, halfLife: snap.halfLife ?? null } as any;
                            }
                        }
                    } catch { }
                }

                // 2. Check baseline and self-heal if needed using resolved currentStats
                let baseline = pairBaselines[canonicalKey];
                if ((!baseline || typeof baseline.entrySpreadZ !== 'number') && currentStats?.spreadZ != null) {
                    this.log('healing missing baseline for %s using current stats (Z=%s)', canonicalKey, currentStats.spreadZ);
                    baseline = {
                        entryTime: Date.now(),
                        entrySpreadZ: currentStats.spreadZ,
                        entryHalfLife: currentStats.halfLife ?? null
                    };
                    try {
                        const { getDb } = await import('../db/sqlite.js');
                        const { SqliteRepo } = await import('../services/sqliteRepo.js');
                        const repo = new SqliteRepo(await getDb());
                        repo.upsertActivePair(canonicalKey, longSymbol, shortSymbol, {
                            time: baseline.entryTime,
                            spreadZ: baseline.entrySpreadZ,
                            halfLife: baseline.entryHalfLife
                        });
                        pairBaselines[canonicalKey] = baseline;
                    } catch (e) {
                        this.log('failed to persist healed baseline: %o', e);
                    }
                }

                const pnlUsd = (longPos.unrealizedPnl ?? 0) + (shortPos.unrealizedPnl ?? 0);
                const entrySpreadZ = baseline?.entrySpreadZ;

                // Convergence-aware delta: positive = converging toward zero, negative = diverging
                // For mean-reversion trades, we want to track movement toward spreadZ = 0
                const deltaSpreadZ = (typeof currentStats?.spreadZ === 'number' && typeof entrySpreadZ === 'number')
                    ? (Math.abs(entrySpreadZ) - Math.abs(currentStats.spreadZ))  // Positive = good (converging)
                    : undefined;

                const entryHalfLife = baseline?.entryHalfLife;
                const currentHalfLife = currentStats?.halfLife ?? null;

                // Delta half-life: negative = faster reversion (good), positive = slower reversion (bad)
                // We flip the sign to make it intuitive: positive = improvement
                const deltaHalfLife = (entryHalfLife != null && currentHalfLife != null)
                    ? (entryHalfLife - currentHalfLife)  // Positive = faster reversion (good)
                    : null;
                const elapsedMs = (baseline && typeof baseline.entryTime === 'number')
                    ? (Date.now() - baseline.entryTime)
                    : undefined;
                // Convergence from entry magnitude toward 0 (0..1), never rewards moving away
                let convergenceProgress: number | null = null;
                // Progress toward target band (e.g., |Z| <= 0.5)
                let convergenceToTargetPct: number | null = null;
                let remainingToTargetZ: number | null = null;
                try {
                    const entryAbs = (entrySpreadZ != null) ? Math.abs(entrySpreadZ) : null;
                    const currAbs = (currentStats?.spreadZ != null) ? Math.abs(currentStats.spreadZ as number) : null;
                    if (entryAbs != null && currAbs != null && Number.isFinite(entryAbs) && entryAbs > 0 && Number.isFinite(currAbs)) {
                        const raw = (entryAbs - currAbs) / entryAbs;
                        convergenceProgress = Math.max(0, Math.min(1, raw));
                        const targetAbs = 0.5;
                        remainingToTargetZ = Math.max(currAbs - targetAbs, 0);
                        if (entryAbs <= targetAbs) {
                            // If we entered already inside target band, consider fully converged when still inside
                            convergenceToTargetPct = currAbs <= targetAbs ? 1 : 0;
                        } else {
                            const denom = Math.max(entryAbs - targetAbs, 1e-9);
                            const rawTarget = (entryAbs - Math.max(currAbs, targetAbs)) / denom;
                            convergenceToTargetPct = Math.max(0, Math.min(1, rawTarget));
                        }
                    }
                } catch { convergenceProgress = null; }
                const elapsedHours = (elapsedMs != null) ? (elapsedMs / (1000 * 60 * 60)) : null;
                const elapsedHalfLives = (currentHalfLife != null && elapsedHours != null && currentHalfLife > 0)
                    ? (elapsedHours / currentHalfLife)
                    : null;
                const exitSignals = {
                    profitTarget: (currentStats?.spreadZ != null) && Math.abs(currentStats.spreadZ) <= 0.5,
                    timeStop: currentHalfLife != null && elapsedMs != null &&
                        (elapsedMs / (1000 * 60 * 60)) >= (2 * currentHalfLife),
                    convergence: convergenceProgress != null && convergenceProgress >= 0.5,
                    riskReduction: pnlUsd <= -40,
                    riskExit: pnlUsd <= -100
                } as any;

                activePairs.push({
                    long: longSymbol,
                    short: shortSymbol,
                    pnlUsd,
                    spreadZ: currentStats?.spreadZ,
                    halfLife: currentHalfLife,
                    entrySpreadZ,
                    deltaSpreadZ,
                    entryHalfLife,
                    deltaHalfLife,
                    entryTime: baseline?.entryTime,
                    elapsedMs,
                    convergenceProgress,
                    convergenceToTargetPct,
                    remainingToTargetZ,
                    elapsedHalfLives,
                    exitSignals
                } as any);
            }

            this.log('identified %d active pairs from %d positions', activePairs.length, positions.length);
        } catch (e) {
            this.log('active pairs calculation error: %o', e);
            await this.ledger.append('active_pairs_error', { error: String(e) });
        }

        // Persist per-cycle pair history to SQL
        try {
            const { getDb } = await import('../db/sqlite.js');
            const { SqliteRepo } = await import('../services/sqliteRepo.js');
            const repo = new SqliteRepo(await getDb());
            for (const ap of activePairs) {
                repo.insertPairHistory(ap.long, ap.short, {
                    ts: Date.now(),
                    spreadZ: ap.spreadZ ?? null,
                    halfLife: ap.halfLife ?? null,
                    pnlUsd: ap.pnlUsd ?? null,
                    entrySpreadZ: ap.entrySpreadZ ?? null,
                    deltaSpreadZ: ap.deltaSpreadZ ?? null,
                    entryHalfLife: ap.entryHalfLife ?? null,
                    deltaHalfLife: ap.deltaHalfLife ?? null,
                    elapsedMs: ap.elapsedMs ?? null
                });
            }
        } catch { }

        // Build rotating shortlist for this cycle
        const usedSymbols = new Set<string>(positions.map(p => p.symbol));
        const cooldownMin = Number(process.env.REENTER_COOLDOWN_MIN || '120');
        let recent = [] as any[];
        try { const svc = new StateService('sim_data/orders.jsonl', this.sim); recent = await svc.getRecentOrders(500, cooldownMin * 60 * 1000) as any[]; } catch { }
        const recentExitPairs = new Set<string>();
        for (const e of recent) {
            const t = e?.type;
            const long = e?.data?.pair?.long; const short = e?.data?.pair?.short;
            if (t === 'pair_exit' && long && short) {
                // Use canonical key to ensure cooldown works regardless of direction
                const canonicalKey = createCanonicalPairKey(long, short);
                recentExitPairs.add(canonicalKey);
            }
        }

        const sortedPairs = [...pairs].sort((a: any, b: any) => {
            const az = Math.abs(a?.spreadZ ?? 0);
            const bz = Math.abs(b?.spreadZ ?? 0);
            if (bz !== az) return bz - az;
            const ac = a?.scores?.composite ?? -Infinity;
            const bc = b?.scores?.composite ?? -Infinity;
            return bc - ac;
        });

        const applyCooldown = positions.length > 0; // if no positions, ignore cooldown to surface candidates
        let eligible = sortedPairs.filter(p => {
            const canonicalKey = createCanonicalPairKey(p.long, p.short);
            return !usedSymbols.has(p.long) &&
                !usedSymbols.has(p.short) &&
                (applyCooldown ? !recentExitPairs.has(canonicalKey) : true);
        });
        // Fallback: if nothing survives filters, use the sorted list to ensure the agent sees opportunities
        if (eligible.length === 0) {
            eligible = sortedPairs;
        }
        const windowSize = Math.max(5, Number(process.env.PROMPT_PAIRS_WINDOW_SIZE || '12'));
        const cycleMs = Number(process.env.ROTATE_CYCLE_MS || String(5 * 60 * 1000));
        const rotationIdx = Math.floor(Date.now() / cycleMs);
        const startIdx = (rotationIdx * windowSize) % Math.max(1, eligible.length);
        const rotated: typeof eligible = [];
        for (let i = 0; i < Math.min(windowSize, eligible.length); i++) {
            rotated.push(eligible[(startIdx + i) % eligible.length]);
        }

        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
            { role: 'system', content: getSystemPrompt() },
            { role: 'user', content: getUserPrompt({ account, positions, pairs: rotated, activePairs }) }
        ];
        await this.ledger.append('round_start', { round: 0 });
        // Log raw constructed user message for observability
        const userMsg = messages.find(m => m.role === 'user')?.content || '';
        await this.ledger.append('user_raw', { content: userMsg });
        // Structured outputs schema to guarantee JSON shape
        const { TradingDecisionSchema } = await import('./decisionSchema.js');
        const decisionSchema = TradingDecisionSchema as any;

        // Enable targeted search for social sentiment analysis (reduced frequency to avoid rate limits)
        const cycleCount = Math.floor(Date.now() / (5 * 60 * 1000)); // 5-minute cycles
        const shouldSearch = cycleCount % 3 === 0; // Search every 3rd cycle (~15 minutes)

        // Only create search parameters when search is actually enabled
        let searchParameters: any = undefined;
        if (shouldSearch) {
            // Limit search to recent posts (last 7 days) for relevant, timely sentiment
            // This ensures we get current market sentiment, not stale historical data
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            const fromDate = sevenDaysAgo.toISOString().split('T')[0]; // YYYY-MM-DD format

            searchParameters = {
                mode: "auto", // When enabled, always use auto mode
                return_citations: true,
                max_search_results: 5, // Reduced from 10 to save costs
                sources: [
                    {
                        type: "x", // Focus on X/Twitter for sentiment, skip news/web to reduce API calls
                        from_date: fromDate // Only posts from last 7 days for current sentiment
                    }
                ]
            };
        }

        try {
            await this.ledger.append('search_invoked', { enabled: shouldSearch, params: searchParameters });
            this.log('search enabled=%s params=%o', shouldSearch, searchParameters || 'none');
        } catch { }

        let assistantText: string | undefined;
        let citations: any = undefined;
        let toolCalls: any = undefined;
        try {
            const response = await this.provider.chatWithTools(messages, [], {
                responseFormat: decisionSchema,
                ...(searchParameters ? { searchParameters } : {}) // Only pass search params when they exist
            } as any);
            assistantText = response.assistantText;
            citations = response.citations;
            toolCalls = response.toolCalls;

            // Enhanced logging for search and reasoning
            try {
                await this.ledger.append('search_completed', {
                    enabled: shouldSearch,
                    citationsCount: shouldSearch ? (citations?.length || 0) : 0,
                    toolCallsCount: shouldSearch ? (toolCalls?.length || 0) : 0
                });

                // Only log search details when search was actually enabled
                if (shouldSearch) {
                    // Log search tool usage details
                    if (toolCalls && toolCalls.length > 0) {
                        this.log('search tool calls: %d', toolCalls.length);
                        toolCalls.forEach((call: any, idx: number) => {
                            this.log('tool[%d]: %s with args %o', idx, call?.name || call?.function?.name, call?.arguments || call?.function?.arguments);
                        });
                    }

                    // Log citation details for transparency
                    if (citations && citations.length > 0) {
                        this.log('citations received: %d items', citations.length);
                        citations.forEach((citation: any, idx: number) => {
                            const title = citation?.title || citation?.text || citation?.content || 'Citation';
                            const url = citation?.url || citation?.source || '';
                            this.log('citation[%d]: %s%s', idx, title.substring(0, 100), url ? ` (${url})` : '');
                        });
                    } else if (toolCalls && toolCalls.length > 0) {
                        this.log('search completed but no citations returned');
                    }
                } else {
                    // Verify no search artifacts when disabled
                    if (citations && citations.length > 0) {
                        this.log('WARNING: Citations present when search was disabled: %d items', citations.length);
                    }
                    if (toolCalls && toolCalls.length > 0) {
                        this.log('WARNING: Tool calls present when search was disabled: %d calls', toolCalls.length);
                    }
                }
            } catch { }
        } catch (e) {
            this.log('LLM chat failed: %o', e);
            await this.ledger.append('llm_error', { round: 0, error: String(e) });
            await this.ledger.append('round_end', { round: 0 });
            return; // Exit early if LLM fails
        }

        // Log raw assistant output with full context
        try {
            await this.ledger.append('assistant_raw', {
                round: 0,
                content: assistantText,
                citations: shouldSearch ? citations : undefined, // Only include citations if search was enabled
                toolCalls: shouldSearch ? toolCalls : undefined, // Only include tool calls if search was enabled
                searchEnabled: shouldSearch
            });
        } catch (e) {
            this.log('failed to log assistant output: %o', e);
        }

        await this.ledger.append('round_end', { round: 0 });

        // Try to parse JSON from raw output, stripping code fences if present
        let parsed: any = undefined;
        if (assistantText) {
            const jsonFromFence = extractJsonBlock(assistantText);
            const candidate = jsonFromFence || assistantText;
            try {
                parsed = JSON.parse(candidate);
            } catch (e) {
                this.log('failed to parse LLM response as JSON: %o', e);
                await this.ledger.append('parse_error', { raw: assistantText, error: String(e) });
                parsed = undefined;
            }
        }

        try {
            await this.ledger.append('decision', { raw: assistantText, parsed });
        } catch (e) {
            this.log('failed to log decision: %o', e);
        }

        // If we received a concrete trade decision, record/simulate orders
        try {
            if (parsed && parsed.mode === 'PAIR' && parsed.signal === 'ENTER' && parsed.pair?.long && parsed.pair?.short) {
                // Guard: enforce max concurrent pairs and distinct symbols across pairs
                const maxPairs = Number(process.env.MAX_CONCURRENT_PAIRS || '10');
                const currentPairs = activePairs || [];
                const hasCapacity = currentPairs.length < maxPairs;
                const usedSymbols = new Set<string>(currentPairs.flatMap(p => [p.long, p.short]));
                const symbolOverlaps = usedSymbols.has(parsed.pair.long) || usedSymbols.has(parsed.pair.short);

                // Check if this pair (or its inverse) already exists using canonical keys
                let pairExistsReason: string | null = null;
                try {
                    const { getDb } = await import('../db/sqlite.js');
                    const { SqliteRepo } = await import('../services/sqliteRepo.js');
                    const repo = new SqliteRepo(await getDb());
                    const existing = repo.getActivePairIfExists(parsed.pair.long, parsed.pair.short);
                    if (existing) {
                        pairExistsReason = 'pair_already_open';
                        this.log('pair entry blocked: %s/%s already exists as %s (direction: %s)',
                            parsed.pair.long, parsed.pair.short, existing.pairKey, existing.direction);
                    }
                } catch { }

                if (!hasCapacity || symbolOverlaps || pairExistsReason) {
                    const reason = !hasCapacity ? 'capacity_reached' :
                        pairExistsReason ? pairExistsReason :
                            'symbol_overlap';
                    await ordersLedger.append('enter_blocked', { reason, maxPairs, currentPairs: currentPairs.length, pair: parsed.pair });
                    return;
                }
                // Execute both legs on the simulator using MARKET orders with mid-price sizing
                const pair = parsed.pair;
                const sizing = parsed.sizing || {};
                const leverage = sizing.leverage || 1; // Default to 1x if not specified

                // Fetch fresh price data on-demand for the chosen pair
                let longRef: number | undefined;
                let shortRef: number | undefined;

                try {
                    // Get price data for both symbols
                    const [longTicker, longOrderbook, shortTicker, shortOrderbook] = await Promise.all([
                        this.client.getTicker(pair.long).catch(() => undefined),
                        this.client.getOrderbook(pair.long, 5).catch(() => undefined),
                        this.client.getTicker(pair.short).catch(() => undefined),
                        this.client.getOrderbook(pair.short, 5).catch(() => undefined)
                    ]);

                    // Calculate reference prices (mid price preferred, fallback to last price)
                    const longBestBid = longOrderbook?.bids?.[0]?.[0];
                    const longBestAsk = longOrderbook?.asks?.[0]?.[0];
                    const shortBestBid = shortOrderbook?.bids?.[0]?.[0];
                    const shortBestAsk = shortOrderbook?.asks?.[0]?.[0];

                    longRef = (longBestBid != null && longBestAsk != null) ? (longBestBid + longBestAsk) / 2 : longTicker?.price;
                    shortRef = (shortBestBid != null && shortBestAsk != null) ? (shortBestBid + shortBestAsk) / 2 : shortTicker?.price;

                } catch (e) {
                    this.log('price fetch error for pair %s/%s: %o', pair.long, pair.short, e);
                    await ordersLedger.append('order_error', { reason: 'price_fetch_failed', pair, error: String(e) });
                    return;
                }

                if (!longRef || !shortRef) {
                    this.log('missing reference prices for pair %s/%s', pair.long, pair.short);
                    await ordersLedger.append('order_error', { reason: 'missing_reference_prices', pair, longRef, shortRef });
                    return;
                }

                // Normalize TP/SL if model returned multipliers instead of absolute levels
                const normLeg = (leg: any, ref?: number) => {
                    if (!leg || typeof ref !== 'number') return leg;
                    const out: any = { ...leg };
                    const isMult = (v: any) => typeof v === 'number' && v > 0 && v < 2;
                    if (isMult(out.stopLoss)) out.stopLoss = ref * out.stopLoss;
                    if (isMult(out.takeProfit)) out.takeProfit = ref * out.takeProfit;
                    return out;
                };

                const risk = {
                    long: { ...normLeg(parsed.risk?.long, longRef), leverage },
                    short: { ...normLeg(parsed.risk?.short, shortRef), leverage }
                };

                try {
                    await ordersLedger.append('order_plan', { pair, long: { symbol: pair.long, sizeUsd: sizing.longSizeUsd }, short: { symbol: pair.short, sizeUsd: sizing.shortSizeUsd }, risk });
                } catch (e) {
                    this.log('failed to log order plan: %o', e);
                }

                // Compute quantities from notional and reference mid
                const longQty = (typeof sizing.longSizeUsd === 'number' && typeof longRef === 'number' && longRef > 0) ? (sizing.longSizeUsd / longRef) : undefined;
                const shortQty = (typeof sizing.shortSizeUsd === 'number' && typeof shortRef === 'number' && shortRef > 0) ? (sizing.shortSizeUsd / shortRef) : undefined;

                if (!longQty || longQty <= 0) {
                    this.log('invalid long quantity calculation for %s: sizeUsd=%s, ref=%s', pair.long, sizing.longSizeUsd, longRef);
                    await ordersLedger.append('order_error', { reason: 'invalid_long_quantity', pair, sizing, longRef });
                    return;
                }

                if (!shortQty || shortQty <= 0) {
                    this.log('invalid short quantity calculation for %s: sizeUsd=%s, ref=%s', pair.short, sizing.shortSizeUsd, shortRef);
                    await ordersLedger.append('order_error', { reason: 'invalid_short_quantity', pair, sizing, shortRef });
                    return;
                }

                // Execute orders with proper error handling
                let longOrd, shortOrd;
                try {
                    longOrd = await exec.placeOrder({ symbol: pair.long, side: 'BUY', type: 'MARKET', quantity: longQty, price: longRef, leverage: parsed?.risk?.long?.leverage });
                    await ordersLedger.append('order', longOrd);
                } catch (e) {
                    this.log('long order failed for %s: %o', pair.long, e);
                    await ordersLedger.append('order_error', { reason: 'long_order_failed', pair, error: String(e), orderParams: { symbol: pair.long, side: 'BUY', quantity: longQty, price: longRef } });
                    return; // Don't proceed if long leg fails
                }

                try {
                    shortOrd = await exec.placeOrder({ symbol: pair.short, side: 'SELL', type: 'MARKET', quantity: shortQty, price: shortRef, leverage: parsed?.risk?.short?.leverage });
                    await ordersLedger.append('order', shortOrd);
                } catch (e) {
                    this.log('short order failed for %s: %o', pair.short, e);
                    await ordersLedger.append('order_error', { reason: 'short_order_failed', pair, error: String(e), orderParams: { symbol: pair.short, side: 'SELL', quantity: shortQty, price: shortRef } });
                    // Attempt to cancel the long order if short fails
                    try {
                        await exec.cancelOrder({ orderId: longOrd.orderId, symbol: longOrd.symbol });
                        await ordersLedger.append('order_cancelled', { reason: 'compensating_long_cancel', originalOrder: longOrd });
                    } catch (cancelError) {
                        this.log('failed to cancel compensating long order: %o', cancelError);
                        await ordersLedger.append('order_error', { reason: 'compensating_cancel_failed', error: String(cancelError) });
                    }
                    return;
                }

                // Persist pair baseline (entry metrics) in SQL
                try {
                    const { getDb } = await import('../db/sqlite.js');
                    const { SqliteRepo } = await import('../services/sqliteRepo.js');
                    const repo = new SqliteRepo(await getDb());
                    const entrySpreadZ = parsed?.pair?.spreadZ;
                    const entryHalfLife = parsed?.pair?.halfLife ?? null;
                    const nowTs = Date.now();
                    repo.upsertActivePair('unused', pair.long, pair.short, { time: nowTs, spreadZ: entrySpreadZ ?? null, halfLife: entryHalfLife ?? null });
                    repo.insertPairHistory(pair.long, pair.short, {
                        ts: nowTs,
                        spreadZ: entrySpreadZ ?? null,
                        halfLife: entryHalfLife ?? null,
                        pnlUsd: 0,
                        entrySpreadZ: entrySpreadZ ?? null,
                        deltaSpreadZ: 0,
                        entryHalfLife: entryHalfLife ?? null,
                        deltaHalfLife: null,
                        elapsedMs: 0
                    });
                } catch { }

                // Log consolidated pair_enter with reference and executed prices
                try {
                    await ordersLedger.append('pair_enter', {
                        pair,
                        legs: [
                            { symbol: pair.long, side: 'BUY', qty: longOrd?.executedQty, entryRef: longRef, executedPrice: longOrd?.price },
                            { symbol: pair.short, side: 'SELL', qty: shortOrd?.executedQty, entryRef: shortRef, executedPrice: shortOrd?.price }
                        ]
                    });
                } catch { }
            } else if (parsed && parsed.mode === 'PAIR' && parsed.signal === 'REDUCE' && parsed.pair?.long && parsed.pair?.short) {
                // Reduce position size by 50% for risk management
                try {
                    const pair = parsed.pair;
                    const reductionPct = 0.5; // Reduce to 50% of current size

                    // Calculate realized PnL from partial close
                    let realized = 0;
                    let longReduceAmt = 0;
                    let shortReduceAmt = 0;
                    let longPx: number | undefined;
                    let shortPx: number | undefined;
                    let positionLeverage = 1;
                    try {
                        // Get current position sizes and reduce them
                        const longPos = (this.sim as any).positions?.find((p: any) => p.symbol === pair.long);
                        const shortPos = (this.sim as any).positions?.find((p: any) => p.symbol === pair.short);

                        if (longPos && shortPos) {
                            positionLeverage = longPos.leverage || 1;
                            // Calculate realized PnL from reducing 50% of positions
                            longPx = (this.sim as any).currentPrice?.(pair.long);
                            shortPx = (this.sim as any).currentPrice?.(pair.short);

                            if (longPx && shortPx) {
                                const longDir = longPos.positionSide === 'LONG' ? 1 : -1;
                                const shortDir = shortPos.positionSide === 'SHORT' ? -1 : 1;

                                longReduceAmt = Math.abs(longPos.positionAmt) * reductionPct;
                                shortReduceAmt = Math.abs(shortPos.positionAmt) * reductionPct;

                                const longRealized = (longPx - longPos.entryPrice) * longReduceAmt * longDir;
                                const shortRealized = (shortPx - shortPos.entryPrice) * shortReduceAmt * shortDir;

                                realized = longRealized + shortRealized;

                                // Reduce position sizes (sim stores positive magnitudes for both LONG and SHORT)
                                longPos.positionAmt = Math.max(0, longPos.positionAmt - longReduceAmt);
                                shortPos.positionAmt = Math.max(0, shortPos.positionAmt - shortReduceAmt);
                            }
                        }
                    } catch (e) {
                        this.log('position reduction calculation error: %o', e);
                    }

                    await ordersLedger.append('pair_reduce', {
                        pair,
                        reductionPct,
                        realizedPnlUsd: realized,
                        leverage: positionLeverage,
                        legs: [
                            (typeof longPx === 'number' && longReduceAmt > 0) ? { symbol: pair.long, side: 'SELL', qty: longReduceAmt, price: longPx } : undefined,
                            (typeof shortPx === 'number' && shortReduceAmt > 0) ? { symbol: pair.short, side: 'BUY', qty: shortReduceAmt, price: shortPx } : undefined
                        ].filter(Boolean)
                    });
                    // Accumulate realized into active_pairs
                    try {
                        const { getDb } = await import('../db/sqlite.js');
                        const { SqliteRepo } = await import('../services/sqliteRepo.js');
                        const repo = new SqliteRepo(await getDb());
                        repo.addRealizedToActivePair(pair.long, pair.short, realized);
                    } catch { }
                    this.log('REDUCE signal processed for pair %s/%s - positions reduced by 50%, realized PnL: $%s (leverage: %sx)', pair.long, pair.short, realized.toFixed(2), positionLeverage);
                } catch (e) {
                    this.log('pair reduce error: %o', e);
                    await ordersLedger.append('pair_reduce_error', { pair: parsed.pair, error: String(e) });
                }
            } else if (parsed && parsed.mode === 'PAIR' && parsed.signal === 'EXIT' && parsed.pair?.long && parsed.pair?.short) {
                // Compute realized PnL and close both legs via simulator, then record exit
                try {
                    const pair = parsed.pair;
                    // Capture entry refs before closing
                    const longPosPre = (this.sim as any).positions?.find((p: any) => p.symbol === pair.long);
                    const shortPosPre = (this.sim as any).positions?.find((p: any) => p.symbol === pair.short);
                    const longEntryRef = longPosPre?.entryPrice;
                    const shortEntryRef = shortPosPre?.entryPrice;
                    // Compute realized using simulator (removes positions)
                    let realized = 0;
                    try {
                        const longClose = (this.sim as any).closePosition?.(pair.long);
                        const shortClose = (this.sim as any).closePosition?.(pair.short);
                        realized = (longClose?.realizedPnl ?? 0) + (shortClose?.realizedPnl ?? 0);
                        // Log exit with both entryRef and exit prices
                        await ordersLedger.append('pair_exit', {
                            pair,
                            realizedPnlUsd: realized,
                            legs: [
                                longClose ? { symbol: pair.long, side: 'SELL', qty: longClose.exitQty, entryRef: longEntryRef, exitPrice: longClose.exitPrice } : undefined,
                                shortClose ? { symbol: pair.short, side: 'BUY', qty: shortClose.exitQty, entryRef: shortEntryRef, exitPrice: shortClose.exitPrice } : undefined
                            ].filter(Boolean)
                        });
                    } catch { /* ignore */ }

                    // Close active pair in SQL
                    try {
                        const { getDb } = await import('../db/sqlite.js');
                        const { SqliteRepo } = await import('../services/sqliteRepo.js');
                        const repo = new SqliteRepo(await getDb());
                        repo.closeActivePair(pair.long, pair.short, realized);
                    } catch { }
                } catch { /* ignore */ }
            }
        } catch (e) {
            this.log('order-sim error: %o', e);
            await this.ledger.append('order_error', { error: String(e) });
        }
    }
}

function extractJsonBlock(text?: string): string | undefined {
    if (!text) return undefined;
    // Match triple backtick fenced JSON or generic code blocks
    const fenceMatch = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
    if (fenceMatch && fenceMatch[1]) return fenceMatch[1].trim();
    return undefined;
}

