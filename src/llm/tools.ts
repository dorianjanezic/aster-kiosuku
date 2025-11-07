import { z } from 'zod';
// import { JsonlLedger } from '../persistence/jsonlLedger.js';
import { SqlEventLedger } from '../persistence/sqlEventLedger.js';
import { SimulatedExchange } from '../sim/simulatedExchange.js';
import { PublicClient } from '../http/publicClient.js';
import { fetchConsolidatedMarkets } from '../lib/consolidateMarkets.js';
import { PlaceOrderRequestSchema } from '../types/asterFutures.js';
import { MarketMetaService } from '../services/marketMetaService.js';
import { StateService } from '../services/stateService.js';
import { checkLeverage, normalizeOrder } from '../lib/risk.js';
import { RSI, MACD, BollingerBands, ATR, EMA, ADX } from 'technicalindicators';

// CoinGecko service for fundamental data
class CoinGeckoService {
    private cache = new Map<string, { data: any; timestamp: number }>();
    private readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes

    // Map common trading symbols to CoinGecko IDs
    private readonly symbolToId: Record<string, string> = {
        'ADA': 'cardano',
        'SOL': 'solana',
        'NEAR': 'near',
        'DOT': 'polkadot',
        'ETH': 'ethereum',
        'BTC': 'bitcoin',
        'LTC': 'litecoin',
        'XRP': 'ripple',
        'DOGE': 'dogecoin',
        'XLM': 'stellar',
        'LINK': 'chainlink',
        'UNI': 'uniswap',
        'AAVE': 'aave',
        'PENGU': 'pengu',
        'FARTCOIN': 'fartcoin',
        'APT': 'aptos',
        'SUI': 'sui',
        'SEI': 'sei-network',
        'ARB': 'arbitrum',
        'OP': 'optimism'
    };

    async getProjectData(symbol: string) {
        // Extract base symbol (remove USDT suffix)
        const baseSymbol = symbol.replace(/USDT$/, '');

        // Check cache first
        const cacheKey = baseSymbol;
        const cached = this.cache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
            return cached.data;
        }

        const coingeckoId = this.symbolToId[baseSymbol];
        if (!coingeckoId) {
            throw new Error(`No CoinGecko ID mapping for symbol: ${baseSymbol}`);
        }

        try {
            const response = await fetch(
                `https://api.coingecko.com/api/v3/coins/${coingeckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`,
                {
                    headers: {
                        'Accept': 'application/json',
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`CoinGecko API error: ${response.status}`);
            }

            const data = await response.json();

            // Extract only the key metrics we care about
            const result = {
                symbol: baseSymbol,
                name: data.name,
                market_cap_usd: data.market_data?.market_cap?.usd,
                market_cap_rank: data.market_data?.market_cap_rank,
                total_volume_usd: data.market_data?.total_volume?.usd,
                circulating_supply: data.market_data?.circulating_supply,
                total_supply: data.market_data?.total_supply,
                current_price_usd: data.market_data?.current_price?.usd,
                price_change_24h_percent: data.market_data?.price_change_percentage_24h,
                price_change_7d_percent: data.market_data?.price_change_percentage_7d,
                last_updated: data.last_updated
            };

            // Cache the result
            this.cache.set(cacheKey, { data: result, timestamp: Date.now() });

            return result;
        } catch (error) {
            console.warn(`CoinGecko fetch failed for ${baseSymbol}:`, error);
            // Return cached data if available, even if expired
            if (cached) {
                return cached.data;
            }
            throw error;
        }
    }

    async compareProjects(symbols: string[]) {
        const results = await Promise.allSettled(
            symbols.map(symbol => this.getProjectData(symbol))
        );

        return results.map((result, index) => ({
            symbol: symbols[index],
            success: result.status === 'fulfilled',
            data: result.status === 'fulfilled' ? result.value : null,
            error: result.status === 'rejected' ? result.reason?.message : null
        }));
    }
}

