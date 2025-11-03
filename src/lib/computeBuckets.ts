export type ComputedBuckets = {
    liquidityTier?: 'T1' | 'T2' | 'T3';
    volatilityBucket?: 'Low' | 'Med' | 'High';
    fundingProfile?: 'MeanRevert' | 'Trending' | 'Neutral';
    isMajor?: boolean;
};

export function computeBuckets(input: {
    symbol: string;
    baseAsset?: string;
    stats24h?: { volume?: number; quoteVolume?: number };
    orderbook?: { bidDepth5?: number; askDepth5?: number; notionalBid5?: number; notionalAsk5?: number };
    atrPct14?: number; // ATR% over 14 periods
    funding?: { mean?: number; variance?: number };
    majors?: string[];
}): ComputedBuckets {
    const majors = input.majors || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    const isMajor = majors.includes(input.symbol);

    const volUsd = input.stats24h?.quoteVolume ?? input.stats24h?.volume ?? 0;
    const notionalDepth = (input.orderbook?.notionalBid5 ?? 0) + (input.orderbook?.notionalAsk5 ?? 0);
    // Combine using logarithms to tame scale differences
    const liqScore = Math.log10(1 + Math.max(0, volUsd)) + Math.log10(1 + Math.max(0, notionalDepth));
    // Heuristic thresholds: > 8 => T1, > 6 => T2, else T3 (tune as needed)
    const liquidityTier = liqScore > 8 ? 'T1' : liqScore > 6 ? 'T2' : 'T3';

    const atrp = input.atrPct14 ?? 0;
    const volatilityBucket = atrp < 1 ? 'Low' : atrp < 3 ? 'Med' : 'High';

    const mean = input.funding?.mean ?? 0;
    const variance = input.funding?.variance ?? 0;
    const fundingProfile = Math.abs(mean) < 0.005 && variance > 0.00005 ? 'MeanRevert' : Math.abs(mean) >= 0.005 ? 'Trending' : 'Neutral';

    return { liquidityTier, volatilityBucket, fundingProfile, isMajor };
}


