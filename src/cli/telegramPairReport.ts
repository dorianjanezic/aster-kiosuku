/**
 * TELEGRAM PAIR ANALYSIS REPORT
 *
 * Generates formatted Telegram messages with pair analysis findings.
 * Usage: pnpm build && node dist/cli/telegramPairReport.js <pair-json-file>
 */

import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';

// Support both old flat format and new grouped format
interface PairAnalysis {
  // New grouped format
  pair?: { symbol1: string; symbol2: string };
  correlation?: { value: number; strength: string } | number;
  cointegration?: { isCointegrated: boolean; halfLifeDays: number | null };
  rollingZScore?: { value: number; absValue: number; signal: string };
  beta?: { value: number; absValue: number } | number;
  volatility?: { spreadVolatility: number };
  signals?: {
    entryThreshold: number;
    exitThreshold: number;
    isEntrySignal: boolean;
    isExitSignal: boolean;
    currentAbsZ: number;
  };
  positionSizing?: {
    formula: string;
    exampleBankroll: number;
    longSymbol?: string;
    longAmount: number;
    longPercent?: string;
    shortSymbol?: string;
    shortAmount: number;
    shortPercent?: string;
    ratio: string;
  };
  technicals?: {
    rsi?: { [key: string]: number };
    rsi1?: number;
    rsi2?: number;
  };
  recommendation?: {
    direction: string;
    longSymbol?: string;
    shortSymbol?: string;
    long?: string;
    short?: string;
    signalStrength: string;
    action?: string;
  };
  quality?: { compositeScore: number; rating: string };
  metadata?: { generatedAt: string; interval: string; candlesUsed: number };
  
  // Old flat format (for backwards compatibility)
  symbol1?: string;
  symbol2?: string;
  spreadZ?: number;
  spreadVol?: number;
  adf?: { stationary: boolean; halfLife: number | null };
  compositeScore?: number;
  hedgeRatio?: number;
  fundingNet?: number;
}