export const get_markets = {
    name: 'get_markets',
    description: 'List tradable markets with tick/step sizes and leverage if available',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

export const place_order = {
    name: 'place_order',
    description: 'Place a simulated order (paper)',
    parameters: {
        type: 'object',
        properties: {
            symbol: { type: 'string', minLength: 1 },
            side: { type: 'string', enum: ['BUY', 'SELL'] },
            type: { type: 'string', enum: ['LIMIT', 'MARKET'] },
            quantity: { type: 'number', exclusiveMinimum: 0 },
            price: { type: 'number', exclusiveMinimum: 0 },
            timeInForce: { type: 'string', enum: ['GTC', 'IOC', 'FOK'] },
            reduceOnly: { type: 'boolean' },
            clientOrderId: { type: 'string', maxLength: 64 },
            leverage: { type: 'number', exclusiveMinimum: 0, maximum: 125 }
        },
        required: ['symbol', 'side', 'type', 'quantity'],
        additionalProperties: false
    }
};

const GetTickerArgsSchema = z.object({ symbol: z.string().min(1) });
export const get_ticker = {
    name: 'get_ticker',
    description: 'Get last price for a symbol',
    parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', minLength: 1 } },
        required: ['symbol'],
        additionalProperties: false
    }
};

const GetOrderbookArgsSchema = z.object({ symbol: z.string().min(1), limit: z.number().int().min(5).max(500).optional().default(50) });
export const get_orderbook = {
    name: 'get_orderbook',
    description: 'Get order book for a symbol',
    parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 5, maximum: 500 } },
        required: ['symbol'],
        additionalProperties: false
    }
};

const GetOhlcvArgsSchema = z.object({ symbol: z.string().min(1), interval: z.string().min(1).default('1h'), limit: z.number().int().min(1).max(1500).optional().default(200) });
export const get_ohlcv = {
    name: 'get_ohlcv',
    description: 'Get klines for a symbol and interval',
    parameters: {
        type: 'object',
        properties: {
            symbol: { type: 'string', minLength: 1 },
            interval: { type: 'string', minLength: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 1500 }
        },
        required: ['symbol', 'interval'],
        additionalProperties: false
    }
};

const CalcIndicatorsArgsSchema = z.object({ symbol: z.string().min(1), interval: z.string().min(1), limit: z.number().int().min(50).max(1500).optional().default(200) });
export const calculate_indicators = {
    name: 'calculate_indicators',
    description: 'Calculate RSI, MACD, Bollinger Bands, ATR, EMA(20/50), ADX from OHLCV',
    parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', minLength: 1 }, interval: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 50, maximum: 1500 } },
        required: ['symbol', 'interval'],
        additionalProperties: false
    }
};

const GetTechnicalsArgsSchema = z.object({ symbol: z.string().min(1), interval: z.string().min(1), limit: z.number().int().min(50).max(1500).optional().default(200) });
export const get_technicals = {
    name: 'get_technicals',
    description: 'Compute RSI, MACD, Bollinger Bands, ATR, EMA(20/50), ADX for a symbol/interval',
    parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', minLength: 1 }, interval: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 50, maximum: 1500 } },
        required: ['symbol', 'interval'],
        additionalProperties: false
    }
};

