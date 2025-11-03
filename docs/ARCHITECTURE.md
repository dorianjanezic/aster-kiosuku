## Aster Agent Architecture (Simulation-first)

### Goals
- Env-switchable LLM provider (Grok/Gemini)
- Tool-driven agent with typed I/O
- Simulation execution first, live Aster later
- Markets auto-refresh daily; 5-minute autonomous loop

### Components
- config: envs and app settings
- http: Aster public/private clients
- services:
  - marketsService: consolidated markets and persistence
  - stateService: builds portfolio/market state (simulation)
- sim: simulated exchange for paper orders
- persistence: JSONL ledger for orders/cycles
- llm: provider scaffold and tool schemas/handlers
- scheduler: loop runner (5m)
- main: bootstrap markets refresh + loop

### Initial Tools
- get_markets(): consolidated markets
- place_order(args): simulated order; recorded in JSONL

### Next Steps
- Risk checks (tick/step rounding, leverage caps)
- Add read-only tools (ticker, orderbook, ohlcv)
- Implement live Aster private client with HMAC signing
- Tests for tools and risk logic

