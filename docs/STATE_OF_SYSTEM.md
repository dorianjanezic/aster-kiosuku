## Kiosuku Agent - Current System State (Oct 2025)

### Overview
- Closed-loop trading agent focused on pair trading (market-neutral long/short) on Aster Futures.
- Simulation-first: executes paper trades with identical interfaces to future live mode.
- Loop interval: 5 minutes. Persists snapshots and decisions to JSONL for audit.

### Architecture
- Orchestrator (`src/agent/orchestrator.ts`):
  - Refreshes market buckets and builds pair candidates.
  - Constructs prompts and requests a structured JSON decision (PAIR or SINGLE).
  - Executes simulated orders and records results.
- PriceMonitorService (`src/services/priceMonitorService.ts`):
  - WebSocket market streams for best bid/ask, last, mid. 5s-throttled.
  - Feeds `SimulatedExchange` mids for accurate PnL and fills.
- Execution Provider (`src/execution/provider.ts`):
  - `paper` via `SimulatedExchange`; `live` stubbed.
- SimulatedExchange (`src/sim/simulatedExchange.ts`):
  - Tracks books (mid/spread), orders, and positions; auto-upserts books for unseen symbols.
  - MARKET orders fill at mid; LIMIT cross logic.
- StateService (`src/services/stateService.ts`):
  - Builds account snapshot: balance, equity, unrealizedPnL, marginUsed, availableMargin, openPositionsCount.
- Markets/Meta
  - `fetchMarkets.ts` consolidates exchange info → `sim_data/markets.json`.
  - `computeBuckets.ts` + `lib/buckets.ts` compute LiquidityTier, VolatilityBucket, FundingProfile, Majors.
  - Categories enriched via CMC + local maps.

### Strategy: Pair Trading
- `src/strategies/pairs/pairTrading.ts` builds candidates:
  - Features: returns, volatility, funding, z-scores per sector, outlier ranking.
  - Filters: sector consistency, correlation, liquidity, funding sanity.
- Enrichment: correlation and beta from klines; spot reference prices (mid/last/best bid/ask).
- Persistence: `sim_data/pairs.json` and cycle snapshots (`pairs_snapshot`).

### Prompts
- System (`src/prompts/system.ts`):
  - Pair-trading personality. Requires JSON output with PAIR or SINGLE.
  - Enforces absolute TP/SL (no multipliers). Directional correctness per leg.
- User (`src/prompts/user.ts`):
  - Provides portfolio/account status, open positions, and compact `<pairs>` candidates.

### Decision and Execution Flow
1. Orchestrator updates buckets and builds pairs; enriches corr/beta/prices.
2. Sends system + user prompts to LLM (Grok/Gemini via `provider.ts`) requesting structured JSON.
3. Parses decision and logs `assistant_raw` and `decision` to `cycles.jsonl`.
4. PAIR ENTER:
   - Records `order_plan` with normalized absolute TP/SL.
   - Computes quantities from `sizeUsd` and per-leg mid; places two MARKET orders.
   - Logs orders to `sim_data/orders.jsonl`.
5. SINGLE mode (fallback) places one order; flip-flop prevention on conflicting positions.

### Data and Persistence
- `sim_data/cycles.jsonl`: cycle snapshots, user/assistant raw, decisions.
- `sim_data/orders.jsonl`: order plans and order executions.
- `sim_data/markets.json`: markets, categories, computed buckets/metrics.
- `sim_data/pairs.json`: top pairs with corr/beta and price refs.

### LLM Provider
- `src/llm/provider.ts`: Env-switchable; defaults to Grok (GROK_API_KEY). Tools disabled for now; single call with JSON schema response.

### Risk and Normalization
- `src/lib/risk.ts` and `src/lib/format.ts`: tick/step rounding, leverage checks (used in tool handler path).
- TP/SL normalization: if model returns multipliers (<2), convert to absolute using mid/last before recording plan.

### CLI Scripts (package.json)
- `pnpm fetch:markets` → build `sim_data/markets.json`.
- `pnpm compute:buckets` → compute dynamic buckets and bake into markets.
- `pnpm pairs:scan` → write `sim_data/pairs.json` offline.
- `pnpm start` → run app (loop + orchestrator).

### Configuration (env)
- Core: ASTER_BASE_URL, ASTER_BASE_PATH, ASTER_WS_URL, LOOP_INTERVAL_MS, MODE, DEBUG.
- LLM: LLM_PROVIDER, LLM_MODEL, GROK_API_KEY, GROK_API_URL.
- Buckets: BUCKETS_*.
- Pairs: PAIRS_PER_SECTOR, PAIRS_MIN_CORR, PAIRS_INTERVAL, PAIRS_LIMIT.

### Current Limitations / Next Steps
- Live trading stubbed; implement private client signing and LiveExecutionProvider.
- Cointegration checks are approximated; add robust ADF testing.
- Improve funding/volatility features and regime detection.
- Expand risk engine to manage TP/SL adjustments and exits in-loop.
- Strengthen tests (Jest + RTL where applicable) and CI (eslint as errors, pnpm audit).
