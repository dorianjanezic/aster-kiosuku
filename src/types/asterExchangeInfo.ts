import { z } from 'zod';

export const ExchangeInfoSymbolFilterSchema = z.object({
    filterType: z.string(),
    minPrice: z.string().optional(),
    maxPrice: z.string().optional(),
    tickSize: z.string().optional(),
    stepSize: z.string().optional(),
    minQty: z.string().optional(),
    maxQty: z.string().optional()
}).passthrough();

export const ExchangeInfoSymbolSchema = z.object({
    symbol: z.string(),
    status: z.string(),
    baseAsset: z.string().optional(),
    quoteAsset: z.string().optional(),
    pricePrecision: z.number().optional(),
    quantityPrecision: z.number().optional(),
    filters: z.array(ExchangeInfoSymbolFilterSchema).optional()
}).passthrough();

export const ExchangeInfoSchema = z.object({
    symbols: z.array(ExchangeInfoSymbolSchema)
}).passthrough();
export type ExchangeInfo = z.infer<typeof ExchangeInfoSchema>;

export const TickerPriceSchema = z.object({ symbol: z.string(), price: z.string() });
export type TickerPrice = z.infer<typeof TickerPriceSchema>;

export const LeverageBracketSchema = z.object({
    symbol: z.string(),
    brackets: z.array(z.object({
        initialLeverage: z.number(),
        qtyCap: z.string().optional(),
        maintMarginRatio: z.number().optional()
    }).passthrough())
});
export type LeverageBracket = z.infer<typeof LeverageBracketSchema>;

export function findFilterValue(symbol: { filters?: Array<Record<string, unknown>> }, type: string, key: string): string | undefined {
    const f = symbol.filters?.find((x) => x && (x as any).filterType === type) as any;
    return f ? f[key] : undefined;
}

