import { PriceMonitorService } from '../dist/services/priceMonitorService.js';
import { WebSocketServer } from 'ws';

function waitUntil(predicate, timeoutMs = 3000, stepMs = 25) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
            setTimeout(tick, stepMs);
        };
        tick();
    });
}

describe('PriceMonitorService', () => {
    let wss;
    const port = 18080;
    const baseUrl = `ws://127.0.0.1:${port}`;

    beforeAll((done) => {
        wss = new WebSocketServer({ port }, () => done());
        wss.on('connection', (socket, req) => {
            const path = req.url || '';
            if (path.includes('@bookTicker')) {
                setTimeout(() => {
                    socket.send(JSON.stringify({ b: 10, a: 12 }));
                }, 10);
            }
            if (path.includes('@aggTrade')) {
                setTimeout(() => {
                    socket.send(JSON.stringify({ p: 11 }));
                }, 10);
            }
        });
    });

    afterAll(async () => {
        try { wss.clients.forEach((c) => { try { c.terminate(); } catch { } }); } catch { }
        await new Promise((resolve) => { try { wss.close(() => resolve()); } catch { resolve(); } });
    });

    test('updates mid from bookTicker and last from aggTrade', async () => {
        process.env.ASTER_WS_MODE = 'paths';
        process.env.ASTER_WS_PATH = '';
        process.env.ASTER_WS_STREAMS = 'bookTicker,aggTrade';

        const svc = new PriceMonitorService(baseUrl, ['SEIUSDT']);
        svc.start();

        await waitUntil(() => {
            const snap = svc.get('SEIUSDT');
            return !!snap && snap.bestBid != null && snap.bestAsk != null && snap.mid != null && snap.last != null;
        }, 10000, 25);

        const snap = svc.get('SEIUSDT');
        expect(snap).toBeDefined();
        expect(snap.bestBid).toBe(10);
        expect(snap.bestAsk).toBe(12);
        expect(snap.mid).toBe(11);
        expect(snap.last).toBe(11);

        svc.stop();
    }, 15000);
});


