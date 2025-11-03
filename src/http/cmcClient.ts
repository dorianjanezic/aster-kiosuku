import { request as httpsRequest } from 'https';

export class CmcClient {
    constructor(private apiKey: string = process.env.CMC_API_KEY || '') { }

    async getCryptocurrencyInfoBySymbol(symbols: string[]): Promise<any> {
        if (!this.apiKey) throw new Error('CMC_API_KEY is required');
        const qs = new URLSearchParams({ symbol: symbols.join(',') }).toString();
        const url = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/info?${qs}`;
        const headers = { 'X-CMC_PRO_API_KEY': this.apiKey } as Record<string, string>;
        return httpGetJson(url, headers);
    }
}

function httpGetJson(url: string, headers: Record<string, string>): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = httpsRequest(url, { method: 'GET', headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            res.on('end', () => {
                try {
                    const text = Buffer.concat(chunks).toString('utf8');
                    const json = JSON.parse(text);
                    resolve(json);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}


