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
import { JsonlLedger } from '../persistence/jsonlLedger.js';
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
import { pctChanges, pearson, betaYOnX } from '../lib/stats.js';

export class Orchestrator {
    private provider: LLMProvider;
    private log = createDebug('agent:orchestrator');

    constructor(private client: PublicClient, private sim: SimulatedExchange, private ledger: JsonlLedger) {
        this.provider = createProviderFromEnv();
    }

    async runOnce(): Promise<void> {
        // Research disabled in no-tools mode

        // Disabled tools mode: prefetch state + technicals for majors and do a single JSON response
        const ordersLedger = new JsonlLedger('sim_data/orders.jsonl');
        const exec = createExecutionProvider((process.env.MODE as any) === 'live' ? 'live' : 'paper', this.sim);
        const handlers = createToolHandlers({ client: this.client, sim: this.sim, ledger: this.ledger, ordersLedger });
        const rawPositions = await handlers.get_positions();
        const positions = (rawPositions || []).map((p: any) => ({
            symbol: p.symbol,
            direction: p.positionSide,
            entryPrice: p.entryPrice,
            qty: p.positionSide === 'LONG' ? p.positionAmt : -p.positionAmt,
            unrealizedPnl: p.unrealizedPnl,
            leverage: p.leverage
        }));
        const account = await handlers.get_account_state();
        // recent orders (last 10 min)
        const stateSvc = new StateService('sim_data/orders.jsonl', this.sim);
        const recentOrders = await stateSvc.getRecentOrders(100);
        // Pair-focused mode: skip per-asset technicals/market snapshot for majors
        const technicals: Record<string, Record<string, any>> = {};
        const market: Record<string, any> = {};
        // Refresh markets computed/metrics, then build pair candidates
        try { await updateMarketsBuckets(this.client, 'sim_data/markets.json', { interval: '15m', limit: 200, concurrency: 6 }); this.log('buckets: refreshed'); } catch (e) { this.log('buckets error %o', e); }
        // Build pair candidates with our improved statistical analysis
        let pairs: Array<{ sector?: string; ecosystem?: string; assetType?: string; long: string; short: string; corr?: number; beta?: number; scores?: any; spreadZ?: number; cointegration?: any; fundingNet?: number }> = [];
        try {
            const res = await buildPairCandidates('sim_data/markets.json', 10, this.client);
            pairs = res.pairs.slice(0, 10);

            // Add spot reference prices for TP/SL calculation context
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

            // Persist pairs for inspection and as a dedicated ledger
            try { await this.ledger.append('pairs_snapshot', { pairs }); } catch { }
            try {
                const pairsLedger = new JsonlLedger('sim_data/pairs.jsonl');
                await pairsLedger.append('pairs', { asOf: Date.now(), pairs });
            } catch { }
            try {
                const { promises: fs } = await import('fs');
                await fs.writeFile('sim_data/pairs.json', JSON.stringify({ asOf: Date.now(), pairs }, null, 2));
            } catch { }
        } catch (e) {
            this.log('pairs building error: %o', e);
            await this.ledger.append('pairs_error', { error: String(e) });
        }

        // Load persisted pair baselines (entry metrics) if available
        let pairBaselines: Record<string, { entryTime: number; entrySpreadZ?: number; entryHalfLife?: number | null }> = {};
        try {
            const { promises: fs } = await import('fs');
            const txt = await fs.readFile('sim_data/pairs_state.json', 'utf8');
            pairBaselines = JSON.parse(txt);
        } catch { /* ignore missing */ }

        // Derive active pair performance from current open positions and latest pair stats
        const activePairs: Array<{ long: string; short: string; pnlUsd: number; spreadZ?: number; halfLife?: number | null; entrySpreadZ?: number; deltaSpreadZ?: number; entryHalfLife?: number | null; deltaHalfLife?: number | null; entryTime?: number; elapsedMs?: number }> = [];
        try {
            // Build map of current pair statistics from latest pair data
            const pairStatsMap = new Map<string, { spreadZ?: number; halfLife?: number | null }>();
            const createPairKey = (a: string, b: string) => `${a}|${b}`;

            // Add stats from current pairs
            for (const p of pairs) {
                const pairKey = createPairKey(p.long, p.short);
                pairStatsMap.set(pairKey, {
                    spreadZ: (p as any)?.spreadZ,
                    halfLife: (p as any)?.cointegration?.halfLife ?? null
                });
            }

            // Fallback: add stats from persisted pairs if not in current top pairs
            try {
                const { promises: fs } = await import('fs');
                const txt = await fs.readFile('sim_data/pairs.json', 'utf8');
                const parsed = JSON.parse(txt);
                const persistedPairs = Array.isArray(parsed?.pairs) ? parsed.pairs : [];

                for (const p of persistedPairs) {
                    if (!p?.long || !p?.short) continue;
                    const pairKey = createPairKey(p.long, p.short);
                    if (!pairStatsMap.has(pairKey)) {
                        pairStatsMap.set(pairKey, {
                            spreadZ: (p as any)?.spreadZ,
                            halfLife: (p as any)?.cointegration?.halfLife ?? null
                        });
                    }
                }

                // Additional fallback: get stats from active pairs state for pairs no longer in candidates
                const stateTxt = await fs.readFile('sim_data/pairs_state.json', 'utf8');
                const stateData = JSON.parse(stateTxt);
                for (const [pairKey, pairState] of Object.entries(stateData) as [string, any][]) {
                    if (!pairStatsMap.has(pairKey) && pairState.entryHalfLife != null) {
                        // Use the most recent half-life from history
                        const latestHistory = pairState.history?.[pairState.history.length - 1];
                        const currentHalfLife = latestHistory?.halfLife ?? pairState.entryHalfLife;
                        pairStatsMap.set(pairKey, {
                            spreadZ: latestHistory?.spreadZ ?? pairState.entrySpreadZ,
                            halfLife: currentHalfLife
                        });
                    }
                }
            } catch (e) {
                this.log('fallback pair stats loading error: %o', e);
            }

            // Group positions by symbol for efficient lookup
            const positionBySymbol = new Map<string, typeof positions[0]>();
            for (const pos of positions) {
                positionBySymbol.set(pos.symbol, pos);
            }

            // Find active pairs by identifying long/short position pairs
            const processedPairs = new Set<string>();
            const usedSymbols = new Set<string>();

            for (const pos1 of positions) {
                if (usedSymbols.has(pos1.symbol)) continue;

                for (const pos2 of positions) {
                    if (pos1 === pos2 || usedSymbols.has(pos2.symbol)) continue;

                    // Check if these positions form a pair (one long, one short)
                    const isPair = (pos1.direction === 'LONG' && pos2.direction === 'SHORT') ||
                        (pos1.direction === 'SHORT' && pos2.direction === 'LONG');

                    if (!isPair) continue;

                    const longSymbol = pos1.direction === 'LONG' ? pos1.symbol : pos2.symbol;
                    const shortSymbol = pos1.direction === 'SHORT' ? pos1.symbol : pos2.symbol;
                    const pairId = createPairKey(longSymbol, shortSymbol);

                    if (processedPairs.has(pairId)) continue;

                    // Check if we have baseline data for this pair
                    const baseline = pairBaselines[pairId];
                    if (!baseline) continue;

                    // Mark as processed
                    processedPairs.add(pairId);
                    usedSymbols.add(longSymbol);
                    usedSymbols.add(shortSymbol);

                    let currentStats = pairStatsMap.get(pairId);

                    // For active pairs, ensure we have stats from pairs_state.json if available
                    if (!currentStats) {
                        try {
                            const { promises: fs } = await import('fs');
                            const stateTxt = await fs.readFile('sim_data/pairs_state.json', 'utf8');
                            const stateData = JSON.parse(stateTxt);
                            const pairState = stateData[pairId];
                            if (pairState) {
                                const latestHistory = pairState.history?.[pairState.history.length - 1];
                                currentStats = {
                                    spreadZ: latestHistory?.spreadZ ?? pairState.entrySpreadZ,
                                    halfLife: latestHistory?.halfLife ?? pairState.entryHalfLife
                                };
                            }
                        } catch (e) {
                            // Ignore errors, currentStats remains undefined
                        }
                    }

                    const longPos = positionBySymbol.get(longSymbol);
                    const shortPos = positionBySymbol.get(shortSymbol);

                    if (!longPos || !shortPos) {
                        this.log('missing position data for pair %s', pairId);
                        continue;
                    }

                    // Calculate combined P&L
                    const pnlUsd = (longPos.unrealizedPnl ?? 0) + (shortPos.unrealizedPnl ?? 0);

                    // Calculate deltas from entry
                    const entrySpreadZ = baseline.entrySpreadZ;
                    const deltaSpreadZ = (typeof currentStats?.spreadZ === 'number' && typeof entrySpreadZ === 'number')
                        ? (currentStats.spreadZ - entrySpreadZ)
                        : undefined;

                    const entryHalfLife = baseline.entryHalfLife;
                    const currentHalfLife = currentStats?.halfLife ?? null;
                    const deltaHalfLife = (entryHalfLife != null && currentHalfLife != null)
                        ? (currentHalfLife - entryHalfLife)
                        : null;

                    const elapsedMs = (typeof baseline.entryTime === 'number')
                        ? (Date.now() - baseline.entryTime)
                        : undefined;

                    // Calculate convergence metrics
                    const convergenceProgress = deltaSpreadZ != null && entrySpreadZ != null ?
                        Math.abs(deltaSpreadZ) / Math.abs(entrySpreadZ) : null;

                    // Calculate exit signals
                    const exitSignals = {
                        profitTarget: Math.abs(currentStats?.spreadZ || 0) <= 0.5,
                        timeStop: currentHalfLife != null && elapsedMs != null &&
                            (elapsedMs / (1000 * 60 * 60)) >= (2 * currentHalfLife), // 2 * halfLife in hours
                        convergence: convergenceProgress != null && convergenceProgress >= 0.5,
                        riskReduction: pnlUsd <= -40, // Reduce at -$40 loss (~2% of $2000 position)
                        riskExit: pnlUsd <= -100 // Exit at -$100 loss (~5% of $2000 position)
                    };

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
                        entryTime: baseline.entryTime,
                        elapsedMs,
                        convergenceProgress,
                        exitSignals
                    } as any);
                }
            }

