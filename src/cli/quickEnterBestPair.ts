import { promises as fs } from 'fs';
import createDebug from 'debug';
import { JsonlLedger } from '../persistence/jsonlLedger.js';
import { SimulatedExchange } from '../sim/simulatedExchange.js';
import { PriceMonitorService } from '../services/priceMonitorService.js';

type Pair = {
    sector?: string;
    ecosystem?: string;
    assetType?: string;
    long: string;
    short: string;
    corr?: number;
    beta?: number;
    spreadZ?: number;
    cointegration?: { halfLife?: number | null; stationary?: boolean };
    scores?: { composite?: number };
};

const log = createDebug('agent:quick');

async function waitForPrices(pm: PriceMonitorService, symbols: string[], timeoutMs = 10000): Promise<Record<string, number>> {
    const started = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const out: Record<string, number> = {};
        let ready = true;
        for (const s of symbols) {
            const snap: any = pm.get(s);
            const mid = (snap?.mid != null) ? snap.mid : (Number.isFinite(snap?.last) ? snap.last : undefined);
            if (mid == null) { ready = false; break; }
            out[s] = mid;
        }
        if (ready) return out;
        if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for prices for ${symbols.join(',')}`);
        await new Promise(r => setTimeout(r, 100));
    }
}

async function main(): Promise<void> {
    const text = await fs.readFile('sim_data/pairs.json', 'utf8');
    const data = JSON.parse(text);
    const pairs: Pair[] = Array.isArray(data?.pairs) ? data.pairs : [];
    if (!pairs.length) throw new Error('no pairs available in sim_data/pairs.json');

    const strictPairs = pairs.filter(p => (p.cointegration?.stationary === true) && ((p.cointegration?.halfLife ?? Infinity) <= 3) && Math.abs(p.spreadZ ?? 0) >= 1.1);
    const candidateList = strictPairs.length ? strictPairs : pairs.filter(p => (p.cointegration?.stationary === true) && ((p.cointegration?.halfLife ?? Infinity) <= 5));
    if (!candidateList.length) throw new Error('no eligible pairs after filters');
    candidateList.sort((a, b) => (b.scores?.composite ?? 0) - (a.scores?.composite ?? 0));
    const best = candidateList[0];
    if (!best || !best.long || !best.short) throw new Error('invalid best pair');
    const longSym = best.long;
    const shortSym = best.short;
    const beta = Number.isFinite(best.beta) ? (best.beta as number) : 1;

    const baseBalance = Number(process.env.QUICK_BASE_BALANCE || '10000');
    const longNotional = Number(process.env.QUICK_LONG_NOTIONAL || String(Math.floor(baseBalance * 0.2)));
    const shortNotional = longNotional * beta;
    const lev = Number(process.env.QUICK_LEVERAGE || '10');

    const wsBase = (process.env.ASTER_WS_URL || 'wss://fstream.asterdex.com');
    const priceMon = new PriceMonitorService(wsBase, [longSym, shortSym]);
    priceMon.start();

    const sim = new SimulatedExchange([
        { symbol: longSym, price: 1 },
        { symbol: shortSym, price: 1 }
    ] as any);
    const ledger = new JsonlLedger('sim_data/orders.jsonl');

    const prices = await waitForPrices(priceMon, [longSym, shortSym], Number(process.env.QUICK_PRICE_TIMEOUT || '15000'));
    const longPx = prices[longSym];
    const shortPx = prices[shortSym];
    if (longPx == null || shortPx == null) throw new Error('prices unavailable');
    sim.setMid(longSym, longPx);
    sim.setMid(shortSym, shortPx);

    const qtyLong = longNotional / longPx;
    const qtyShort = shortNotional / shortPx;

    await ledger.append('order_plan', {
        pair: { long: longSym, short: shortSym, corr: best.corr, beta: best.beta, spreadZ: best.spreadZ, halfLife: best.cointegration?.halfLife },
        long: { symbol: longSym, sizeUsd: longNotional },
        short: { symbol: shortSym, sizeUsd: shortNotional },
        risk: { long: { leverage: lev }, short: { leverage: lev } }
    });

    const ordL = sim.placeOrder({ symbol: longSym, side: 'BUY', type: 'MARKET', quantity: qtyLong, leverage: lev, price: longPx } as any);
    const ordS = sim.placeOrder({ symbol: shortSym, side: 'SELL', type: 'MARKET', quantity: qtyShort, leverage: lev, price: shortPx } as any);
    await ledger.append('order', ordL);
    await ledger.append('order', ordS);

    log('entered best pair %s/%s longNotional=%d shortNotional=%d @ prices %d/%d', longSym, shortSym, longNotional, shortNotional, longPx, shortPx);
}

// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
});


