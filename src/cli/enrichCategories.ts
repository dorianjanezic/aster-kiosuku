import 'dotenv/config';
import { promises as fs } from 'fs';
import { CmcClient } from '../http/cmcClient.js';
import { mapFromCmcTags } from '../lib/categorize.js';

async function main() {
    const marketsPath = 'sim_data/markets.json';
    const text = await fs.readFile(marketsPath, 'utf8');
    const data = JSON.parse(text);
    const markets: any[] = data.markets || [];
    // Load local categories mapping (avoid import assertions for compatibility)
    let localMapJson: Record<string, any> = {};
    try {
        const localMapText = await fs.readFile('src/data/assetCategories.json', 'utf8');
        localMapJson = JSON.parse(localMapText);
    } catch { }
    const baseAssets = Array.from(new Set(markets.map((m) => m.baseAsset)));
    // Optional user-supplied overrides/additions
    let userMapJson: Record<string, any> = {};
    try {
        const userMapText = await fs.readFile('src/data/userAssetCategories.json', 'utf8');
        userMapJson = JSON.parse(userMapText);
    } catch { }
    // Skip ones that already have categories
    const alreadyCategorized = new Set(
        markets.filter((m) => m.categories && (m.categories.sector || m.categories.ecosystem || m.categories.type))
            .map((m) => m.baseAsset)
    );
    const missing = baseAssets.filter((b) => !alreadyCategorized.has(b));
    const n = Number(process.env.CMC_SAMPLE_SIZE || String(missing.length || baseAssets.length));
    const sample = missing.slice(0, Math.max(1, Math.min(n, missing.length)));

    const cmc = new CmcClient();
    let bySymbol: Record<string, any> = {};
    const batchSize = Number(process.env.CMC_BATCH_SIZE || '50');
    const delayMs = Number(process.env.CMC_BATCH_DELAY_MS || '1500');
    const chunks: string[][] = [];
    for (let i = 0; i < sample.length; i += batchSize) chunks.push(sample.slice(i, i + batchSize));
    for (const chunk of chunks) {
        try {
            const info = await cmc.getCryptocurrencyInfoBySymbol(chunk);
            const dataMap = info?.data || {};
            Object.assign(bySymbol, dataMap);
        } catch (e) {
            console.warn(`CMC fetch failed for chunk of size ${chunk.length}: ${String(e)}`);
        }
        if (delayMs > 0) await sleep(delayMs);
    }

    const categoriesByBase: Record<string, any> = { ...localMapJson, ...userMapJson } as any;
    for (const sym of Object.keys(bySymbol)) {
        const arr = bySymbol[sym];
        if (Array.isArray(arr) && arr.length) {
            categoriesByBase[sym] = mapFromCmcTags(sym, arr[0]);
        }
    }

    // Add baseline categories for common majors if missing
    const ensure = (k: string, v: any) => { if (!categoriesByBase[k]) categoriesByBase[k] = v; };
    ensure('BTC', { sector: 'Layer-1', ecosystem: 'Bitcoin', type: 'Base Coin', narratives: ['StoreOfValue'] });
    ensure('ETH', { sector: 'Layer-1', ecosystem: 'Ethereum', type: 'Utility', narratives: ['SmartContracts', 'EVM'] });
    ensure('SOL', { sector: 'Layer-1', ecosystem: 'Solana', type: 'Utility', narratives: ['HighThroughput'] });
    ensure('USDT', { sector: 'Stablecoin', ecosystem: 'Multi', type: 'Stablecoin', stablecoin: { issuer: 'Tether', peg: 'USD' } });
    ensure('USDC', { sector: 'Stablecoin', ecosystem: 'Multi', type: 'Stablecoin', stablecoin: { issuer: 'Circle', peg: 'USD' } });

    const enriched = markets.map((m) => {
        const base = m.baseAsset as string;
        const canon = normalizeBase(base);
        const cat = categoriesByBase[base] || categoriesByBase[canon];
        return cat ? { ...m, categories: { ...(m.categories || {}), ...cat } } : m;
    });

    const out = { ...data, markets: enriched, categoriesSource: 'CMC v2 cryptocurrency/info' };
    await fs.writeFile(marketsPath, JSON.stringify(out, null, 2));
    console.log(`enriched categories for ${Object.keys(categoriesByBase).length} base assets`);

    // Emit report of missing categories to help manual curation
    const missingSet = new Set<string>();
    for (const m of enriched) {
        const c = m.categories || {};
        if (!c.sector && !c.ecosystem && !c.type) missingSet.add(m.baseAsset);
    }
    const missingReport = Array.from(missingSet).map((base) => ({
        baseAsset: base,
        symbols: markets.filter((m) => m.baseAsset === base).map((m) => m.symbol)
    }));
    await fs.writeFile('sim_data/missingCategories.json', JSON.stringify({ asOf: Date.now(), count: missingReport.length, assets: missingReport }, null, 2));
    console.log(`missing categories for ${missingReport.length} base assets -> sim_data/missingCategories.json`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBase(base: string): string {
    // Map common leveraged/aggregated symbols to underlying
    if (base.startsWith('1000')) {
        const u = base.replace(/^1000/, '');
        // Known scaled memecoins
        if (['SHIB', 'FLOKI', 'BONK', 'PEPE', 'CHEEMS'].includes(u)) return u;
    }
    return base;
}