export const get_open_orders = {
    name: 'get_open_orders',
    description: 'Get open orders (simulation)',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

export const get_account_state = {
    name: 'get_account_state',
    description: 'Get simulated account state snapshot',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

export const get_positions = {
    name: 'get_positions',
    description: 'Get current simulated positions',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

const GetTickersArgsSchema = z.object({ symbols: z.array(z.string().min(1)).min(1) });
export const get_tickers = {
    name: 'get_tickers',
    description: 'Get last prices for multiple symbols',
    parameters: {
        type: 'object',
        properties: { symbols: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } },
        required: ['symbols'],
        additionalProperties: false
    }
};

const GetCoinGeckoProjectArgsSchema = z.object({ symbol: z.string().min(1) });
export const get_coingecko_project = {
    name: 'get_coingecko_project',
    description: 'Get fundamental project data from CoinGecko (market cap, volume, supply, ranking)',
    parameters: {
        type: 'object',
        properties: {
            symbol: { type: 'string', description: 'Trading symbol (e.g., ADAUSDT, SOL, NEAR)' }
        },
        required: ['symbol'],
        additionalProperties: false
    }
};

const CompareCoinGeckoProjectsArgsSchema = z.object({ symbols: z.array(z.string().min(1)).min(1).max(5) });
export const compare_coingecko_projects = {
    name: 'compare_coingecko_projects',
    description: 'Compare fundamental metrics across multiple crypto projects',
    parameters: {
        type: 'object',
        properties: {
            symbols: {
                type: 'array',
                minItems: 1,
                maxItems: 5,
                items: { type: 'string' },
                description: 'Array of trading symbols to compare'
            }
        },
        required: ['symbols'],
        additionalProperties: false
    }
};

export type ToolHandler = (args: any) => Promise<any>;

export function createToolHandlers(opts: { client: PublicClient; sim: SimulatedExchange; ledger: SqlEventLedger; ordersLedger?: SqlEventLedger }) {
    const metaService = new MarketMetaService();
    void metaService.load().catch(() => { });
    const stateService = new StateService('sim_data/orders.jsonl', opts.sim);
    const coingeckoService = new CoinGeckoService();
    return {
        async get_markets(): Promise<any> {
            const { markets } = await fetchConsolidatedMarkets(opts.client);
            return markets;
        },
        async get_ticker(args: unknown): Promise<any> {
            const { symbol } = GetTickerArgsSchema.parse(args);
            return opts.client.getTicker(symbol);
        },
        async get_orderbook(args: unknown): Promise<any> {
            const { symbol, limit } = GetOrderbookArgsSchema.parse(args);
            return opts.client.getOrderbook(symbol, limit);
        },
        async get_ohlcv(args: unknown): Promise<any> {
            const { symbol, interval, limit } = GetOhlcvArgsSchema.parse(args);
            return opts.client.getKlines(symbol, interval, limit);
        },
        async calculate_indicators(args: unknown): Promise<any> {
            const { symbol, interval, limit } = CalcIndicatorsArgsSchema.parse(args);
            const kl = await opts.client.getKlines(symbol, interval, limit);
            const closes = kl.map((k) => k[4]);
            const highs = kl.map((k) => k[2]);
            const lows = kl.map((k) => k[3]);
            const rsi = RSI.calculate({ period: 14, values: closes });
            const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
            const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
            const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
            const ema20 = EMA.calculate({ period: 20, values: closes });
            const ema50 = EMA.calculate({ period: 50, values: closes });
            const adx = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
            return { symbol, interval, rsi: last(rsi), macd: last(macd), bb: last(bb), atr: last(atr), ema20: last(ema20), ema50: last(ema50), adx: last(adx) };
        },
        async get_technicals(args: unknown): Promise<any> {
            const { symbol, interval, limit } = GetTechnicalsArgsSchema.parse(args);
            const kl = await opts.client.getKlines(symbol, interval, limit);
            const closes = kl.map((k) => k[4]);
            const highs = kl.map((k) => k[2]);
            const lows = kl.map((k) => k[3]);
            const rsi = RSI.calculate({ period: 14, values: closes });
            const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
            const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
            const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
            const ema20 = EMA.calculate({ period: 20, values: closes });
            const ema50 = EMA.calculate({ period: 50, values: closes });
            const adx = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
            return { symbol, interval, rsi: last(rsi), macd: last(macd), bb: last(bb), atr: last(atr), ema20: last(ema20), ema50: last(ema50), adx: last(adx) };
        },
        async get_tickers(args: unknown): Promise<any> {
            const { symbols } = GetTickersArgsSchema.parse(args);
            const results = await Promise.all(symbols.map((s) => opts.client.getTicker(s)));
            return results;
        },
        async get_open_orders(): Promise<any> {
            return opts.sim.listOpenOrders();
        },
        async get_account_state(): Promise<any> {
            return stateService.getAccountState();
        },
        async get_positions(): Promise<any> {
            return opts.sim.listPositions();
        },
        async place_order(args: unknown): Promise<any> {
            const req = PlaceOrderRequestSchema.parse(args);
            const meta = metaService.get(req.symbol);
            checkLeverage(req.leverage, meta);
            const normalized = normalizeOrder(req, meta);
            const result = opts.sim.placeOrder(normalized);
            const out = opts.ordersLedger ?? opts.ledger;
            await out.append('order', result);
            return result;
        },
        async get_coingecko_project(args: unknown): Promise<any> {
            const { symbol } = GetCoinGeckoProjectArgsSchema.parse(args);
            return await coingeckoService.getProjectData(symbol);
        },
        async compare_coingecko_projects(args: unknown): Promise<any> {
            const { symbols } = CompareCoinGeckoProjectsArgsSchema.parse(args);
            return await coingeckoService.compareProjects(symbols);
        }
    };
}

export const TOOL_SCHEMAS = [
    get_markets,
    get_ticker,
    get_tickers,
    get_orderbook,
    get_ohlcv,
    get_technicals,
    calculate_indicators,
    get_open_orders,
    get_account_state,
    get_positions,
    place_order,
    get_coingecko_project,
    compare_coingecko_projects
];

function last<T>(arr: T[]): T | undefined { return arr.length ? arr[arr.length - 1] : undefined; }

