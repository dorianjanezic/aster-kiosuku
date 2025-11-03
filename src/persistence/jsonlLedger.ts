/**
 * JSONL LEDGER
 *
 * Append-only JSON Lines logging system for trading data persistence.
 * Provides immutable audit trail of:
 * - Trading decisions and rationales
 * - Order executions and fills
 * - Portfolio state changes
 * - Performance metrics and P&L
 *
 * Key Features:
 * - Append-only for data integrity
 * - Efficient streaming reads
 * - Timestamped entries with type metadata
 * - Crash recovery and replay capabilities
 */

import { promises as fs } from 'fs';

export class JsonlLedger {
    constructor(private filePath: string) { }

    async append(type: string, data: unknown): Promise<void> {
        await fs.mkdir(this.dirName(), { recursive: true });
        const line = JSON.stringify({ ts: Date.now(), type, data }) + '\n';
        await fs.appendFile(this.filePath, line, { encoding: 'utf8' });
    }

    private dirName(): string {
        const idx = this.filePath.lastIndexOf('/');
        return idx > 0 ? this.filePath.slice(0, idx) : '.';
    }
}

export async function readLastLines(filePath: string, maxLines: number): Promise<string[]> {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.trim().split('\n');
        return lines.slice(Math.max(0, lines.length - maxLines));
    } catch (e: any) {
        if (e && e.code === 'ENOENT') return [];
        throw e;
    }
}

