import createDebug from 'debug';

type PriceSnapshot = {
    symbol: string;
    bestBid?: number;
    bestAsk?: number;
    last?: number;
    mid?: number;
    updatedAt: number;
};

type WSFactory = (url: string) => WebSocket;

// Minimal WS wrapper using global WebSocket (Node18+ with experimental ws or polyfill by user)
export class PriceMonitorService {
    private log = createDebug('agent:prices');
    private sockets: WebSocket[] = [];
    private bySymbol = new Map<string, PriceSnapshot>();
    private closed = false;
    private lastLog = new Map<string, number>();
    private tracked = new Set<string>();
    private wsMode: 'combined' | 'paths' | 'auto' = (process.env.ASTER_WS_MODE as any) || 'auto';
    private pathPrefix: string | undefined = process.env.ASTER_WS_PATH || undefined; // e.g., '/ws'
    private streams: string[] = (process.env.ASTER_WS_STREAMS ? String(process.env.ASTER_WS_STREAMS).split(',') : ['markPrice@1s', 'bookTicker']).map(s => s.trim());
    private allMarksStream: string | undefined = undefined; // e.g., '!markPrice@arr' or '!markPrice@arr@1s'

    constructor(private wsBaseUrl: string, private symbols: string[]) {
        for (const s of symbols) this.tracked.add(s);
        // Detect all-mark stream configuration
        const arr = this.streams.find(s => s.startsWith('!markPrice@arr'));
        if (arr) this.allMarksStream = arr;
    }

    start(): void {
        this.log('starting price monitor. tracked=%d symbols=%o', this.tracked.size, Array.from(this.tracked));
        if (this.allMarksStream) {
            this.openAllMarksStream(this.allMarksStream);
        } else {
            for (const s of this.tracked) this.openStreamsForSymbol(s);
        }
    }

    stop(): void {
        this.closed = true;
        for (const ws of this.sockets) {
            try { ws.close(); } catch { }
        }
        this.sockets = [];
    }

    get(symbol: string): PriceSnapshot | undefined {
        return this.bySymbol.get(symbol);
    }

    addSymbols(symbols: string[]): void {
        const newOnes: string[] = [];
        for (const s of symbols) {
            if (this.tracked.has(s)) continue;
            this.tracked.add(s);
            newOnes.push(s);
            if (!this.allMarksStream) {
                try {
                    this.openStreamsForSymbol(s);
                } catch (e) { this.log('addSymbols error %s: %o', s, e); }
            }
        }
        if (newOnes.length) {
            this.log('added %d symbols. total tracked=%d new=%o', newOnes.length, this.tracked.size, newOnes);
        }
    }

    private openAllMarksStream(streamName: string): void {
        const mode = this.wsMode === 'auto' ? 'paths' : this.wsMode; // prefer paths for special stream
        if (mode === 'combined') {
            const sep = this.wsBaseUrl.includes('?') ? '&' : '?';
            const url = `${this.wsBaseUrl.replace(/\/$/, '')}/stream${sep}streams=${encodeURIComponent(streamName)}`;
            this.log('open all-marks (combined) %s', url);
            this.openSocket(url, '*', 'markPrice').catch((e) => this.log('all-marks ws error: %o', e));
        } else {
            const base = this.wsBaseUrl.replace(/\/$/, '');
            const prefix = this.pathPrefix || '/ws';
            const url = `${base}${prefix}/${streamName}`;
            this.log('open all-marks (paths) %s', url);
            this.openSocket(url, '*', 'markPrice').catch((e) => this.log('all-marks ws error: %o', e));
        }
    }

    private openStreamsForSymbol(symbol: string): void {
        const s = symbol.toLowerCase();
        const mode = this.wsMode === 'auto' ? 'combined' : this.wsMode;
        if (mode === 'combined') {
            const stream = this.streams.map(st => `${s}@${st}`).join('/');
            const sep = this.wsBaseUrl.includes('?') ? '&' : '?';
            const url = `${this.wsBaseUrl.replace(/\/$/, '')}/stream${sep}streams=${stream}`;
            this.log('open stream (combined) %s -> %s', symbol, url);
            this.openSocket(url, symbol).catch(() => {
                if (this.wsMode === 'auto') {
                    // fallback to paths style within WS (still WS-based, not REST)
                    this.openStreamsPathStyle(symbol);
                }
            });
        } else {
            this.openStreamsPathStyle(symbol);
        }
    }

    private openStreamsPathStyle(symbol: string): void {
        const s = symbol.toLowerCase();
        const base = this.wsBaseUrl.replace(/\/$/, '');
        const prefix = this.pathPrefix || '/ws';
        for (const st of this.streams) {
            const url = `${base}${prefix}/${s}@${st}`;
            this.log('open stream (paths) %s -> %s', symbol, url);
            const kind = st.startsWith('bookTicker') ? 'bookTicker' : (st.startsWith('aggTrade') ? 'aggTrade' : (st.startsWith('markPrice') ? 'markPrice' : undefined));
            this.openSocket(url, symbol, kind).catch((e) => this.log('path ws error %s %s: %o', symbol, st, e));
        }
    }

