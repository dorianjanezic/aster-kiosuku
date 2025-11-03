import { promises as fs } from 'fs';
import { PublicClient } from '../http/publicClient.js';
import { findFilterValue } from '../types/asterExchangeInfo.js';

async function main() {
    const baseUrl = process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com';
    const basePath = process.env.ASTER_BASE_PATH || '/fapi/v1';
    const client = new PublicClient(baseUrl, basePath);
    const [info, tickers, brackets] = await Promise.all([
        client.getExchangeInfo(),
        client.getAllTickerPrices(),
        client.getLeverageBrackets().catch(() => [])
    ]);

    const priceMap = new Map(tickers.map(t => [t.symbol, Number(t.price)]));
    const levMap = new Map(brackets.map(b => [b.symbol, Math.max(...b.brackets.map(x => x.initialLeverage))]));

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

    await fs.mkdir('sim_data', { recursive: true });
    await fs.writeFile('sim_data/markets.json', JSON.stringify({ baseUrl, basePath, asOf: Date.now(), markets }, null, 2));
    console.log(`wrote ${markets.length} markets to sim_data/markets.json`);
}

main().catch((err) => {
    console.error(err);
});

