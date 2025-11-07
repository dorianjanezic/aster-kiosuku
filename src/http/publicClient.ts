/**
 * PUBLIC HTTP CLIENT
 *
 * Handles public API communication with the exchange for market data.
 * Provides typed, validated interfaces for:
 * - Market data (tickers, orderbooks, klines)
 * - Exchange information and trading rules
 * - Public market statistics and metadata
 *
 * Uses Zod schemas for runtime type validation and error handling.
 */

import { ExchangeInfo, ExchangeInfoSchema, LeverageBracket, LeverageBracketSchema, TickerPrice, TickerPriceSchema } from '../types/asterExchangeInfo.js';
import { Kline, KlineSchema, Orderbook, OrderbookSchema, TickerSchema, Ticker24h, Ticker24hSchema } from '../types/asterFutures.js';

export class PublicClient {
    constructor(private baseUrl: string, private basePath = '/fapi/v1') { }

    private url(path: string): string {
        return `${this.baseUrl}${this.basePath}${path}`;
    }

    async getExchangeInfo(): Promise<ExchangeInfo> {
        const url = this.url('/exchangeInfo');
        let attempt = 0;
        let lastErr: any;
        while (attempt < 3) {
            try {
                const res = await fetch(url);
                if (res.ok) {
                    const json = await res.json();
                    return ExchangeInfoSchema.parse(json);
                }
                // capture details
                const text = await res.text().catch(() => '');
                const headers = Object.fromEntries(res.headers.entries());
                // Respect Retry-After when 429
                if (res.status === 429) {
                    const ra = Number(headers['retry-after'] || headers['Retry-After'] || 0);
                    const waitMs = ra > 0 ? ra * 1000 : (500 * Math.pow(2, attempt));
                    // eslint-disable-next-line no-console
                    console.warn('[publicClient] 429 exchangeInfo; retrying in', waitMs, 'ms', { headers });
                    await new Promise(r => setTimeout(r, waitMs));
                    attempt++;
                    continue;
                }
                throw new Error(`exchangeInfo ${res.status} body=${text} headers=${JSON.stringify(headers)}`);
            } catch (e) {
                lastErr = e;
                const waitMs = 500 * Math.pow(2, attempt);
                // eslint-disable-next-line no-console
                console.warn('[publicClient] getExchangeInfo error; retrying in', waitMs, 'ms', e);
                await new Promise(r => setTimeout(r, waitMs));
                attempt++;
            }
        }
        throw lastErr ?? new Error('exchangeInfo failed');
    }

    async getAllTickerPrices(): Promise<Array<TickerPrice>> {
        const res = await fetch(this.url('/ticker/price'));
        if (!res.ok) throw new Error(`ticker/price ${res.status}`);
        const json = await res.json();
        return Array.isArray(json) ? json.map((j) => TickerPriceSchema.parse(j)) : [TickerPriceSchema.parse(json)];
    }

    async getLeverageBrackets(): Promise<Array<LeverageBracket>> {
        const res = await fetch(this.url('/leverageBracket'));
        if (!res.ok) throw new Error(`leverageBracket ${res.status}`);
        const json = await res.json();
        return (Array.isArray(json) ? json : [json]).map((j) => LeverageBracketSchema.parse(j));
    }

    async getTicker(symbol: string): Promise<{ symbol: string; price: number }> {
        const url = new URL(this.url('/ticker/price'));
        url.searchParams.set('symbol', symbol);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`ticker/price ${res.status}`);
        const json = await res.json();
        const parsed = TickerSchema.parse({ symbol: json.symbol, price: Number(json.price) });
        return parsed;
    }

    async getTicker24h(symbol: string): Promise<Ticker24h> {
        const url = new URL(this.url('/ticker/24hr'));
        url.searchParams.set('symbol', symbol);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`ticker/24hr ${res.status}`);
        const json = await res.json();
        return Ticker24hSchema.parse(json);
    }

    async getOrderbook(symbol: string, limit = 50): Promise<Orderbook> {
        const url = new URL(this.url('/depth'));
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('limit', String(limit));
        const res = await fetch(url);
        if (!res.ok) throw new Error(`depth ${res.status}`);
        const json = await res.json();
        return OrderbookSchema.parse(json);
    }

    async getKlines(symbol: string, interval: string, limit = 500): Promise<Kline[]> {
        const url = new URL(this.url('/klines'));
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('interval', interval);
        url.searchParams.set('limit', String(limit));
        const res = await fetch(url);
        if (!res.ok) throw new Error(`klines ${res.status}`);
        const json = await res.json();
        return (json as unknown[]).map((row) => KlineSchema.parse(row));
    }

    async getIndexPriceKlines(symbol: string, interval: string, limit = 500): Promise<Kline[]> {
        const url = new URL(this.url('/indexPriceKlines'));
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('interval', interval);
        url.searchParams.set('limit', String(limit));
        const res = await fetch(url);
        if (!res.ok) throw new Error(`indexPriceKlines ${res.status}`);
        const json = await res.json();
        return (json as unknown[]).map((row) => KlineSchema.parse(row));
    }

    async getMarkPriceKlines(symbol: string, interval: string, limit = 500): Promise<Kline[]> {
        const url = new URL(this.url('/markPriceKlines'));
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('interval', interval);
        url.searchParams.set('limit', String(limit));
        const res = await fetch(url);
        if (!res.ok) throw new Error(`markPriceKlines ${res.status}`);
        const json = await res.json();
        return (json as unknown[]).map((row) => KlineSchema.parse(row));
    }

    async getPremiumIndex(symbol: string): Promise<any> {
        const url = new URL(this.url('/premiumIndex'));
        url.searchParams.set('symbol', symbol);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`premiumIndex ${res.status}`);
        return await res.json();
    }

    async getFundingRate(symbol: string, limit = 100): Promise<any[]> {
        const url = new URL(this.url('/fundingRate'));
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('limit', String(limit));
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fundingRate ${res.status}`);
        return await res.json();
    }

    async getFundingInfo(symbol: string): Promise<any> {
        const url = new URL(this.url('/fundingInfo'));
        url.searchParams.set('symbol', symbol);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fundingInfo ${res.status}`);
        return await res.json();
    }
}