function formatPairAnalysis(analysis: PairAnalysis, timeframe: string = '1h', candles: number = 750): string {
  // Extract values supporting both old and new format
  const symbol1 = analysis.pair?.symbol1 || analysis.symbol1 || 'UNKNOWN';
  const symbol2 = analysis.pair?.symbol2 || analysis.symbol2 || 'UNKNOWN';
  
  const correlationVal = typeof analysis.correlation === 'object' 
    ? analysis.correlation.value 
    : (analysis.correlation ?? 0);
  
  const betaVal = typeof analysis.beta === 'object'
    ? analysis.beta.value
    : (analysis.beta ?? 1);
  
  const spreadZ = typeof analysis.rollingZScore === 'object'
    ? analysis.rollingZScore.value
    : (analysis.spreadZ ?? 0);
  
  const spreadVol = typeof analysis.volatility === 'object'
    ? analysis.volatility.spreadVolatility
    : (analysis.spreadVol ?? 0);
  
  const isCointegrated = analysis.cointegration?.isCointegrated ?? analysis.adf?.stationary ?? false;
  const halfLife = analysis.cointegration?.halfLifeDays ?? analysis.adf?.halfLife ?? null;
  
  const longSymbol = analysis.recommendation?.longSymbol || analysis.recommendation?.long || symbol1;
  const shortSymbol = analysis.recommendation?.shortSymbol || analysis.recommendation?.short || symbol2;
  
  // Get RSI values
  let rsi1 = 50, rsi2 = 50;
  if (analysis.technicals?.rsi) {
    const rsiKeys = Object.keys(analysis.technicals.rsi);
    if (rsiKeys.length >= 2) {
      rsi1 = analysis.technicals.rsi[rsiKeys[0]] ?? 50;
      rsi2 = analysis.technicals.rsi[rsiKeys[1]] ?? 50;
    }
  } else if (analysis.technicals) {
    rsi1 = analysis.technicals.rsi1 ?? 50;
    rsi2 = analysis.technicals.rsi2 ?? 50;
  }

  // Format numbers for display
  const formatNum = (num: number, decimals: number = 2) =>
    Number.isFinite(num) ? num.toFixed(decimals) : 'N/A';

  // Signal strength emoji
  const getSignalEmoji = (strength: string) => {
    switch (strength?.toLowerCase()) {
      case 'strong': return '🟢';
      case 'moderate': return '🟡';
      case 'weak': return '🔴';
      default: return '⚪';
    }
  };

  // Cointegration status
  const cointegrationStatus = isCointegrated ? '✅ Cointegrated' : '❌ Not Cointegrated';

  // Correlation interpretation
  const getCorrelationDesc = (corr: number) => {
    const abs = Math.abs(corr);
    if (abs >= 0.8) return 'Very Strong';
    if (abs >= 0.6) return 'Strong';
    if (abs >= 0.4) return 'Moderate';
    if (abs >= 0.2) return 'Weak';
    return 'Very Weak';
  };

  // Z-score interpretation
  const getZScoreDesc = (z: number) => {
    const abs = Math.abs(z);
    if (abs >= 2.0) return 'Extreme';
    if (abs >= 1.5) return 'Strong';
    if (abs >= 1.0) return 'Moderate';
    return 'Weak';
  };

  // Entry/Exit signal formatting
  const entrySignal = analysis.signals?.isEntrySignal ? '🟢 ENTRY' : '🔴 No Entry';
  const exitSignal = analysis.signals?.isExitSignal ? '🟢 EXIT' : '🔴 Hold';

  // Position sizing formatting
  const posLong = analysis.positionSizing?.longAmount 
    ? `$${analysis.positionSizing.longAmount.toFixed(0)}` 
    : 'N/A';
  const posShort = analysis.positionSizing?.shortAmount 
    ? `$${analysis.positionSizing.shortAmount.toFixed(0)}` 
    : 'N/A';

  const absBeta = Math.abs(betaVal);
  const signalStrength = analysis.recommendation?.signalStrength || 'Weak';
  const direction = analysis.recommendation?.direction || 'Unknown';

  const message = `📊 *Pair Analysis Report*

*${symbol1} ↔ ${symbol2}*
\`Timeframe: ${timeframe} | Candles: ${candles} | Rolling: 30d\`

*Statistical Metrics:*
• Correlation: ${formatNum(correlationVal)} (${getCorrelationDesc(correlationVal)})
• Beta (Rolling Hedge): ${formatNum(betaVal)}
• ${cointegrationStatus}

*Spread Analysis:*
• Rolling Z-Score: ${formatNum(spreadZ)} (${getZScoreDesc(spreadZ)})
• Spread Volatility: ${formatNum(spreadVol, 4)}
• Half-Life: ${halfLife !== null ? formatNum(halfLife) : 'N/A'} days

*Entry/Exit Signals (Pear Protocol):*
• Entry (|Z| ≥ 2.0): ${entrySignal}
• Exit (|Z| ≤ 0.5): ${exitSignal}
• Current |Z|: ${formatNum(analysis.signals?.currentAbsZ ?? Math.abs(spreadZ))}

*Position Sizing (Beta-Neutral):*
• β = ${formatNum(absBeta, 4)} (Short is ${absBeta < 1 ? 'LESS' : 'MORE'} volatile)
• Long ${longSymbol}: ${posLong} (${analysis.positionSizing ? (analysis.positionSizing.longAmount / analysis.positionSizing.exampleBankroll * 100).toFixed(0) : 'N/A'}%)
• Short ${shortSymbol}: ${posShort} (${analysis.positionSizing ? (analysis.positionSizing.shortAmount / analysis.positionSizing.exampleBankroll * 100).toFixed(0) : 'N/A'}%)

*Technical Indicators:*
• RSI ${symbol1}: ${formatNum(rsi1)}
• RSI ${symbol2}: ${formatNum(rsi2)}

*Trading Recommendation:*
${getSignalEmoji(signalStrength)} *${direction}*
• Long: ${longSymbol}
• Short: ${shortSymbol}
• Signal: ${signalStrength}

\`Generated: ${new Date().toISOString()}\``;

  return message;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 1) {
    console.error('Usage: node dist/cli/telegramPairReport.js <pair-json-file>');
    console.error('Example: node dist/cli/telegramPairReport.js sim_data/pair-HYPEUSDT-ASTERUSDT-2025-11-26T10-48-53-596Z.json');
    process.exit(1);
  }

  const filePath = args[0];

  try {
    // Read the pair analysis file
    const content = await fs.readFile(filePath, 'utf8');
    const analysis: PairAnalysis = JSON.parse(content);

    // Extract timeframe and candles from environment or use defaults
    const timeframe = process.env.PAIRS_INTERVAL || '1h';
    const candles = parseInt(process.env.PAIRS_LIMIT || '500');

    // Generate the Telegram message
    const telegramMessage = formatPairAnalysis(analysis, timeframe, candles);

    console.log('='.repeat(50));
    console.log('TELEGRAM MESSAGE:');
    console.log('='.repeat(50));
    console.log(telegramMessage);
    console.log('='.repeat(50));

    // Also save to a text file for easy copying
    const messageFile = filePath.replace('.json', '-telegram.txt');
    await fs.writeFile(messageFile, telegramMessage, 'utf8');
    console.log(`\nMessage also saved to: ${messageFile}`);
    console.log('You can copy-paste this directly to Telegram!');

  } catch (error) {
    console.error('Error generating Telegram report:', error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
