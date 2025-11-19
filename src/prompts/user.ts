/**
 * USER PROMPT GENERATOR
 *
 * Dynamically generates contextual user prompts for the trading agent
 * based on current market conditions and portfolio state.
 *
 * Key Components:
 * - Current portfolio status (balance, margin, positions)
 * - Active pair performance and exit signals
 * - New pair opportunities with enhanced technical analysis
 * - Asset scores and quality metrics
 * - Decision framework with technical + sentiment integration
 *
 * This prompt provides the agent with real-time market context
 * and structured decision-making guidance for optimal trading actions.
 */

import type { SimAccount, SimPosition } from '../services/stateService.js';
import { formatDurationMs, hoursFromMs, intervalStringToHours } from '../lib/format.js';

export function getUserPrompt(args: { account: SimAccount; positions: SimPosition[]; pairs?: Array<{ sector?: string; ecosystem?: string; assetType?: string; long: string; short: string; corr?: number; beta?: number; scores?: any; spreadZ?: number; cointegration?: { halfLife?: number | null } }>; activePairs?: Array<{ long: string; short: string; pnlUsd: number; spreadZ?: number; halfLife?: number | null; entrySpreadZ?: number; deltaSpreadZ?: number; entryHalfLife?: number | null; deltaHalfLife?: number | null; entryTime?: number; elapsedMs?: number }> }): string {
    const { account, positions, pairs, activePairs } = args;
    const posLines = positions.length
        ? positions.map(p => `• ${p.symbol} ${p.direction} — entry: ${p.entryPrice}, qty: ${p.qty}, upnl: ${p.unrealizedPnl ?? 0}, lev: ${p.leverage ?? ''}`).join('\n')
        : '• None';
    // Pair-focused prompt: omit per-asset <assets> block

    // Agent now compares proposed pairs directly against active pairs listed above

    const pairsSection = (() => {
        // Get symbols used in active pairs for isolation filtering
        const usedSymbols = new Set((activePairs || []).flatMap(ap => [ap.long, ap.short]));

        // Filter out pairs that share symbols with active pairs (symbol isolation)
        const availablePairs = (pairs || []).filter(p =>
            !usedSymbols.has(p.long) && !usedSymbols.has(p.short)
        );

        // Eligibility: apply hard thresholds to reduce the candidate set
        const eligiblePairs = availablePairs.filter((p: any) => {
            const corr = typeof p.corr === 'number' ? p.corr : -Infinity;
            const cointegration = p.cointegration || {};
            const adfT = typeof cointegration.adfT === 'number' ? cointegration.adfT : Infinity;
            const adfP = typeof cointegration.p === 'number' ? cointegration.p : null;
            const halfLife = typeof cointegration.halfLife === 'number' ? cointegration.halfLife : Infinity;
            const spreadZ = typeof p.spreadZ === 'number' ? p.spreadZ : 0;
            const absZ = Math.abs(spreadZ);

            const minCorr = Number(process.env.PROMPT_PAIRS_MIN_CORR || process.env.PAIRS_MIN_CORR || '0.7');
            const maxHalfLife = Number(process.env.PROMPT_PAIRS_MAX_HALFLIFE || process.env.PAIRS_MAX_HALFLIFE_DAYS || '40');
            const maxAdfP = Number(process.env.PROMPT_PAIRS_MAX_ADF_P || process.env.PAIRS_MAX_ADF_P || '0.10');
            const minSpreadZ = Number(process.env.PROMPT_PAIRS_MIN_SPREADZ || process.env.PAIRS_MIN_SPREADZ || '0.8');

            const stationaryByP = (adfP != null && Number.isFinite(adfP)) ? (adfP <= maxAdfP) : null;
            const stationaryByT = (Number.isFinite(adfT)) ? (adfT <= -1.645) : null;
            const stationaryOk = stationaryByP ?? stationaryByT ?? false;

            return (
                Number.isFinite(corr) &&
                Number.isFinite(halfLife) &&
                Number.isFinite(absZ) &&
                corr >= minCorr &&
                halfLife <= maxHalfLife &&
                absZ >= minSpreadZ &&
                stationaryOk
            );
        });

        if (!eligiblePairs.length) return '';

        // Calculate quality scores and sort
        const scoredList = eligiblePairs.map(p => {
            const cointegration = (p as any).cointegration || {};
            const corr = Math.max(0, Math.min(1, p.corr || 0));
            const absZ = Math.min(Math.abs((p as any).spreadZ || 0), 3); // clamp |Z| ≤ 3
            const ratioZAbs = Math.min(Math.abs((p as any).ratioZ || 0), 3);
            const spreadVol = Math.max(0, (p as any).spreadVol || 0);
            const scoreLong = Math.max(-1, Math.min(1, (p as any).scores?.long || 0));
            const scoreShort = Math.max(-1, Math.min(1, (p as any).scores?.short || 0));
            const halfLifePeriods = Math.min((cointegration.halfLife || 0), 60); // cap at 60p
            const adfT = (cointegration.adfT || 0);
            const adfTEffective = Math.max(-10, Math.min(0, adfT)); // clamp [-10, 0]
            const fundingNet = (p as any).fundingNet || 0;

            // Penalize very noisy spreads by subtracting a function of spreadVol (scale factor chosen heuristically)
            const spreadVolPenalty = spreadVol * 50; // spreadVol ~ 0.02-0.07 → penalty ~1-3.5

            const qualityScore = (
                corr * 0.25 +
                absZ * 0.20 +
                ratioZAbs * 0.10 +
                (scoreLong * 0.15) +
                (scoreShort * 0.15) -
                (halfLifePeriods / 5) * 0.08 +
                (-(adfTEffective)) * 0.07 -
                (fundingNet * 200) -  // toned down funding weight
                spreadVolPenalty * 0.05
            );

            return {
                ...p,
                qualityScore: Number(qualityScore.toFixed(3))
            };
        }).sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));

        // Diversity: cap per sector/ecosystem
        const diversityCap = Number(process.env.PROMPT_PAIRS_SECTOR_CAP || '2');
        const sectorCounts = new Map<string, number>();
        const diversified: any[] = [];
        for (const p of scoredList) {
            const sectorKey = (p as any).sector || (p as any).ecosystem || 'Unknown';
            const count = sectorCounts.get(sectorKey) || 0;
            if (count < diversityCap) {
                diversified.push(p);
                sectorCounts.set(sectorKey, count + 1);
            }
        }

        // Final top N
        const topN = Number(process.env.PROMPT_PAIRS_TOP_N || '5');
        const finalList = diversified.slice(0, topN);

        return ('\n  <pairs>\n' +
            '    New pair opportunities:\n\n' +
            finalList.map((p, i) => {
                const tech = (p as any).technicals || {};
                const scores = (p as any).scores || {};
                const sZ = Number(((p as any).spreadZ || 0));
                const sZAbs = Math.abs(sZ);
                const ratioZ = Number(((p as any).ratioZ || 0));
                const spreadVol = (p as any).spreadVol;
                const suggLong = sZ > 0 ? p.short : p.long; // positive Z -> short long-leg, long short-leg
                const suggShort = sZ > 0 ? p.long : p.short;
                return `    ${i + 1}. ${p.long}/${p.short} (${p.sector || p.ecosystem || 'Unknown'})\n` +
                    `       Stats: corr=${p.corr?.toFixed(3)}, beta=${p.beta?.toFixed(3) || 'null'}, adfT=${((p as any).cointegration?.adfT || 0)?.toFixed(2)}, halfLifePeriods=${((p as any).cointegration?.halfLife || 0)?.toFixed(1)}p, spreadZSigned=${sZ.toFixed(2)}, |spreadZ|=${sZAbs.toFixed(2)}, ratioZ=${ratioZ.toFixed(2)}, spreadVol=${spreadVol != null ? spreadVol.toFixed(4) : 'null'}, fundingNet=${((p as any).fundingNet || 0)?.toFixed(6)}\n` +
                    `       Direction: long ${suggLong}, short ${suggShort}\n` +
                    `       Technical: rsiDiv=${tech.rsiDivergence?.toFixed(2) || 'null'}, volConf=${tech.volumeConfirmation?.toFixed(2) || 'null'}, regime=${tech.regimeScore?.toFixed(2) || 'null'}, adx=${tech.adxTrend?.toFixed(1) || 'null'}\n` +
                    `       Scores: long=${scores.long?.toFixed(2) || 'null'}, short=${scores.short?.toFixed(2) || 'null'}, composite=${scores.composite?.toFixed(2) || 'null'}\n` +
                    `       Quality: ${p.qualityScore}\n`;
            }).join('') +
            '\n    Criteria: corr≥0.7 (or PAIRS_MIN_CORR), ADF p-value≤0.10 (or adfT≤-1.645), halfLife≤40 periods, |spreadZ|≥0.8, and prefer |ratioZ|≥0.8\n' +
            '    Units: pairs halfLife is in periods; state JSON halfLifeHours/entryHalfLifeHours are hours\n' +
            '    Technical: Prefer positive rsiDivergence, volumeConfirmation, and low ADX (ranging markets)\n' +
            '    Sizing: For similar quality signals, favor lower spreadVol (tighter spreads) with larger notional and higher spreadVol with smaller notional.\n' +
            '  </pairs>\n');
    })();

    // Build streamlined state JSON for the agent
    const stateJson = (() => {
        const asOf = Date.now();
        const positionsJson = positions.map(p => ({
            symbol: p.symbol,
            direction: p.direction,
            qty: p.qty,
            pnl: p.unrealizedPnl ?? 0
        }));

        const activePairsJson = (activePairs || []).map(ap => ({
            pair: `${ap.long}/${ap.short}`,
            pnlUsd: Number(ap.pnlUsd.toFixed(2)),
            spreadZSigned: Number((ap.spreadZ || 0).toFixed(2)),
            spreadZAbs: Number(Math.abs(ap.spreadZ || 0).toFixed(2)),
            // deltaSpreadZ: positive = converging (good), negative = diverging (bad)
            deltaSpreadZ: ap.deltaSpreadZ != null ? Number(ap.deltaSpreadZ.toFixed(3)) : null,
            halfLifeHours: (ap as any).halfLife || null,
            elapsedHours: (ap as any).elapsedMs ? ((ap as any).elapsedMs / (1000 * 60 * 60)) : 0,
            convergencePct: (ap as any).convergenceProgress ?? null,
            convergenceToTargetPct: (ap as any).convergenceToTargetPct ?? null,
            remainingToTargetZ: (ap as any).remainingToTargetZ ?? null,
            elapsedHalfLives: (ap as any).elapsedHalfLives ?? null,
            exitSignals: (ap as any).exitSignals || {},
            entrySpreadZ: (ap as any).entrySpreadZ ?? null,
            entryHalfLifeHours: (ap as any).entryHalfLife ?? null,
            entryTime: (ap as any).entryTime ?? null,
            // deltaHalfLife: positive = faster reversion (good), negative = slower (bad)
            deltaHalfLife: (ap as any).deltaHalfLife ?? null
        }));

        return JSON.stringify({
            asOf,
            portfolio: {
                balance: Number(account.balanceUsd.toFixed(2)),
                equity: Number(account.equityUsd.toFixed(2)),
                marginUsed: Number(account.marginUsedUsd.toFixed(2)),
                availableMargin: Number(account.availableMarginUsd.toFixed(2)),
                openPositions: account.openPositionsCount
            },
            positions: positionsJson,
            activePairs: activePairsJson
        }, null, 2);
    })();

    // Simplified approach: agent compares proposed pairs directly against active pairs

    return (
        '# Pair Trading Decision Task\n\n' +
        `## Context\n` +
        `- Timestamp: ${new Date().toISOString()}\n\n` +
        `## Portfolio Status\n` +
        `- Balance: $${account.balanceUsd}\n` +
        `- Equity: $${account.equityUsd}\n` +
        `- Available Margin: $${account.availableMarginUsd}\n` +
        `- Open Positions: ${account.openPositionsCount}\n\n` +
        `## State Data\n` +
        '```json\n' + stateJson + '\n```\n\n' +
        pairsSection +
        '\n## Task\n\n' +
        'Make an optimal pair trading decision.\n\n' +
        '### Decision Steps\n' +
        '1. Check portfolio: margin ≥ $100, positions ≤ 20 total\n' +
        '2. Check active pairs: review exitSignals, pnl, and risk management\n' +
        '3. Technical analysis: Evaluate RSI divergence, volume confirmation, and market regime\n' +
        '4. Research sentiment: Use search for social sentiment on active pairs and top candidates\n' +
        '5. Select new pair: top candidate from opportunities list, factoring in technical + sentiment analysis\n' +
        '6. Choose action: ENTER, EXIT, REDUCE, or NONE\n\n' +
        '### Requirements\n' +
        '- Statistical criteria: corr≥0.7, adfT≤-1.645, halfLife≤40 periods, |spreadZ|≥0.8\n' +
        '- Technical indicators: Prefer pairs with positive RSI divergence, volume confirmation, and low ADX\n' +
        '- Asset scores: Favor pairs where both long and short assets have positive scores\n' +
        '- Market regime: Favor pairs in ranging markets (ADX < 25) over trending markets\n' +
        '- Maximum 10 pairs concurrently\n' +
        '- Leverage: 1x-5x based on pair quality (higher for strong signals)\n' +
        '- Margin limits: $500-$1000 per position (20 positions max)\n' +
        '- Social sentiment: Research recent X posts, news, and web discussions for market insights\n' +
        '- If no candidate meets ALL thresholds, return signal "NONE" with clear rationale.\n\n' +
        '### Output Format\n' +
        'JSON only:\n' +
        '{"summary": string, "mode": "PAIR", "pair"?: {"long": string, "short": string, "corr"?: number, "beta"?: number, "spreadZ"?: number, "adfT"?: number, "halfLife"?: number, "fundingNet"?: number}, "signal": "ENTER"|"EXIT"|"REDUCE"|"NONE", "sizing"?: {"longSizeUsd": number, "shortSizeUsd": number, "leverage": number}, "risk"?: {"profitTargetZ": number, "reduceAtPnlUsd": number, "stopLossPnlUsd": number, "timeStopHours": number, "maxDurationHours"?: number}, "rationale": string[]}'
    );
}

