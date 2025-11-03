/**
 * EXCHANGE SIMULATION CLI TOOL
 *
 * Command-line utility for testing simulated exchange functionality.
 * Demonstrates order placement, position management, and trade execution
 * in a controlled environment without real capital risk.
 *
 * Useful for:
 * - Testing order types and execution logic
 * - Validating position sizing and leverage calculations
 * - Debugging trading strategy implementations
 * - Demonstrating exchange behavior patterns
 */

import { SimulatedExchange } from '../sim/simulatedExchange.js';
import { JsonlLedger } from '../persistence/jsonlLedger.js';

async function main() {
    const sim = new SimulatedExchange([
        { symbol: 'BTCUSDT', price: 65000 },
        { symbol: 'ETHUSDT', price: 3200 }
    ]);
    const ledger = new JsonlLedger('sim_data/orders.jsonl');

    const order1 = sim.placeOrder({
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.01,
        reduceOnly: false
    });
    console.log('order1', order1);
    await ledger.append('order', order1);

    const order2 = sim.placeOrder({
        symbol: 'ETHUSDT',
        side: 'SELL',
        type: 'LIMIT',
        quantity: 0.5,
        price: 3190,
        timeInForce: 'GTC'
    });
    console.log('order2', order2);
    await ledger.append('order', order2);

    const amended = sim.amendOrder({ symbol: 'ETHUSDT', orderId: order2.orderId, price: 3210 });
    console.log('amended', amended);
    await ledger.append('amend', amended);

    const cancelled = sim.cancelOrder({ symbol: 'ETHUSDT', orderId: amended.orderId });
    console.log('cancelled', cancelled);
    await ledger.append('cancel', cancelled);
}

main().catch((err) => {
    console.error(err);
});

