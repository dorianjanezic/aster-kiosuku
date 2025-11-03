# Pair Trading: Current Implementation

## Overview
- Goal: Market-neutral long/short within same category (sector/ecosystem/type), favoring strong mean reversion (low half-life) and high correlation.
- Flow: Fetch markets → compute categories/buckets/metrics → build pair candidates → orchestrator selects and executes (sim) → monitor deltas and active pair performance.

## Markets, Categories, and Buckets
1) Consolidation
- File: `src/lib/consolidateMarkets.ts`
- Combines exchange info, tickers, leverage brackets into `sim_data/markets.json`.

2) Category hydration
- Files: `src/lib/buckets.ts`, `src/cli/enrichCategories.ts`
- Local and user mappings: `src/data/assetCategories.json`, `src/data/userAssetCategories.json`.
- Normalization: `1000`-prefixed bases (SHIB, FLOKI, BONK, PEPE, CHEEMS) normalized to underlying base for lookup.

3) Metrics and computed buckets (update cycle)
- File: `src/lib/buckets.ts`
- For each symbol (parallelized):
  - 24h quoteVolume approximation via 1h klines (if missing)
  - Orderbook depth 5 (qty and notional)
  - ATR%14 from mark/price klines
  - Funding mean/variance from recent funding rate history
- Liquidity score: `log10(1+quoteVolume) + log10(1+notionalDepth)`
- Liquidity tier by percentile: top 20% → T1; next 40% → T2; rest → T3
- Volatility bucket: ATR% < 1 Low; < 3 Med; else High
- Funding profile: MeanRevert/Trending/Neutral via mean/variance thresholds
- Writes back to `sim_data/markets.json` with `categories.computed` and `categories.metrics`.

## Building Pair Candidates
- File: `src/strategies/pairs/pairTrading.ts`
- Grouping: by `sector`, `ecosystem`, `type` (Unknown fallback)
- Tradable filter: T1/T2 and `USDT` quote
- Data fetch per symbol:
  - OHLC klines (interval/env: `PAIRS_INTERVAL`, default 1h)
  - Technicals: RSI (from `src/tech/indicators.ts`)
- Scoring features (z-scored across group):
  - LiquidityScore (higher better)
  - ATR%14 (lower better)
  - FundingMean (closer to 0 better)
  - QuoteVolume (lower better for score to avoid over-crowding)
  - RSI (prefer long RSI < 30, short RSI > 70; fallback to score-only)
- Composite score weights (env tunable):
  - W1 liq (default 0.4)
  - W2 vol (0.3)
  - W3 funding (0.2)
  - W4 quoteVolume (0.1, subtracted)
  - W5 RSI (0.2, subtracted)
- Candidate formation (top vs bottom buckets with RSI gates and fallbacks)
- Statistical tests:
  - Correlation on returns; require `corr >= PAIRS_MIN_CORR` (default 0.6)
  - Hedge ratio via OLS on log prices
  - Spread, spread Z-score
  - ADF-style t-stat surrogate; compute half-life; require stationarity and half-life thresholds:
    - Strict: halfLife ≤ 3d; |spreadZ| ≥ 1.2
    - Fallback once per group: halfLife ≤ 5d; |spreadZ| ≥ 1.0
- Output: array of `{ long, short, corr, beta, hedgeRatio, cointegration{halfLife, adfT}, spreadZ, fundingNet, scores, notes }`
- De-duplication across groups; writes `sim_data/pairs_raw.json` and returns pruned list; orchestrator re-writes `sim_data/pairs.json` snapshot.

## Orchestration and Agent Behavior
- File: `src/agent/orchestrator.ts`
- Loop steps each cycle:
  1) Refresh buckets/metrics (`updateMarketsBuckets`)
  2) Build pair candidates (limit 10)
  3) Enrich pairs with corr/beta over a second time window and with mid/last prices
  4) Persist `pairs_snapshot` to ledger and `sim_data/pairs.json`
  5) Build `activePairs` from open positions with:
     - `pnlUsd` (sum of legs), `spreadZ`, `halfLife`
     - Baseline deltas via `sim_data/pairs_state.json`: `entrySpreadZ`, `deltaSpreadZ`, `entryTime`, `elapsedMs`
  6) Construct prompts and request structured decision (PAIR: ENTER/EXIT/NONE)
  7) On ENTER: place MARKET orders (sim) for both legs; persist baseline (`pairs_state.json`)
  8) On EXIT: submit reduce-only MARKET closes for both legs, compute realized PnL via simulator, log `pair_exit`, and clear baseline

## Simulator (Paper Execution)
- File: `src/sim/simulatedExchange.ts`
- Maintains orderbook mids; supports MARKET/LIMIT; creates positions on fill
- Reduce-only MARKET supported (does not open new positions)
- `closePosition(symbol)` computes realized PnL at current mid and removes position
- PnL mark-to-market each cycle using mids from `PriceMonitorService`

## Prompts
- System: `src/prompts/system.ts`
  - Prioritizes T1/T2, corr ≥ 0.8 (fallback ≥ 0.6), |spreadZ| > 1.1 (fallback > 1.0), halfLife ≤ 3d (fallback ≤ 5d), low |fundingNet|
  - Sizing: long 20% available margin; short = long * beta
  - Risk: TP/SL using ATR-based bands; leverage ≤ min(maxLeverage, 10)
  - Exit: |spreadZ| < 0.5; hold > 2*halfLife; stationarity loss; large drawdown
  - Active monitoring: uses `activePairs` deltas (`deltaSpreadZ`, `elapsedMs`) for decisions
- User: `src/prompts/user.ts`
  - Structured state with sectors/ecosystems/types and `activePairs`
  - Output schema allows ENTER/EXIT/NONE and optional `pair.spreadZ/halfLife`

## Files Written
- Markets: `sim_data/markets.json`
- Pair snapshots: `sim_data/pairs.json`, ledger entries `pairs_snapshot`
- Pair baselines: `sim_data/pairs_state.json` (entrySpreadZ, entryTime, entryHalfLife)
- Orders (JSONL): `sim_data/orders.jsonl` (order_plan, order, pair_exit)
- Cycles (JSONL): `sim_data/cycles.jsonl` (account, positions, recent)

## Env Vars (Selected)
- PAIRS_INTERVAL, PAIRS_LIMIT, PAIRS_PER_SECTOR
- PAIRS_W_LIQ, PAIRS_W_VOL, PAIRS_W_FUND, PAIRS_W_QV, PAIRS_W_RSI
- PAIRS_MIN_CORR, PAIRS_ADF_WINDOW, PAIRS_MAX_HALFLIFE_DAYS, PAIRS_FALLBACK_MAX_HALFLIFE_DAYS, PAIRS_MIN_SPREADZ, PAIRS_FALLBACK_MIN_SPREADZ
- ASTER_BASE_URL, ASTER_BASE_PATH, ASTER_WS_URL, ASTER_WS_MODE, ASTER_WS_PATH, ASTER_WS_STREAMS

## Next Enhancements
- Realized PnL attribution per leg; true cash balance updates
- Persist MAE/MFE per active pair and expose in prompt
- Live execution provider (signed)
- Backtesting harness and parameter sweeps
