import { z } from 'zod';

export const OrderSideSchema = z.enum(['BUY', 'SELL']);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const OrderTypeSchema = z.enum(['LIMIT', 'MARKET']);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const TimeInForceSchema = z.enum(['GTC', 'IOC', 'FOK']);
export type TimeInForce = z.infer<typeof TimeInForceSchema>;

export const PositionSideSchema = z.enum(['LONG', 'SHORT']);
export type PositionSide = z.infer<typeof PositionSideSchema>;

export const SymbolSchema = z.string().min(1);

export const PlaceOrderRequestSchema = z.object({
    symbol: SymbolSchema,
    side: OrderSideSchema,
    type: OrderTypeSchema,
    quantity: z.number().positive(),
    price: z.number().positive().optional(),
    timeInForce: TimeInForceSchema.optional(),
    reduceOnly: z.boolean().optional(),
    clientOrderId: z.string().max(64).optional(),
    leverage: z.number().positive().max(125).optional()
}).refine((v) => v.type === 'MARKET' || (v.price !== undefined), {
    message: 'price is required for LIMIT orders',
    path: ['price']
});
export type PlaceOrderRequest = z.infer<typeof PlaceOrderRequestSchema>;

export const OrderIdSchema = z.union([
    z.object({ orderId: z.string().min(1), symbol: SymbolSchema }),
    z.object({ clientOrderId: z.string().min(1), symbol: SymbolSchema })
]);

export const CancelOrderRequestSchema = OrderIdSchema;
export type CancelOrderRequest = z.infer<typeof CancelOrderRequestSchema>;

export const AmendOrderRequestSchema = z.object({
    symbol: SymbolSchema,
    orderId: z.string().min(1),
    price: z.number().positive().optional(),
    quantity: z.number().positive().optional()
}).refine((v) => v.price !== undefined || v.quantity !== undefined, {
    message: 'amend requires price or quantity',
    path: ['price']
});
export type AmendOrderRequest = z.infer<typeof AmendOrderRequestSchema>;

export const BalanceSchema = z.object({
    asset: z.string(),
    availableBalance: z.number(),
    totalBalance: z.number()
});
export type Balance = z.infer<typeof BalanceSchema>;

export const PositionSchema = z.object({
    symbol: SymbolSchema,
    positionSide: PositionSideSchema,
    entryPrice: z.number(),
    positionAmt: z.number(),
    unrealizedPnl: z.number(),
    leverage: z.number()
});
export type Position = z.infer<typeof PositionSchema>;

export const OrderSchema = z.object({
    orderId: z.string(),
    clientOrderId: z.string().optional(),
    symbol: SymbolSchema,
    side: OrderSideSchema,
    type: OrderTypeSchema,
    status: z.enum(['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED']),
    price: z.number().nullable(),
    origQty: z.number(),
    executedQty: z.number(),
    createTime: z.number()
});
export type Order = z.infer<typeof OrderSchema>;

export const TickerSchema = z.object({
    symbol: SymbolSchema,
    price: z.number()
});
export type Ticker = z.infer<typeof TickerSchema>;

export const OrderbookLevelSchema = z.tuple([z.coerce.number(), z.coerce.number()]);
export const OrderbookSchema = z.object({
    lastUpdateId: z.number(),
    bids: z.array(OrderbookLevelSchema),
    asks: z.array(OrderbookLevelSchema)
});
export type Orderbook = z.infer<typeof OrderbookSchema>;

export const Ticker24hSchema = z.object({
    symbol: SymbolSchema,
    priceChange: z.coerce.number(),
    priceChangePercent: z.coerce.number(),
    weightedAvgPrice: z.coerce.number(),
    prevClosePrice: z.coerce.number(),
    lastPrice: z.coerce.number(),
    lastQty: z.coerce.number().optional().nullable(),
    openPrice: z.coerce.number(),
    highPrice: z.coerce.number(),
    lowPrice: z.coerce.number(),
    volume: z.coerce.number(),
    quoteVolume: z.coerce.number(),
    openTime: z.number(),
    closeTime: z.number(),
    firstId: z.number().optional(),
    lastId: z.number().optional(),
    count: z.number().optional()
});
export type Ticker24h = z.infer<typeof Ticker24hSchema>;

export const FundingSchema = z.object({
    symbol: SymbolSchema,
    fundingRate: z.number(),
    markPrice: z.number(),
    nextFundingTime: z.number()
});
export type Funding = z.infer<typeof FundingSchema>;

export const ServerTimeSchema = z.object({
    serverTime: z.number()
});
export type ServerTime = z.infer<typeof ServerTimeSchema>;

export const KlineSchema = z
    .tuple([
        z.coerce.number(), // open time (ms)
        z.coerce.number(), // open
        z.coerce.number(), // high
        z.coerce.number(), // low
        z.coerce.number(), // close
        z.coerce.number(), // volume
        z.coerce.number(), // close time (ms)
        z.coerce.number(), // quote asset volume
        z.coerce.number(), // number of trades
        z.coerce.number(), // taker buy base asset volume
        z.coerce.number() // taker buy quote asset volume
    ])
    .rest(z.any());
export type Kline = z.infer<typeof KlineSchema>;

export function validate<T>(schema: z.ZodType<T>, data: unknown): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
        throw new Error(parsed.error.message);
    }
    return parsed.data;
}

