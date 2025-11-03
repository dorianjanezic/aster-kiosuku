/**
 * PAIRS SCAN CLI TOOL
 *
 * Command-line utility for scanning and generating pair trading candidates.
 * Performs comprehensive statistical analysis across all available symbols
 * to identify cointegrated pairs with strong mean-reversion characteristics.
 *
 * Outputs filtered, scored pair candidates to sim_data/pairs.json for
 * use by the trading agent in decision-making processes.
 */

import 'dotenv/config';
import { promises as fs } from 'fs';
import { buildPairCandidates } from '../strategies/pairs/pairTrading.js';
import { PublicClient } from '../http/publicClient.js';

async function main() {
    const outPath = 'sim_data/pairs.json';
    const baseUrl = process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com';
    const basePath = process.env.ASTER_BASE_PATH || '/fapi/v1';
    const client = new PublicClient(baseUrl, basePath);
    const { pairs } = await buildPairCandidates('sim_data/markets.json', Number(process.env.PAIRS_PER_SECTOR || '5'), client);
    await fs.writeFile(outPath, JSON.stringify({ asOf: Date.now(), pairs }, null, 2));
    console.log(`wrote ${pairs.length} pairs -> ${outPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});


