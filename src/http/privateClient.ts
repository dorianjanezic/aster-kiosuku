import crypto from 'crypto';

export class PrivateClient {
    constructor(private baseUrl: string, private basePath: string, private apiKey: string, private apiSecret: string) { }

    private url(path: string): string {
        return `${this.baseUrl}${this.basePath}${path}`;
    }

    private sign(query: string): string {
        return crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
    }

    // Placeholder for future signed requests
    async postOrder(_body: Record<string, unknown>): Promise<unknown> {
        throw new Error('Not implemented');
    }
}

