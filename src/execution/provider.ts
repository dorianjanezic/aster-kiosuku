import type { PlaceOrderRequest, Order } from '../types/asterFutures.js';
import type { SimulatedExchange } from '../sim/simulatedExchange.js';

export type ExecutionMode = 'paper' | 'live';

export interface ExecutionProvider {
    placeOrder(req: PlaceOrderRequest): Promise<Order>;
    cancelOrder(args: { orderId?: string; clientOrderId?: string; symbol: string }): Promise<Order>;
    amendOrder(args: { orderId: string; symbol: string; price?: number; quantity?: number }): Promise<Order>;
    listOpenOrders(): Promise<Order[]>;
    listPositions(): Promise<any[]>; // concrete type varies; normalized by callers
}

export class SimExecutionProvider implements ExecutionProvider {
    constructor(private sim: SimulatedExchange) { }
    async placeOrder(req: PlaceOrderRequest): Promise<Order> { return this.sim.placeOrder(req); }
    async cancelOrder(args: { orderId?: string; clientOrderId?: string; symbol: string }): Promise<Order> { return this.sim.cancelOrder(args); }
    async amendOrder(args: { orderId: string; symbol: string; price?: number; quantity?: number }): Promise<Order> { return this.sim.amendOrder(args); }
    async listOpenOrders(): Promise<Order[]> { return this.sim.listOpenOrders(); }
    async listPositions(): Promise<any[]> { return this.sim.listPositions(); }
}

export class LiveExecutionProvider implements ExecutionProvider {
    // TODO: wire PrivateClient once signing is implemented
    constructor() { }
    async placeOrder(_req: PlaceOrderRequest): Promise<Order> { throw new Error('LiveExecutionProvider not implemented'); }
    async cancelOrder(_args: { orderId?: string; clientOrderId?: string; symbol: string }): Promise<Order> { throw new Error('LiveExecutionProvider not implemented'); }
    async amendOrder(_args: { orderId: string; symbol: string; price?: number; quantity?: number }): Promise<Order> { throw new Error('LiveExecutionProvider not implemented'); }
    async listOpenOrders(): Promise<Order[]> { return []; }
    async listPositions(): Promise<any[]> { return []; }
}

export function createExecutionProvider(mode: ExecutionMode, sim: SimulatedExchange): ExecutionProvider {
    if (mode === 'live') return new LiveExecutionProvider();
    return new SimExecutionProvider(sim);
}


