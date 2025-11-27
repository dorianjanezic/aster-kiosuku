/**
 * PAIR TRADING PIPELINE ORCHESTRATOR
 * 
 * Automates the full pair trading workflow:
 * 1. Discovery (weekly) - Find quality pair candidates
 * 2. Scan (hourly) - Compute signals for watchlist
 * 3. Alert (on signal) - Send Telegram notifications
 * 
 * Usage:
 *   pnpm pipeline:full     - Run full pipeline (discovery + scan + alert)
 *   pnpm pipeline:scan     - Run scan + alert only (uses existing watchlist)
 *   pnpm pipeline:discover - Run discovery only
 * 
 * Cron examples:
 *   0 0 * * 0 pnpm pipeline:discover  # Weekly discovery (Sunday midnight)
 *   0 * * * * pnpm pipeline:scan      # Hourly scan + alerts
 */

import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import createDebug from 'debug';

const log = createDebug('agent:pipeline');

// ═══════════════════════════════════════════════════════════════
// RATE LIMITER
// ═══════════════════════════════════════════════════════════════

/**
 * Global rate limiter for Hyperliquid API
 * Tracks weight usage across all requests
 */
class RateLimiter {
    private weightUsed = 0;
    private windowStart = Date.now();
    private readonly maxWeight = 1200;
    private readonly windowMs = 60000; // 1 minute

    async waitForCapacity(weight: number): Promise<void> {
        const now = Date.now();

        // Reset window if expired
        if (now - this.windowStart >= this.windowMs) {
            this.weightUsed = 0;
            this.windowStart = now;
        }

        // Check if we have capacity
        if (this.weightUsed + weight <= this.maxWeight) {
            this.weightUsed += weight;
            return;
        }

        // Wait for window to reset
        const waitTime = this.windowMs - (now - this.windowStart) + 100;
        log('Rate limit: waiting %dms (used %d/%d weight)', waitTime, this.weightUsed, this.maxWeight);
        await new Promise(r => setTimeout(r, waitTime));

        // Reset and proceed
        this.weightUsed = weight;
        this.windowStart = Date.now();
    }

    getStatus(): { used: number; max: number; remaining: number } {
        const now = Date.now();
        if (now - this.windowStart >= this.windowMs) {
            return { used: 0, max: this.maxWeight, remaining: this.maxWeight };
        }
        return {
            used: this.weightUsed,
            max: this.maxWeight,
            remaining: this.maxWeight - this.weightUsed
        };
    }
}

export const rateLimiter = new RateLimiter();

// ═══════════════════════════════════════════════════════════════
// API HELPERS WITH RATE LIMITING
// ═══════════════════════════════════════════════════════════════

interface RequestOptions {
    weight?: number;
    retries?: number;
}

export async function hlInfoRequest<T>(
    payload: any,
    options: RequestOptions = {}
): Promise<T> {
    const { weight = 20, retries = 3 } = options;

    for (let attempt = 0; attempt <= retries; attempt++) {
        // Wait for rate limit capacity
        await rateLimiter.waitForCapacity(weight);

        try {
            const response = await fetch('https://api.hyperliquid.xyz/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (response.status === 429) {
                // Rate limited - wait exponentially and retry
                const waitTime = Math.pow(2, attempt + 1) * 5000;
                console.log(`⏳ Rate limited (429), waiting ${waitTime / 1000}s...`);
                await new Promise(r => setTimeout(r, waitTime));
                continue;
            }

            if (!response.ok) {
                throw new Error(`Hyperliquid API error: ${response.status}`);
            }

            return response.json() as Promise<T>;
        } catch (error) {
            if (attempt === retries) throw error;
            const waitTime = Math.pow(2, attempt) * 2000;
            log('Request failed, retrying in %dms...', waitTime);
            await new Promise(r => setTimeout(r, waitTime));
        }
    }
    throw new Error('Max retries exceeded');
}

/**
 * Fetch candles with proper rate limiting
 * Weight = 20 + floor(candles / 60)
 */
