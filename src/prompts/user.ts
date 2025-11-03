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

        const list = availablePairs.slice(0, 5); // Reduced from 10 to 5
        if (!list.length) return '';

        // Calculate quality scores and sort
        const scoredList = list.map(p => {
            const cointegration = (p as any).cointegration || {};
            const qualityScore = (
                (p.corr || 0) * 0.25 +
                (Math.abs((p as any).spreadZ || 0)) * 0.25 +
                (((p as any).scores?.long || 0) * 0.15) +
                (((p as any).scores?.short || 0) * 0.15) -
                ((cointegration.halfLife || 0) / 5) * 0.1 +
                (cointegration.adfT || 0) * 0.1 -
                ((p as any).fundingNet || 0) * 1000  // Lower funding costs = higher score
            );

            return {
                ...p,
                qualityScore: Number(qualityScore.toFixed(3))
            };
        }).sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));

        return ('\n  <pairs>\n' +
            '    New pair opportunities:\n\n' +
            scoredList.map((p, i) => {
                const tech = (p as any).technicals || {};
                const scores = (p as any).scores || {};
                return `    ${i + 1}. ${p.long}/${p.short} (${p.sector || p.ecosystem || 'Unknown'})\n` +
                    `       Stats: corr=${p.corr?.toFixed(3)}, beta=${p.beta?.toFixed(3) || 'null'}, adfT=${((p as any).cointegration?.adfT || 0)?.toFixed(2)}, halfLife=${((p as any).cointegration?.halfLife || 0)?.toFixed(1)}p, spreadZ=${((p as any).spreadZ || 0)?.toFixed(2)}, fundingNet=${((p as any).fundingNet || 0)?.toFixed(6)}\n` +
                    `       Technical: rsiDiv=${tech.rsiDivergence?.toFixed(2) || 'null'}, volConf=${tech.volumeConfirmation?.toFixed(2) || 'null'}, regime=${tech.regimeScore?.toFixed(2) || 'null'}, adx=${tech.adxTrend?.toFixed(1) || 'null'}\n` +
                    `       Scores: long=${scores.long?.toFixed(2) || 'null'}, short=${scores.short?.toFixed(2) || 'null'}, composite=${scores.composite?.toFixed(2) || 'null'}\n` +
                    `       Quality: ${p.qualityScore}\n`;
            }).join('') +
            '\n    Criteria: corr≥0.7, adfT≤-1.645, halfLife≤40p, |spreadZ|≥0.8\n' +
            '    Technical: Prefer positive rsiDivergence, volumeConfirmation, and low ADX (ranging markets)\n' +
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
            spreadZ: Number((ap.spreadZ || 0).toFixed(2)),
            deltaSpreadZ: ap.deltaSpreadZ != null ? Number(ap.deltaSpreadZ.toFixed(3)) : null,
            halfLifeHours: (ap as any).halfLife || null,
            elapsedHours: (ap as any).elapsedMs ? ((ap as any).elapsedMs / (1000 * 60 * 60)) : 0,
            convergencePct: (ap as any).convergenceProgress || null,
            exitSignals: (ap as any).exitSignals || {}
        }));

        return JSON.stringify({
            asOf,
            portfolio: {
                balance: Number(account.balanceUsd.toFixed(0)),
                equity: Number(account.equityUsd.toFixed(0)),
                marginUsed: Number(account.marginUsedUsd.toFixed(0)),
                availableMargin: Number(account.availableMarginUsd.toFixed(0)),
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
        `## Active Pairs (Currently Trading)\n` +
        (activePairs || []).map(ap => `- ${ap.long}/${ap.short}`).join('\n') + '\n\n' +
        `## Open Positions\n` +
        `${posLines}\n\n` +
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
        '- Statistical criteria: corr≥0.7, adfT≤-1.645, halfLife≤40p, |spreadZ|≥0.8\n' +
        '- Technical indicators: Prefer pairs with positive RSI divergence, volume confirmation, and low ADX\n' +
        '- Asset scores: Favor pairs where both long and short assets have positive scores\n' +
        '- Market regime: Favor pairs in ranging markets (ADX < 25) over trending markets\n' +
        '- Maximum 10 pairs concurrently\n' +
        '- Leverage: 1x-5x based on pair quality (higher for strong signals)\n' +
        '- Margin limits: $500-$1000 per position (20 positions max)\n' +
        '- Social sentiment: Research recent X posts, news, and web discussions for market insights\n\n' +
        '### Output Format\n' +
        'JSON only:\n' +
        '{"summary": string, "mode": "PAIR", "pair": {"long": string, "short": string, ...}, "signal": "ENTER"|"EXIT"|"REDUCE"|"NONE", "sizing"?: {"longSizeUsd": number, "shortSizeUsd": number, "leverage": number}, "risk"?: {"long": {"stopLoss": number, "takeProfit": number, "leverage": number}, "short": {"stopLoss": number, "takeProfit": number, "leverage": number}}, "rationale": string[]}'
    );
}

