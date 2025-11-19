/**
 * PAIR UTILITIES
 * 
 * Shared utilities for pair trading operations, ensuring consistent
 * pair key generation and direction tracking across the system.
 */

/**
 * Creates a canonical pair key that is independent of current long/short direction.
 * Always orders symbols alphabetically to ensure consistency.
 * 
 * Example: 
 * - createCanonicalPairKey('ETHUSDT', 'BTCUSDT') => 'BTCUSDT|ETHUSDT'
 * - createCanonicalPairKey('BTCUSDT', 'ETHUSDT') => 'BTCUSDT|ETHUSDT'
 * 
 * This ensures the same structural pair always has the same key,
 * regardless of which asset is currently long or short.
 */
export function createCanonicalPairKey(symbolA: string, symbolB: string): string {
    if (!symbolA || !symbolB) {
        throw new Error(`Invalid symbols for pair key: ${symbolA}, ${symbolB}`);
    }
    // Alphabetical ordering ensures consistency
    return symbolA < symbolB ? `${symbolA}|${symbolB}` : `${symbolB}|${symbolA}`;
}

/**
 * Determines which symbol is the "first" in the canonical ordering.
 * Returns 'A' if symbolA comes first alphabetically, 'B' otherwise.
 */
export function getCanonicalFirst(symbolA: string, symbolB: string): 'A' | 'B' {
    return symbolA < symbolB ? 'A' : 'B';
}

/**
 * Extracts both symbols from a canonical pair key.
 * Returns them in alphabetical order (as stored in the key).
 */
export function parseCanonicalPairKey(pairKey: string): { first: string; second: string } {
    const parts = pairKey.split('|');
    if (parts.length !== 2) {
        throw new Error(`Invalid pair key format: ${pairKey}`);
    }
    return { first: parts[0]!, second: parts[1]! };
}

/**
 * Determines the current direction indicator for a pair.
 * Returns which symbol in the canonical ordering is currently LONG.
 * 
 * Example:
 * - Canonical key: 'BTCUSDT|ETHUSDT' (BTC first, ETH second)
 * - If long=BTC, short=ETH => direction='FIRST_LONG'
 * - If long=ETH, short=BTC => direction='SECOND_LONG'
 */
export function getPairDirection(
    canonicalFirst: string,
    canonicalSecond: string,
    currentLong: string,
    currentShort: string
): 'FIRST_LONG' | 'SECOND_LONG' {
    if (currentLong === canonicalFirst && currentShort === canonicalSecond) {
        return 'FIRST_LONG';
    } else if (currentLong === canonicalSecond && currentShort === canonicalFirst) {
        return 'SECOND_LONG';
    } else {
        throw new Error(
            `Mismatched pair symbols: canonical=(${canonicalFirst}|${canonicalSecond}), ` +
            `current=(long:${currentLong}, short:${currentShort})`
        );
    }
}

/**
 * Resolves current long/short from canonical key and direction.
 */
export function resolveLongShortFromDirection(
    pairKey: string,
    direction: 'FIRST_LONG' | 'SECOND_LONG'
): { long: string; short: string } {
    const { first, second } = parseCanonicalPairKey(pairKey);
    if (direction === 'FIRST_LONG') {
        return { long: first, short: second };
    } else {
        return { long: second, short: first };
    }
}