export async function fetchCandles(
    coin: string,
    interval: string,
    startTime: number,
    endTime: number
): Promise<any[]> {
    const estimatedCandles = Math.ceil((endTime - startTime) / (60 * 60 * 1000)); // Assume 1h
    const weight = 20 + Math.floor(estimatedCandles / 60);

    const data = await hlInfoRequest<any[]>({
        type: 'candleSnapshot',
        req: { coin, interval, startTime, endTime }
    }, { weight });

    return data;
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE STATE
// ═══════════════════════════════════════════════════════════════

interface PipelineState {
    lastDiscovery: string | null;
    lastScan: string | null;
    watchlist: [string, string][];
    discoveryIntervalDays: number;
}

const STATE_FILE = path.resolve(process.cwd(), 'sim_data/pipeline_state.json');

const WATCHLIST_FILE = path.resolve(process.cwd(), 'sim_data/watchlist.json');

async function loadState(): Promise<PipelineState> {
    try {
        const data = await fs.readFile(STATE_FILE, 'utf-8');
        const state = JSON.parse(data) as PipelineState;

        // If state has no watchlist, try loading from watchlist.json
        if (state.watchlist.length === 0) {
            try {
                const watchlistData = JSON.parse(await fs.readFile(WATCHLIST_FILE, 'utf-8'));
                if (watchlistData.watchlist && watchlistData.watchlist.length > 0) {
                    state.watchlist = watchlistData.watchlist;
                    state.lastDiscovery = watchlistData.generatedAt;
                }
            } catch { /* ignore */ }
        }

        return state;
    } catch {
        // No state file - try loading watchlist directly
        try {
            const watchlistData = JSON.parse(await fs.readFile(WATCHLIST_FILE, 'utf-8'));
            return {
                lastDiscovery: watchlistData.generatedAt || null,
                lastScan: null,
                watchlist: watchlistData.watchlist || [],
                discoveryIntervalDays: 7
            };
        } catch {
            return {
                lastDiscovery: null,
                lastScan: null,
                watchlist: [],
                discoveryIntervalDays: 7
            };
        }
    }
}

async function saveState(state: PipelineState): Promise<void> {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE COMMANDS
// ═══════════════════════════════════════════════════════════════

function shouldRunDiscovery(state: PipelineState): boolean {
    if (!state.lastDiscovery) return true;

    const lastRun = new Date(state.lastDiscovery).getTime();
    const now = Date.now();
    const daysSinceLastRun = (now - lastRun) / (1000 * 60 * 60 * 24);

    return daysSinceLastRun >= state.discoveryIntervalDays;
}

async function runDiscovery(): Promise<[string, string][]> {
    console.log('\n🔬 Running Pair Discovery...\n');

    // Import and run discovery
    const { spawn } = await import('child_process');

    return new Promise((resolve, reject) => {
        const proc = spawn('node', ['dist/cli/discoverPairs.js'], {
            cwd: process.cwd(),
            env: { ...process.env, MIN_VOLUME_24H: '1000000' },
            stdio: 'inherit'
        });

        proc.on('close', async (code) => {
            if (code !== 0) {
                reject(new Error(`Discovery failed with code ${code}`));
                return;
            }

            // Read the latest watchlist
            try {
                const watchlistFile = path.resolve(process.cwd(), 'sim_data/watchlist.json');
                const data = JSON.parse(await fs.readFile(watchlistFile, 'utf-8'));
                resolve(data.watchlist);
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function runScan(watchlist: [string, string][]): Promise<any[]> {
    console.log('\n🔍 Running Pair Scan...\n');

    // Set watchlist in environment
    const watchlistEnv = watchlist.map(([a, b]) => `${a}:${b}`).join(',');

    const { spawn } = await import('child_process');

    return new Promise((resolve, reject) => {
        const proc = spawn('node', ['dist/cli/scanPairsHL.js'], {
            cwd: process.cwd(),
            env: { ...process.env, SCAN_WATCHLIST: watchlistEnv },
            stdio: 'inherit'
        });

        proc.on('close', async (code) => {
            if (code !== 0) {
                reject(new Error(`Scan failed with code ${code}`));
                return;
            }

            // Find the latest scan file
            try {
                const files = await fs.readdir(path.resolve(process.cwd(), 'sim_data'));
                const scanFiles = files
                    .filter(f => f.startsWith('scan-hl-'))
                    .sort()
                    .reverse();

                if (scanFiles.length === 0) {
                    resolve([]);
                    return;
                }

                const latestScan = path.resolve(process.cwd(), 'sim_data', scanFiles[0]!);
                const data = JSON.parse(await fs.readFile(latestScan, 'utf-8'));
                resolve(data);
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function runAlerts(watchlist: [string, string][]): Promise<void> {
    console.log('\n🔔 Running Pair Alerts...\n');

    const watchlistEnv = watchlist.map(([a, b]) => `${a}:${b}`).join(',');

    const { spawn } = await import('child_process');

    return new Promise((resolve, reject) => {
        const proc = spawn('node', ['dist/cli/pairAlertsHL.js'], {
            cwd: process.cwd(),
            env: { ...process.env, SCAN_WATCHLIST: watchlistEnv },
            stdio: 'inherit'
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Alerts failed with code ${code}`));
                return;
            }
            resolve();
        });
    });
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'scan';

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                 PAIR TRADING PIPELINE');
    console.log(`                 Command: ${command}`);
    console.log('═══════════════════════════════════════════════════════════════');

    const state = await loadState();

    try {
        switch (command) {
            case 'full':
                // Full pipeline: discovery + scan + alerts
                if (shouldRunDiscovery(state)) {
                    state.watchlist = await runDiscovery();
                    state.lastDiscovery = new Date().toISOString();
                    await saveState(state);
                } else {
                    console.log(`\n⏭️  Skipping discovery (last run: ${state.lastDiscovery})`);
                }

                if (state.watchlist.length === 0) {
                    console.log('❌ No watchlist available. Run discovery first.');
                    process.exit(1);
                }

                await runScan(state.watchlist);
                state.lastScan = new Date().toISOString();
                await saveState(state);

                await runAlerts(state.watchlist);
                break;

            case 'scan':
                // Scan + alerts only (uses existing watchlist)
                if (state.watchlist.length === 0) {
                    // Try to load from watchlist.json
                    try {
                        const watchlistFile = path.resolve(process.cwd(), 'sim_data/watchlist.json');
                        const data = JSON.parse(await fs.readFile(watchlistFile, 'utf-8'));
                        state.watchlist = data.watchlist;
                    } catch {
                        console.log('❌ No watchlist available. Run discovery first.');
                        process.exit(1);
                    }
                }

                await runScan(state.watchlist);
                state.lastScan = new Date().toISOString();
                await saveState(state);

                await runAlerts(state.watchlist);
                break;

            case 'discover':
                // Discovery only
                state.watchlist = await runDiscovery();
                state.lastDiscovery = new Date().toISOString();
                await saveState(state);
                break;

            case 'status':
                // Show pipeline status
                console.log('\n📊 Pipeline Status:');
                console.log(`   Last Discovery: ${state.lastDiscovery || 'Never'}`);
                console.log(`   Last Scan: ${state.lastScan || 'Never'}`);
                console.log(`   Watchlist: ${state.watchlist.length} pairs`);
                console.log(`   Discovery Interval: ${state.discoveryIntervalDays} days`);

                if (state.watchlist.length > 0) {
                    console.log('\n   Top 10 pairs:');
                    state.watchlist.slice(0, 10).forEach(([a, b], i) => {
                        console.log(`     ${i + 1}. ${a}/${b}`);
                    });
                }
                break;

            default:
                console.log('Usage: pnpm pipeline:[full|scan|discover|status]');
                process.exit(1);
        }

        console.log('\n✅ Pipeline completed successfully');

    } catch (error) {
        console.error('\n❌ Pipeline error:', error);
        process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});

