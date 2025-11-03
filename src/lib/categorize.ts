type Taxonomy = {
    sector?: string;
    ecosystem?: string;
    type?: string;
    narratives?: string[];
    stablecoin?: { issuer?: string; peg?: string } | null;
};

export function mapFromCmcTags(baseAsset: string, cmcEntry: any): Taxonomy {
    const out: Taxonomy = {};
    const tags: string[] = Array.isArray(cmcEntry?.tags) ? cmcEntry.tags : [];
    const category: string | undefined = cmcEntry?.category; // e.g., token, coin
    const platformName: string | undefined = cmcEntry?.platform?.name; // chain

    // sector
    if (['BTC', 'ETH', 'SOL', 'APT', 'SUI', 'AVAX', 'ADA', 'BCH', 'TON', 'NEAR'].includes(baseAsset)) {
        out.sector = 'Layer-1';
    } else if (tags.includes('layer-2') || ['ARB', 'OP', 'MATIC', 'BASE'].includes(baseAsset)) {
        out.sector = 'Layer-2';
    } else if (tags.some(t => /defi|amm|dex|lending|perpetual/i.test(t))) {
        out.sector = 'DeFi';
    } else if (tags.some(t => /gaming|gamefi|metaverse/i.test(t))) {
        out.sector = 'Gaming/Metaverse';
    } else if (tags.some(t => /ai|machine-learning/i.test(t))) {
        out.sector = 'AI';
    } else if (tags.some(t => /rwa|real-world-asset/i.test(t))) {
        out.sector = 'RWA';
    } else if (tags.includes('meme')) {
        out.sector = 'Meme';
    } else if (tags.some(t => /oracle/i.test(t))) {
        out.sector = 'Oracles';
    } else if (tags.some(t => /privacy|zk/i.test(t))) {
        out.sector = 'Privacy';
    }

    // ecosystem
    if (platformName) out.ecosystem = platformName;
    if (!out.ecosystem) {
        if (['BTC'].includes(baseAsset)) out.ecosystem = 'Bitcoin';
        if (['ETH'].includes(baseAsset)) out.ecosystem = 'Ethereum';
        if (['SOL'].includes(baseAsset)) out.ecosystem = 'Solana';
    }

    // type
    if (category === 'token') out.type = 'Utility';
    if (category === 'coin') out.type = 'Base Coin';
    if (['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDE'].includes(baseAsset)) {
        out.type = 'Stablecoin';
        const issuer = baseAsset === 'USDC' ? 'Circle' : baseAsset === 'USDT' ? 'Tether' : undefined;
        out.stablecoin = { issuer, peg: 'USD' };
    }

    // narratives
    const narratives: string[] = [];
    if (tags.includes('restaking')) narratives.push('Restaking');
    if (tags.includes('liquid-staking-derivatives')) narratives.push('LSD');
    if (tags.includes('bridge')) narratives.push('Interoperability');
    if (tags.includes('depin')) narratives.push('DePIN');
    if (tags.includes('rwa')) narratives.push('RWA');
    if (tags.includes('meme')) narratives.push('Meme');
    if (tags.includes('ai')) narratives.push('AI');
    out.narratives = narratives.length ? narratives : undefined;

    return out;
}


