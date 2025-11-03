import { roundToStep } from './format.js';
import { MarketMeta } from '../services/marketMetaService.js';
import { PlaceOrderRequest } from '../types/asterFutures.js';

export function normalizeOrder(req: PlaceOrderRequest, meta?: MarketMeta): PlaceOrderRequest {
    if (!meta) return req;
    const price = req.price !== undefined ? roundToStep(req.price, meta.tickSize) : undefined;
    const quantity = roundToStep(req.quantity, meta.stepSize);
    return { ...req, price, quantity };
}

export function checkLeverage(leverage?: number, meta?: MarketMeta): void {
    if (!leverage || !meta?.maxLeverage) return;
    if (leverage > meta.maxLeverage) {
        throw new Error(`leverage ${leverage} exceeds max ${meta.maxLeverage}`);
    }
}

