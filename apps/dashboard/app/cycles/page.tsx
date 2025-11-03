import { z } from 'zod'

const SlimCycleEventSchema = z.object({ ts: z.number(), type: z.enum(['user', 'decision']), data: z.unknown() }).passthrough()
const SlimCyclesResponseSchema = z.object({ events: z.array(SlimCycleEventSchema) }).passthrough()

async function fetchCycles() {
    try {
        const backend = process.env.BACKEND_BASE_URL || process.env.NEXT_PUBLIC_BACKEND_BASE_URL || process.env.NEXT_PUBLIC_DASHBOARD_BASE_URL || 'https://aster-kiosuku-production.up.railway.app'
        const res = await fetch(new URL('/api/cycles', backend).toString(), { cache: 'no-store' })
        if (!res.ok) return { events: [] }
        const data = await res.json()
        const parsed = SlimCyclesResponseSchema.safeParse(data)
        if (parsed.success) {
            return parsed.data
        } else {
            // Fallback: return raw data if schema parsing fails
            return { events: Array.isArray(data?.events) ? data.events : [] }
        }
    } catch (err) {
        return { events: [] }
    }
}

function formatJson(data: unknown): string {
    try {
        if (typeof data === 'string') {
            try {
                const parsed = JSON.parse(data)
                return JSON.stringify(parsed, null, 2)
            } catch {
                return data
            }
        }
        return JSON.stringify(data, null, 2)
    } catch {
        return '[unserializable]'
    }
}

function formatMessage(data: unknown): string {
    if (typeof data === 'string') {
        return data
    }

    if (data && typeof data === 'object') {
        // Handle decision events with "raw" field
        if ('raw' in data && typeof data.raw === 'string') {
            try {
                const parsed = JSON.parse(data.raw)
                if (parsed.summary) {
                    return parsed.summary
                }
                return data.raw
            } catch {
                return data.raw as string
            }
        }

        // Handle user_raw/state events with "content" field
        if ('content' in data && typeof data.content === 'string') {
            const content = data.content as string

            // Extract key information from the prompt for better readability
            const lines = content.split('\n')

            // Try to find the task summary or key information
            const taskLine = lines.find(line => line.includes('## Task'))
            const contextLines = lines.filter(line => line.includes('## Context') ||
                                                    line.includes('## Portfolio Status') ||
                                                    line.includes('## Active Pairs'))

            if (taskLine) {
                // Return a concise summary for state updates
                return "Portfolio and market state assessment for trading decision"
            }

            // Fallback to first meaningful line
            const firstMeaningful = lines.find(line =>
                line.trim() &&
                !line.startsWith('#') &&
                !line.includes('Timestamp:') &&
                line.length > 10
            )

            return firstMeaningful || "Trading state update"
        }
    }

    // Fallback to JSON formatting
    return formatJson(data)
}

function teaser(text: string, max = 160): string {
    if (text.length <= max) return text
    return text.slice(0, max).trimEnd() + '…'
}

export default async function CyclesPage() {
    const { events } = await fetchCycles()
    const sorted = [...events].sort((a, b) => b.ts - a.ts)
    return (
        <main>
            <h2 className="mb-3 text-base font-semibold">Cycles</h2>
            <div className="space-y-3">
                {sorted.map((e) => {
                    const isDecision = e.type === 'decision'
                    const content = formatMessage(e.data)
                    const fullContent = formatJson(e.data)
                    return (
                        <details key={`${e.ts}-${e.type}`} className="rounded-md border border-border bg-card">
                            <summary className="cursor-pointer select-none px-3 py-2 text-sm">
                                <span className="mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide bg-secondary text-secondary-foreground">
                                            {isDecision ? 'Agent' : 'State'}
                                        </span>
                                <span className="text-muted-foreground">{new Date(e.ts).toLocaleString()}</span>
                                <span className="ml-3 text-foreground">{teaser(content)}</span>
                            </summary>
                            <div className="px-3 pb-3">
                                <div className="mb-2">
                                    <p className="text-sm text-foreground leading-relaxed">{content}</p>
                                </div>
                                <details className="mt-2">
                                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Show Raw Data</summary>
                                    <pre className="mt-1 p-2 bg-muted rounded text-xs font-mono overflow-x-auto">{fullContent}</pre>
                                </details>
                            </div>
                        </details>
                    )
                })}
            </div>
        </main>
    )
}


