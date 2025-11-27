/**
 * PAIR TRADING DAEMON
 * 
 * Runs the pair trading pipeline on a schedule:
 * - Scan + Alerts: Every hour
 * - Discovery: Every 7 days (or on startup if stale)
 * 
 * Deploy to Railway with: pnpm start:pairs
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_HOURS || '1') * 60 * 60 * 1000;
const DISCOVERY_INTERVAL_DAYS = Number(process.env.DISCOVERY_INTERVAL_DAYS || '7');
const WATCHLIST_FILE = path.resolve(process.cwd(), 'sim_data/watchlist.json');
const STATE_FILE = path.resolve(process.cwd(), 'sim_data/pipeline_state.json');

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function log(message: string) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

function runScript(scriptPath: string, args: string[] = []): Promise<number> {
    return new Promise((resolve, reject) => {
        log(`Running: node ${scriptPath} ${args.join(' ')}`);
        
        const proc = spawn('node', [scriptPath, ...args], {
            cwd: process.cwd(),
            env: process.env,
            stdio: 'inherit'
        });

        proc.on('error', reject);
        proc.on('close', (code) => resolve(code ?? 0));
    });
}

async function loadState(): Promise<{ lastDiscovery: string | null; lastScan: string | null }> {
    try {
        const data = await fs.readFile(STATE_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return { lastDiscovery: null, lastScan: null };
    }
}

async function hasValidWatchlist(): Promise<boolean> {
    try {
        const data = JSON.parse(await fs.readFile(WATCHLIST_FILE, 'utf-8'));
        return data.watchlist && data.watchlist.length > 0;
    } catch {
        return false;
    }
}

function shouldRunDiscovery(lastDiscovery: string | null): boolean {
    if (!lastDiscovery) return true;
    
    const lastRun = new Date(lastDiscovery).getTime();
    const now = Date.now();
    const daysSinceLastRun = (now - lastRun) / (1000 * 60 * 60 * 24);
    
    return daysSinceLastRun >= DISCOVERY_INTERVAL_DAYS;
}

// ═══════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════

async function runDiscovery(): Promise<void> {
    log('🔬 Running pair discovery...');
    const code = await runScript('dist/cli/discoverPairs.js');
    if (code !== 0) {
        log(`⚠️ Discovery exited with code ${code}`);
    } else {
        log('✅ Discovery completed');
    }
}

async function runScan(): Promise<void> {
    log('🔍 Running pair scan...');
    const code = await runScript('dist/cli/scanPairsHL.js');
    if (code !== 0) {
        log(`⚠️ Scan exited with code ${code}`);
    } else {
        log('✅ Scan completed');
    }
}

async function runAlerts(): Promise<void> {
    log('🔔 Running pair alerts...');
    const code = await runScript('dist/cli/pairAlertsHL.js');
    if (code !== 0) {
        log(`⚠️ Alerts exited with code ${code}`);
    } else {
        log('✅ Alerts completed');
    }
}

async function runCycle(): Promise<void> {
    try {
        const state = await loadState();
        
        // Check if discovery is needed
        if (shouldRunDiscovery(state.lastDiscovery) || !(await hasValidWatchlist())) {
            log('📅 Discovery is due (or no watchlist found)');
            await runDiscovery();
        }
        
        // Run scan + alerts if we have a watchlist
        if (await hasValidWatchlist()) {
            await runScan();
            await runAlerts();
        } else {
            log('⚠️ No valid watchlist - skipping scan');
        }
        
    } catch (error) {
        log(`❌ Cycle error: ${error}`);
    }
}

async function main() {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                 PAIR TRADING DAEMON');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    log(`Scan interval: ${SCAN_INTERVAL_MS / 1000 / 60} minutes`);
    log(`Discovery interval: ${DISCOVERY_INTERVAL_DAYS} days`);
    console.log('');

    // Ensure sim_data directory exists
    await fs.mkdir('sim_data', { recursive: true });

    // Run immediately on startup
    log('🚀 Running initial cycle...');
    await runCycle();

    // Schedule recurring runs
    log(`⏰ Next scan in ${SCAN_INTERVAL_MS / 1000 / 60} minutes`);
    
    setInterval(async () => {
        log('⏰ Scheduled cycle starting...');
        await runCycle();
        log(`⏰ Next scan in ${SCAN_INTERVAL_MS / 1000 / 60} minutes`);
    }, SCAN_INTERVAL_MS);

    // Keep process alive
    process.on('SIGINT', () => {
        log('👋 Shutting down...');
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        log('👋 Received SIGTERM, shutting down...');
        process.exit(0);
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

