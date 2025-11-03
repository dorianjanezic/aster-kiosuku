/**
 * LLM PROVIDER INTERFACE & IMPLEMENTATIONS
 *
 * Abstraction layer for Large Language Model interactions, supporting:
 * - Structured chat completions with tool calling
 * - Live search integration (x.ai web/X/news search)
 * - Multiple model providers (Grok, Gemini, etc.)
 * - Response format validation and error handling
 *
 * This module enables AI-powered decision making with real-time
 * market data access through integrated search capabilities.
 */

export type ToolSchema = {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
};

export type ToolCall = {
    name: string;
    arguments: unknown;
};

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface LLMProvider {
    chatWithTools(messages: ChatMessage[], tools: ToolSchema[], options?: { model?: string; responseFormat?: any; searchParameters?: any }): Promise<{
        assistantText?: string;
        toolCalls?: ToolCall[];
    }>;
    agenticResearch?(prompt: string, options?: { model?: string }): Promise<{
        content?: string;
        citations?: any;
        toolCalls?: any;
        usage?: any;
    }>;
}

export class NoopProvider implements LLMProvider {
    async chatWithTools(): Promise<{ assistantText?: string; toolCalls?: ToolCall[] }> {
        return { assistantText: 'No LLM provider configured.' };
    }
}

function toOpenAITool(tool: ToolSchema) {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters || { type: 'object' }
        }
    };
}

export class GrokProvider implements LLMProvider {
    private apiKey: string;
    private apiUrl: string;
    private responsesUrl: string;
    constructor() {
        this.apiKey = process.env.GROK_API_KEY || '';
        this.apiUrl = process.env.GROK_API_URL || 'https://api.x.ai/v1/chat/completions';
        this.responsesUrl = process.env.GROK_RESPONSES_URL || 'https://api.x.ai/v1/responses';
        if (!this.apiKey) throw new Error('GROK_API_KEY is required');
    }

    async chatWithTools(messages: ChatMessage[], tools: ToolSchema[], options?: { model?: string; responseFormat?: any; searchParameters?: any }) {
        const model = options?.model || process.env.LLM_MODEL || 'grok-2-latest';
        const body: any = {
            model,
            messages
        };
        if (tools && tools.length > 0) {
            body.tools = tools.map(toOpenAITool);
            body.tool_choice = 'auto';
        }
        if (options?.responseFormat) body.response_format = options.responseFormat;
        if (options?.searchParameters) body.search_parameters = options.searchParameters;
        const res = await fetch(this.apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Grok API ${res.status}: ${errText}`);
        }
        const json: any = await res.json();
        const msg = json?.choices?.[0]?.message;
        const assistantText = typeof msg?.content === 'string' ? msg.content : undefined;
        const toolCalls: ToolCall[] | undefined = msg?.tool_calls?.map((tc: any) => ({
            name: tc?.function?.name,
            arguments: safeParseJson(tc?.function?.arguments)
        }));
        return { assistantText, toolCalls };
    }

    async agenticResearch(prompt: string, options?: { model?: string }) {
        const model = options?.model || process.env.LLM_AGENTIC_MODEL || 'grok-4-fast';
        const body: any = {
            model,
            input: [
                { role: 'user', content: prompt }
            ],
            tools: [
                { type: 'web_search' },
                { type: 'x_search' }
            ]
        };
        const res = await fetch(this.responsesUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Grok Responses API ${res.status}: ${errText}`);
        }
        const json: any = await res.json();
        return {
            content: json?.output_text || json?.content || json?.response?.content,
            citations: json?.citations,
            toolCalls: json?.tool_calls,
            usage: json?.usage || json?.server_side_tool_usage
        };
    }
}

function safeParseJson(v: any): any {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
}

export function createProviderFromEnv(): LLMProvider {
    const provider = (process.env.LLM_PROVIDER || 'noop').toLowerCase();
    // Placeholders for future Grok/Gemini implementations
    if (provider === 'grok') return new GrokProvider();
    // if (provider === 'gemini') return new GeminiProvider();
    return new NoopProvider();
}

