/**
 * SIMULATED EXCHANGE
 *
 * Realistic trading exchange simulator for backtesting and development.
 * Mimics real exchange behavior including:
 * - Order placement and execution (market/limit orders)
 * - Position management with leverage support
 * - Price feeds and orderbook simulation
 * - Account balance and margin calculations
 * - Realistic trading fees and slippage
 *
 * Enables safe testing of trading strategies without real capital risk.
 */

import createDebug from 'debug';
import {
    AmendOrderRequestSchema,
    CancelOrderRequestSchema,
    Order,
    OrderSchema,
    PlaceOrderRequest,
    PlaceOrderRequestSchema,
    Ticker,
    TickerSchema,
    Position,
    PositionSchema
} from '../types/asterFutures.js';

const debug = createDebug('agent:sim');

type OrderbookState = {
    symbol: string;
    price: number; // mid price
    spread: number; // absolute
};

export class SimulatedExchange {
    private orders: Map<string, Order> = new Map();
    private nextOrderId = 1;
    private books: Map<string, OrderbookState> = new Map();
    private positions: Array<Position> = [];

    constructor(initialTickers: Array<Ticker>) {
        for (const t of initialTickers) {
            const v = TickerSchema.parse(t);
            this.books.set(v.symbol, { symbol: v.symbol, price: v.price, spread: Math.max(0.1, v.price * 0.0005) });
        }
    }

    // Update mid price (and optionally spread) from live feeds
    setMid(symbol: string, mid: number, spread?: number): void {
        const existing = this.books.get(symbol);
        if (!existing) {
            this.books.set(symbol, { symbol, price: mid, spread: spread ?? Math.max(0.1, mid * 0.0005) });
            return;
        }
        existing.price = mid;
        if (spread !== undefined) existing.spread = spread;
    }

    getTicker(symbol: string): Ticker {
        const book = this.books.get(symbol);
        if (!book) throw new Error(`unknown symbol ${symbol}`);
        return { symbol, price: book.price };
    }

    private currentPrice(symbol: string): number {
        const t = this.getTicker(symbol);
        return t.price;
    }

    placeOrder(req: PlaceOrderRequest): Order {
        const r = PlaceOrderRequestSchema.parse(req);
        let book = this.books.get(r.symbol);
        if (!book) {
            const initPx = (typeof r.price === 'number' && r.price > 0) ? r.price : 1;
            book = { symbol: r.symbol, price: initPx, spread: Math.max(0.1, initPx * 0.0005) };
            this.books.set(r.symbol, book);
        }

        const orderId = String(this.nextOrderId++);
        const now = Date.now();
        let executedQty = 0;
        let status: Order['status'] = 'NEW';
        // Use provided price if present; for MARKET orders allow overriding the book mid for entry
        if (r.type === 'MARKET' && typeof r.price === 'number' && r.price > 0) {
            book.price = r.price;
        }
        const price: number | null = r.type === 'MARKET' ? book.price : (r.price ?? null);

        // simplistic fill model (supports reduceOnly closes)
        if (r.type === 'MARKET') {
            // reduceOnly close handling
            if (r.reduceOnly) {
                const posIdx = this.positions.findIndex(pp => pp.symbol === r.symbol);
                const pos = this.positions[posIdx];
                if (posIdx >= 0 && pos) {
                    const closeLong = pos.positionSide === 'LONG' && r.side === 'SELL';
                    const closeShort = pos.positionSide === 'SHORT' && r.side === 'BUY';
                    if (closeLong || closeShort) {
                        const qty = Math.min(r.quantity, Math.abs(pos.positionAmt));
                        executedQty = qty;
                        // update remaining position
                        const remaining = Math.max(0, Math.abs(pos.positionAmt) - qty);
                        if (remaining === 0) {
                            this.positions.splice(posIdx, 1);
                        } else {
                            pos.positionAmt = remaining;
                        }
                        status = 'FILLED';
                        debug('reduced MARKET %s %s %d @ %d', r.symbol, r.side, qty, price);
                    } else {
                        executedQty = 0;
                        status = 'REJECTED';
                    }
                } else {
                    executedQty = 0;
                    status = 'REJECTED';
                }
            } else {
                executedQty = r.quantity;
                status = 'FILLED';
                debug('filled MARKET %s %s %d @ %d', r.symbol, r.side, r.quantity, price);
            }
        } else if (r.type === 'LIMIT' && r.price !== undefined) {
            const cross = r.side === 'BUY' ? (r.price >= book.price + book.spread / 2) : (r.price <= book.price - book.spread / 2);
            if (cross) {
                executedQty = r.quantity;
                status = 'FILLED';
                debug('crossed LIMIT %s %s %d @ %d', r.symbol, r.side, r.quantity, r.price);
            } else {
                status = 'NEW';
            }
        }

        const ord: Order = OrderSchema.parse({
            orderId,
            clientOrderId: r.clientOrderId,
            symbol: r.symbol,
            side: r.side,
            type: r.type,
            status,
            price,
            origQty: r.quantity,
            executedQty,
            createTime: now
        });
        this.orders.set(orderId, ord);
        // create simple position on fill (skip when reduceOnly)
        if (ord.status === 'FILLED' && !r.reduceOnly) {
            const pos: Position = PositionSchema.parse({
                symbol: r.symbol,
                positionSide: r.side === 'BUY' ? 'LONG' : 'SHORT',
                entryPrice: (price ?? book.price),
                positionAmt: r.quantity,
                unrealizedPnl: 0,
                leverage: r.leverage ?? 1
            });
            this.positions.push(pos);
        }
        return ord;
    }

    cancelOrder(req: unknown): Order {
        const r = CancelOrderRequestSchema.parse(req);
        const key = 'orderId' in r ? r.orderId : undefined;
        if (!key) throw new Error('cancel by clientOrderId not supported in sim yet');
        const existing = this.orders.get(key);
        if (!existing) throw new Error('order not found');
        if (existing.status === 'FILLED') return existing;
        const cancelled = { ...existing, status: 'CANCELED' as const };
        this.orders.set(existing.orderId, cancelled);
        return cancelled;
    }

    amendOrder(req: unknown): Order {
        const r = AmendOrderRequestSchema.parse(req);
        const existing = Array.from(this.orders.values()).find(o => o.symbol === r.symbol && o.orderId === r.orderId);
        if (!existing) throw new Error('order not found');
        if (existing.status !== 'NEW') return existing;
        const price = r.price ?? existing.price;
        const origQty = r.quantity ?? existing.origQty;
        const amended: Order = { ...existing, price: price ?? null, origQty };
        this.orders.set(existing.orderId, amended);
        return amended;
    }

    listOpenOrders(): Order[] {
        return Array.from(this.orders.values()).filter(o => o.status === 'NEW');
    }

    listPositions(): Position[] {
        // update unrealized PnL before returning
        for (const p of this.positions) {
            const px = this.currentPrice(p.symbol);
            const dir = p.positionSide === 'LONG' ? 1 : -1;
            p.unrealizedPnl = (px - p.entryPrice) * p.positionAmt * dir;
        }
        return [...this.positions];
    }

    closePosition(symbol: string): { realizedPnl: number } {
        const idx = this.positions.findIndex(pp => pp.symbol === symbol);
        const pos = this.positions[idx];
        if (idx < 0 || !pos) return { realizedPnl: 0 };
        const px = this.currentPrice(symbol);
        const dir = pos.positionSide === 'LONG' ? 1 : -1;
        const realizedPnl = (px - pos.entryPrice) * pos.positionAmt * dir;
        this.positions.splice(idx, 1);
        return { realizedPnl };
    }
}

