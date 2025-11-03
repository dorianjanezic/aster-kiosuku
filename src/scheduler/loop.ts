/**
 * SCHEDULER LOOP
 *
 * Main execution loop that orchestrates the periodic running of the
 * trading agent. Manages the timing and coordination of:
 * - Market data updates and price feeds
 * - Portfolio state synchronization
 * - Trading agent decision cycles
 * - Data logging and persistence
 *
 * This component ensures the trading system operates continuously
 * with proper timing and state management between cycles.
 */

import { StateService } from '../services/stateService.js';
import { JsonlLedger } from '../persistence/jsonlLedger.js';
import { Orchestrator } from '../agent/orchestrator.js';
import { PublicClient } from '../http/publicClient.js';
import { SimulatedExchange } from '../sim/simulatedExchange.js';
import { PriceMonitorService } from '../services/priceMonitorService.js';

export class SchedulerLoop {
    constructor(private intervalMs: number) { }

    start(): void {
        const client = new PublicClient(process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com', process.env.ASTER_BASE_PATH || '/fapi/v1');
        const sim = new SimulatedExchange([
            { symbol: 'BTCUSDT', price: 108000 },
            { symbol: 'ETHUSDT', price: 3800 },
            { symbol: 'SOLUSDT', price: 184 }
        ]);
        const state = new StateService('sim_data/orders.jsonl', sim);
        const ledger = new JsonlLedger('sim_data/cycles.jsonl');
        const portfolioLedger = new JsonlLedger('sim_data/portfolio.jsonl');
        // Start live price monitor (assumes Aster WS base like wss://fapi.asterdex.com/ws or /stream)
        const wsBase = (process.env.ASTER_WS_URL || 'wss://fstream.asterdex.com');
        const priceMon = new PriceMonitorService(`${wsBase}`, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
        // Optional override for path-style WS endpoints
        // e.g., export ASTER_WS_MODE=paths ASTER_WS_PATH=/ws
        try { priceMon.start(); } catch { }

        // Periodically sync mid prices for known majors and any symbols with open positions
        setInterval(() => {
            const base = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
            const posSyms = sim.listPositions().map(p => p.symbol);
            const symbols = Array.from(new Set([...base, ...posSyms]));
            // ensure dynamic subscription for new symbols
            try { priceMon.addSymbols(symbols); } catch { }
            for (const s of symbols) {
                const snap = priceMon.get(s);
                const spread = (snap?.bestAsk && snap?.bestBid) ? (snap.bestAsk - snap.bestBid) : undefined;
                const mid = (snap?.mid != null) ? snap.mid : (Number.isFinite(snap?.last) ? (snap as any).last as number : undefined);
                if (mid != null) {
                    sim.setMid(s, mid, spread);
                } else {
                    // eslint-disable-next-line no-console
                    console.debug('[prices] no mid yet for', s);
                }
            }
        }, 5000);

        const orchestrator = new Orchestrator(client, sim, ledger);
        const tick = async () => {
            const started = Date.now();
            try {
                const account = await state.getAccountState();
                const positions = sim.listPositions().map(p => {
                    const signedQty = p.positionSide === 'LONG' ? p.positionAmt : -p.positionAmt;
                    const mid = (() => { try { return sim.getTicker(p.symbol).price; } catch { return undefined; } })();
                    return {
                        symbol: p.symbol,
                        direction: p.positionSide,
                        entryPrice: p.entryPrice,
                        qty: signedQty,
                        mid,
                        unrealizedPnl: p.unrealizedPnl,
                        leverage: p.leverage
                    };
                });
                const recent = await state.getRecentOrders(50);
                await ledger.append('cycle', { started, account, positions, recent });
                await portfolioLedger.append('portfolio', { account, positions });
                await orchestrator.runOnce();
                // Post-execution portfolio snapshot to capture changes from new orders
                const postAccount = await state.getAccountState();
                const postPositions = sim.listPositions().map(p => {
                    const signedQty = p.positionSide === 'LONG' ? p.positionAmt : -p.positionAmt;
                    const mid = (() => { try { return sim.getTicker(p.symbol).price; } catch { return undefined; } })();
                    return {
                        symbol: p.symbol,
                        direction: p.positionSide,
                        entryPrice: p.entryPrice,
                        qty: signedQty,
                        mid,
                        unrealizedPnl: p.unrealizedPnl,
                        leverage: p.leverage
                    };
                });
                await portfolioLedger.append('portfolio', { account: postAccount, positions: postPositions });
            } catch (e) {
                await ledger.append('error', { started, error: String(e) });
            }
        };
        void tick();
        setInterval(() => { void tick(); }, this.intervalMs);
    }
}

