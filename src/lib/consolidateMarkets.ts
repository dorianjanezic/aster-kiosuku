import { PublicClient } from '../http/publicClient.js';
import { findFilterValue } from '../types/asterExchangeInfo.js';

export async function fetchConsolidatedMarkets(client: PublicClient) {
    const [info, tickers, brackets] = await Promise.all([
        client.getExchangeInfo(),
        client.getAllTickerPrices(),
        client.getLeverageBrackets().catch(() => [])
    ]);

    const priceMap = new Map(tickers.map(t => [t.symbol, Number(t.price)]));
    const levMap = new Map(
        brackets.map(b => [b.symbol, Math.max(...b.brackets.map(x => x.initialLeverage))])
    );

    const markets = info.symbols
        .filter(s => s.status === 'TRADING')
        .map(s => {
            const tickSize = findFilterValue(s, 'PRICE_FILTER', 'tickSize');
            const stepSize = findFilterValue(s, 'LOT_SIZE', 'stepSize');
            return {
                symbol: s.symbol,
                baseAsset: s.baseAsset,
                quoteAsset: s.quoteAsset,
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: tickSize ? Number(tickSize) : undefined,
                stepSize: stepSize ? Number(stepSize) : undefined,
                lastPrice: priceMap.get(s.symbol),
                maxLeverage: levMap.get(s.symbol)
            };
        });

    return { markets };
}

