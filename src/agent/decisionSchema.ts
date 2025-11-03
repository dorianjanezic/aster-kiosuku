/**
 * TRADING DECISION SCHEMA
 *
 * Defines the JSON schema for LLM trading decisions. This ensures
 * the AI agent returns structured, parseable trading instructions
 * with proper validation for signal types, sizing, and risk parameters.
 *
 * The schema enforces consistency between the agent's reasoning
 * and executable trading actions, bridging natural language
 * decision-making with programmatic order execution.
 */

export const TradingDecisionSchema = {
    type: 'json_schema',
    json_schema: {
        name: 'TradingDecision',
        schema: {
            type: 'object',
            properties: {
                summary: { type: 'string' },
                mode: { type: 'string', enum: ['PAIR'] },
                pair: {
                    type: 'object',
                    properties: {
                        sector: { type: 'string' },
                        ecosystem: { type: 'string' },
                        assetType: { type: 'string' },
                        long: { type: 'string' },
                        short: { type: 'string' },
                        corr: { type: 'number' },
                        beta: { type: 'number' },
                        spreadZ: { type: 'number' },
                        halfLife: { type: 'number' }
                    },
                    required: ['long', 'short'],
                    allOf: [
                        {
                            anyOf: [
                                { required: ['sector'] },
                                { required: ['ecosystem'] },
                                { required: ['assetType'] }
                            ]
                        }
                    ]
                },
                signal: { type: 'string', enum: ['ENTER', 'EXIT', 'REDUCE', 'NONE'] },
                sizing: {
                    type: 'object',
                    properties: {
                        longSizeUsd: { type: 'number' },
                        shortSizeUsd: { type: 'number' },
                        leverage: { type: 'number', minimum: 1, maximum: 5 }
                    },
                    required: ['longSizeUsd', 'shortSizeUsd', 'leverage']
                },
                risk: {
                    type: 'object',
                    properties: {
                        long: { type: 'object', properties: { stopLoss: { type: 'number' }, takeProfit: { type: 'number' }, leverage: { type: 'number', minimum: 1, maximum: 5 } }, required: ['stopLoss', 'takeProfit', 'leverage'] },
                        short: { type: 'object', properties: { stopLoss: { type: 'number' }, takeProfit: { type: 'number' }, leverage: { type: 'number', minimum: 1, maximum: 5 } }, required: ['stopLoss', 'takeProfit', 'leverage'] }
                    },
                    required: ['long', 'short']
                },
                rationale: { type: 'array', items: { type: 'string' } }
            },
            required: ['summary', 'mode', 'signal', 'rationale'],
            additionalProperties: false
        },
        strict: true
    }
} as const;