    private async openSocket(url: string, symbol: string, kind?: 'bookTicker' | 'aggTrade' | 'markPrice'): Promise<void> {
        const WebSocketCtor = await this.ensureWebSocket();
        const ws = new WebSocketCtor(url);
        this.sockets.push(ws);
        ws.onopen = () => this.log('ws open %s', symbol);
        ws.onmessage = (evt: any) => {
            try {
                const msg = JSON.parse(String(evt?.data));
                let data: any = msg?.data ?? msg;
                const snap = this.bySymbol.get(symbol) || { symbol, updatedAt: 0 } as PriceSnapshot;
                // Determine message type: combined (msg.stream) or path (kind or heuristic)
                const stream: string | undefined = (typeof msg?.stream === 'string') ? msg.stream : undefined;
                const isBookTicker = (stream?.endsWith('@bookTicker')) || kind === 'bookTicker' || (data && (data.b != null || data.bestBid != null) && (data.a != null || data.bestAsk != null));
                const isAggTrade = (stream?.endsWith('@aggTrade')) || kind === 'aggTrade' || (data && (data.p != null || data.price != null && data.e !== 'markPriceUpdate'));
                const isMarkPrice = (stream?.endsWith('@markPrice') || stream?.endsWith('@markPrice@1s') || stream === '!markPrice@arr' || stream === '!markPrice@arr@1s') || kind === 'markPrice' || (data && (data.e === 'markPriceUpdate' || Array.isArray(data)));
                if (isBookTicker) {
                    const bid = Number(data.b ?? data.bestBid);
                    const ask = Number(data.a ?? data.bestAsk);
                    if (Number.isFinite(bid)) snap.bestBid = bid;
                    if (Number.isFinite(ask)) snap.bestAsk = ask;
                    if (snap.bestBid !== undefined && snap.bestAsk !== undefined) snap.mid = (snap.bestBid + snap.bestAsk) / 2;
                    snap.updatedAt = Date.now();
                    this.maybeLog(symbol, snap);
                } else if (isAggTrade) {
                    const last = Number(data.p ?? data.price);
                    if (Number.isFinite(last)) snap.last = last;
                    snap.updatedAt = Date.now();
                } else if (isMarkPrice) {
                    // Handle array updates (!markPrice@arr) or single symbol mark price
                    if (Array.isArray(data)) {
                        for (const item of data) {
                            const sym = String(item?.s || '').toUpperCase();
                            if (!sym) continue;
                            const mp = Number(item.p ?? item.markPrice);
                            const tgt = this.bySymbol.get(sym) || { symbol: sym, updatedAt: 0 } as PriceSnapshot;
                            if (Number.isFinite(mp)) { tgt.mid = mp; tgt.last = mp; }
                            tgt.updatedAt = Date.now();
                            this.bySymbol.set(sym, tgt);
                            this.maybeLog(sym, tgt);
                        }
                    } else {
                        const mp = Number(data.p ?? data.markPrice);
                        if (Number.isFinite(mp)) {
                            snap.mid = mp;
                            snap.last = mp;
                        }
                        snap.updatedAt = Date.now();
                        this.bySymbol.set(symbol, snap);
                        this.maybeLog(symbol, snap);
                        return;
                    }
                } else {
                    // Unknown message; ignore
                }
                if (!Array.isArray(data)) this.bySymbol.set(symbol, snap);
            } catch (e) {
                this.log('ws parse error %s: %o', symbol, e);
            }
        };
        ws.onerror = (e: any) => this.log('ws error %s ready=%s url=%s err=%o', symbol, (ws as any)?.readyState, (ws as any)?.url, e);
        ws.onclose = (ev: any) => {
            this.log('ws closed %s code=%s reason=%s', symbol, ev?.code, ev?.reason);
            if (!this.closed) setTimeout(() => { void this.openSocket(url, symbol, kind); }, 1000);
        };
    }

    private maybeLog(symbol: string, snap: PriceSnapshot): void {
        const now = Date.now();
        const prev = this.lastLog.get(symbol) || 0;
        if (now - prev >= 5000) {
            this.log('tick %s bid=%s ask=%s mid=%s', symbol, snap.bestBid, snap.bestAsk, snap.mid);
            this.lastLog.set(symbol, now);
        }
    }

    private async ensureWebSocket(): Promise<any> {
        const gws = (globalThis as any).WebSocket;
        if (gws) return gws;
        try {
            const mod: any = await import('ws');
            return mod?.default ?? mod?.WebSocket ?? mod;
        } catch (e) {
            this.log('No WebSocket available; install ws. %o', e);
            throw e;
        }
    }
}


