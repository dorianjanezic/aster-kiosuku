import { promises as fs } from 'fs';
import createDebug from 'debug';
// import { JsonlLedger } from '../persistence/jsonlLedger.js';
import { SqlEventLedger } from '../persistence/sqlEventLedger.js';
import { SimulatedExchange } from '../sim/simulatedExchange.js';
import { PriceMonitorService } from '../services/priceMonitorService.js';
import { StateService } from '../services/stateService.js';

type OrderLine = { ts: number; type: string; data: any };

const log = createDebug('agent:quickwatch');

async function readOrdersFromSql(limit = 1000): Promise<OrderLine[]> {
    try {
        const { getDb } = await import('../db/sqlite.js');
        const db = await getDb();
        const rows = db.prepare('SELECT ts, type, raw_json FROM orders WHERE type = ? ORDER BY ts ASC LIMIT ?').all('order', limit) as any[];
        return rows.map(r => ({ ts: r.ts, type: 'order', data: JSON.parse(r.raw_json)?.data })) as any;
    } catch {
        return [];
    }
}

async function main(): Promise<void> {
    const ledger = new SqlEventLedger();
    const lines = await readOrdersFromSql(5000);
    const filled = lines.filter((l) => l?.type === 'order' && l?.data?.status === 'FILLED');

    // Gather symbols
    const symbols = Array.from(new Set(filled.map((l) => String(l.data.symbol))));
    if (!symbols.length) throw new Error('no filled orders to watch');

    // Initialize sim with seed prices (use last order price for each symbol)
    const lastPriceBySym = new Map<string, number>();
    for (const s of symbols) {
        const last = [...filled].reverse().find((l) => String(l.data.symbol) === s);
        if (last) lastPriceBySym.set(s, Number(last.data.price) || 1);
    }
    const sim = new SimulatedExchange(symbols.map((s) => ({ symbol: s, price: lastPriceBySym.get(s) || 1 })) as any);

    // Replay orders to rebuild positions
    for (const l of filled) {
        const symbol: string = l.data.symbol;
        const side: 'BUY' | 'SELL' = l.data.side;
        const qty: number = Number(l.data.executedQty);
        const px: number = Number(l.data.price) || lastPriceBySym.get(symbol) || 1;
        sim.setMid(symbol, px);
        sim.placeOrder({ symbol, side, type: 'MARKET', quantity: qty, leverage: 10, price: px } as any);
    }

    // Start price monitor
    const wsBase = (process.env.ASTER_WS_URL || 'wss://fstream.asterdex.com');
    const priceMon = new PriceMonitorService(wsBase, symbols);
    priceMon.start();

    // State service to compute equity and PnL
    const state = new StateService('sim_data/orders.jsonl', sim);

    // Periodically sync mids and write cycle snapshot
    const sync = () => {
        for (const s of symbols) {
            const snap: any = priceMon.get(s);
            const mid = (snap?.mid != null) ? snap.mid : (Number.isFinite(snap?.last) ? snap.last : undefined);
            if (mid != null) sim.setMid(s, mid, (snap?.bestAsk && snap?.bestBid) ? (snap.bestAsk - snap.bestBid) : undefined);
        }
    };
    setInterval(sync, 2000);

    const tick = async () => {
        const started = Date.now();
        try {
            const account = await state.getAccountState();
            const positions = sim.listPositions();
            await ledger.append('cycle', { started, account, positions, recent: [] });
        } catch (e) {
            await ledger.append('error', { started, error: String(e) });
        }
    };
    log('watching %o', symbols);
    await tick();
    setInterval(() => { void tick(); }, Number(process.env.QUICK_WATCH_INTERVAL || '5000'));
}

// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
});