            this.log('identified %d active pairs from %d positions', activePairs.length, positions.length);
        } catch (e) {
            this.log('active pairs calculation error: %o', e);
            await this.ledger.append('active_pairs_error', { error: String(e) });
        }

        // Persist per-cycle snapshots for active pairs into pairs_state.json (history)
        try {
            const { promises: fs } = await import('fs');
            const statePath = 'sim_data/pairs_state.json';
            let state: Record<string, any> = {};
            try { const txt = await fs.readFile(statePath, 'utf8'); state = JSON.parse(txt); } catch { }
            for (const ap of activePairs) {
                const id = `${ap.long}|${ap.short}`;
                if (!state[id]) state[id] = { entryTime: ap.entryTime ?? Date.now(), entrySpreadZ: ap.entrySpreadZ, entryHalfLife: ap.halfLife, history: [] };
                if (!Array.isArray(state[id].history)) state[id].history = [];
                const currentElapsedMs = Date.now() - state[id].entryTime;
                state[id].history.push({ ts: Date.now(), spreadZ: ap.spreadZ, pnlUsd: ap.pnlUsd, halfLife: ap.halfLife, entrySpreadZ: ap.entrySpreadZ, deltaSpreadZ: ap.deltaSpreadZ, entryHalfLife: ap.entryHalfLife, deltaHalfLife: ap.deltaHalfLife, elapsedMs: currentElapsedMs });
            }
            await fs.mkdir('sim_data', { recursive: true });
            await fs.writeFile(statePath, JSON.stringify(state, null, 2));
        } catch { }

        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
            { role: 'system', content: getSystemPrompt() },
            { role: 'user', content: getUserPrompt({ account, positions, pairs, activePairs }) }
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

        const searchParameters = {
            mode: shouldSearch ? "auto" : "off", // Only search every few cycles to avoid rate limits
            return_citations: true,
            max_search_results: 5, // Reduced from 10 to save costs
            sources: [
                { type: "x" } // Focus on X/Twitter for sentiment, skip news/web to reduce API calls
            ]
        };

        let assistantText: string | undefined;
        try {
            const response = await this.provider.chatWithTools(messages, [], {
                responseFormat: decisionSchema,
                searchParameters
            } as any);
            assistantText = response.assistantText;
        } catch (e) {
            this.log('LLM chat failed: %o', e);
            await this.ledger.append('llm_error', { round: 0, error: String(e) });
            await this.ledger.append('round_end', { round: 0 });
            return; // Exit early if LLM fails
        }

        // Log raw assistant output
        try {
            await this.ledger.append('assistant_raw', { round: 0, content: assistantText });
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

                // Check for inverse pairs (A/B when B/A already exists)
                const inverseExists = currentPairs.some(p =>
                    (p.long === parsed.pair.short && p.short === parsed.pair.long)
                );

                if (!hasCapacity || symbolOverlaps || inverseExists) {
                    const reason = !hasCapacity ? 'capacity_reached' :
                        inverseExists ? 'inverse_pair_exists' :
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

                // Persist pair baseline (entry metrics) for delta tracking
                try {
                    const { promises: fs } = await import('fs');
                    const id = `${pair.long}|${pair.short}`;
                    const statePath = 'sim_data/pairs_state.json';
                    let state: Record<string, any> = {};
                    try { const txt = await fs.readFile(statePath, 'utf8'); state = JSON.parse(txt); } catch { }
                    const entrySpreadZ = parsed?.pair?.spreadZ;
                    const entryHalfLife = parsed?.pair?.halfLife ?? null;
                    const nowTs = Date.now();
                    state[id] = { entryTime: nowTs, entrySpreadZ, entryHalfLife, history: [{ ts: nowTs, spreadZ: entrySpreadZ, pnlUsd: 0, halfLife: entryHalfLife, entrySpreadZ, deltaSpreadZ: 0, entryHalfLife, deltaHalfLife: null, elapsedMs: 0 }] };
                    await fs.mkdir('sim_data', { recursive: true });
                    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
                } catch { }
            } else if (parsed && parsed.mode === 'PAIR' && parsed.signal === 'REDUCE' && parsed.pair?.long && parsed.pair?.short) {
                // Reduce position size by 50% for risk management
                try {
                    const pair = parsed.pair;
                    const reductionPct = 0.5; // Reduce to 50% of current size

                    // Calculate realized PnL from partial close
                    let realized = 0;
                    let positionLeverage = 1;
                    try {
                        // Get current position sizes and reduce them
                        const longPos = (this.sim as any).positions?.find((p: any) => p.symbol === pair.long);
                        const shortPos = (this.sim as any).positions?.find((p: any) => p.symbol === pair.short);

                        if (longPos && shortPos) {
                            positionLeverage = longPos.leverage || 1;
                            // Calculate realized PnL from reducing 50% of positions
                            const longPx = (this.sim as any).currentPrice?.(pair.long);
                            const shortPx = (this.sim as any).currentPrice?.(pair.short);

                            if (longPx && shortPx) {
                                const longDir = longPos.positionSide === 'LONG' ? 1 : -1;
                                const shortDir = shortPos.positionSide === 'SHORT' ? -1 : 1;

                                const longReduceAmt = longPos.positionAmt * reductionPct;
                                const shortReduceAmt = Math.abs(shortPos.positionAmt) * reductionPct;

                                const longRealized = (longPx - longPos.entryPrice) * longReduceAmt * longDir;
                                const shortRealized = (shortPx - shortPos.entryPrice) * shortReduceAmt * shortDir;

                                realized = longRealized + shortRealized;

                                // Reduce position sizes
                                longPos.positionAmt -= longReduceAmt;
                                shortPos.positionAmt += shortReduceAmt; // SHORT positions are negative
                            }
                        }
                    } catch (e) {
                        this.log('position reduction calculation error: %o', e);
                    }

                    await ordersLedger.append('pair_reduce', { pair, reductionPct, realizedPnlUsd: realized, leverage: positionLeverage });
                    this.log('REDUCE signal processed for pair %s/%s - positions reduced by 50%, realized PnL: $%s (leverage: %sx)', pair.long, pair.short, realized.toFixed(2), positionLeverage);
                } catch (e) {
                    this.log('pair reduce error: %o', e);
                    await ordersLedger.append('pair_reduce_error', { pair: parsed.pair, error: String(e) });
                }
            } else if (parsed && parsed.mode === 'PAIR' && parsed.signal === 'EXIT' && parsed.pair?.long && parsed.pair?.short) {
                // Compute realized PnL and close both legs via simulator, then record exit
                try {
                    const pair = parsed.pair;
                    // Compute realized using simulator (removes positions)
                    let realized = 0;
                    try {
                        const longClose = (this.sim as any).closePosition?.(pair.long);
                        const shortClose = (this.sim as any).closePosition?.(pair.short);
                        realized = (longClose?.realizedPnl ?? 0) + (shortClose?.realizedPnl ?? 0);
                    } catch { /* ignore */ }

                    // Retrieve complete pair metadata from pairs_state.json to avoid null values in exit logs
                    let completePair = pair;
                    try {
                        const { promises: fs } = await import('fs');
                        const statePath = 'sim_data/pairs_state.json';
                        const stateTxt = await fs.readFile(statePath, 'utf8');
                        const state: Record<string, any> = JSON.parse(stateTxt);
                        const id = `${pair.long}|${pair.short}`;
                        if (state[id]) {
                            // Get the latest spread data from history for current stats
                            const history = state[id].history || [];
                            const latest = history[history.length - 1];
                            completePair = {
                                sector: state[id].sector || pair.sector,
                                ecosystem: state[id].ecosystem || pair.ecosystem,
                                assetType: state[id].assetType || pair.assetType,
                                long: pair.long,
                                short: pair.short,
                                corr: state[id].corr || pair.corr,
                                beta: state[id].beta || pair.beta,
                                spreadZ: latest?.spreadZ || state[id].entrySpreadZ || pair.spreadZ,
                                halfLife: latest?.halfLife || state[id].entryHalfLife || pair.halfLife
                            };
                        }
                    } catch { /* ignore - fall back to parsed pair */ }

                    await ordersLedger.append('pair_exit', { pair: completePair, realizedPnlUsd: realized });
                    // Update pairs_state to mark closed and persist realized PnL
                    try {
                        const { promises: fs } = await import('fs');
                        const statePath = 'sim_data/pairs_state.json';
                        let state: Record<string, any> = {};
                        try { const txt = await fs.readFile(statePath, 'utf8'); state = JSON.parse(txt); } catch { }
                        const id = `${pair.long}|${pair.short}`;
                        if (!state[id]) state[id] = {};
                        state[id].closedAt = Date.now();
                        state[id].realizedPnlUsd = realized;
                        await fs.writeFile(statePath, JSON.stringify(state, null, 2));
                    } catch { /* ignore */ }
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

