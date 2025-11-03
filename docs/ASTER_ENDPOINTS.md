## Aster Futures API - Endpoints Catalog

Authoritative reference: Aster Futures API spec. Environment-configurable base:

- REST Base: `https://fapi.asterdex.com` (env: `ASTER_BASE_URL`)
- REST Path: `/fapi/v1` (env: `ASTER_BASE_PATH` unless otherwise noted)
- WS Base (market/user): `wss://fstream.asterdex.com`

Notes
- JSON responses; timestamps in ms.
- Security types: NONE, MARKET_DATA, USER_DATA (HMAC), TRADE (HMAC), USER_STREAM.

---

## Market Data (Public REST)

- GET `/fapi/v1/ping` — connectivity
- GET `/fapi/v1/time` — server time
- GET `/fapi/v1/exchangeInfo` — symbols, filters, rate limits
- GET `/fapi/v1/depth` — order book snapshot
- GET `/fapi/v1/trades` — recent trades
- GET `/fapi/v1/historicalTrades` (MARKET_DATA) — older trades
- GET `/fapi/v1/aggTrades` — aggregate trades
- GET `/fapi/v1/klines` — candlesticks
- GET `/fapi/v1/indexPriceKlines` — index price candles
- GET `/fapi/v1/markPriceKlines` — mark price candles
- GET `/fapi/v1/premiumIndex` — mark price + funding
- GET `/fapi/v1/fundingRate` — funding rate history
- GET `/fapi/v1/fundingInfo` — funding config per symbol
- GET `/fapi/v1/ticker/24hr` — 24h stats
- GET `/fapi/v1/ticker/price` — last price (single/all)
- GET `/fapi/v1/ticker/bookTicker` — best bid/ask (single/all)

## WebSocket Market Streams

- Subscribe via `wss://fstream.asterdex.com/ws/<stream>` or combined `.../stream?streams=a/b/c`
- Streams (lowercase symbols):
  - `<symbol>@aggTrade`
  - `<symbol>@markPrice` or `@markPrice@1s`; `!markPrice@arr` (all)
  - `<symbol>@kline_<interval>`
  - `<symbol>@miniTicker`; `!miniTicker@arr`
  - `<symbol>@ticker`; `!ticker@arr`
  - `<symbol>@bookTicker`; `!bookTicker`
  - `<symbol>@forceOrder`; `!forceOrder@arr`
  - `<symbol>@depth`, `@depth@500ms`, `@depth@100ms`, or partial depth `<symbol>@depth<levels>`
  - Admin methods on WS: `SUBSCRIBE`, `UNSUBSCRIBE`, `LIST_SUBSCRIPTIONS`, `SET_PROPERTY`, `GET_PROPERTY`

## Account / Trade (Private REST)

Position & Assets Modes
- POST `/fapi/v1/positionSide/dual` (TRADE) — change position mode
- GET  `/fapi/v1/positionSide/dual` (USER_DATA) — get position mode
- POST `/fapi/v1/multiAssetsMargin` (TRADE) — change multi-asset mode
- GET  `/fapi/v1/multiAssetsMargin` (USER_DATA) — get multi-asset mode

Orders
- POST   `/fapi/v1/order` (TRADE) — new order
- DELETE `/fapi/v1/order` (TRADE) — cancel order
- POST   `/fapi/v1/batchOrders` (TRADE) — place multiple orders
- DELETE `/fapi/v1/batchOrders` (TRADE) — cancel multiple orders
- POST   `/fapi/v1/countdownCancelAll` (TRADE) — auto-cancel all after countdown

Queries
- GET `/fapi/v1/order` (USER_DATA) — query order
- GET `/fapi/v1/openOrder` (USER_DATA) — query current open order
- GET `/fapi/v1/openOrders` (USER_DATA) — list current open orders (symbol/all)
- GET `/fapi/v1/allOrders` (USER_DATA) — all orders (history)
- GET `/fapi/v1/userTrades` (USER_DATA) — account trades

Transfers
- POST `/fapi/v1/asset/wallet/transfer` (USER_DATA) — futures/spot transfer

Account, Balance, Positions
- GET `/fapi/v2/balance` (USER_DATA) — balances v2
- GET `/fapi/v4/account` (USER_DATA) — account info v4
- GET `/fapi/v2/positionRisk` (USER_DATA) — position info v2
- GET `/fapi/v1/income` (USER_DATA) — income history
- GET `/fapi/v1/leverageBracket` (USER_DATA) — notional/leverage brackets (single/all)
- GET `/fapi/v1/adlQuantile` (USER_DATA) — position ADL quantile
- GET `/fapi/v1/forceOrders` (USER_DATA) — user force orders
- GET `/fapi/v1/commissionRate` (USER_DATA) — symbol commission rate

Account Configuration
- POST `/fapi/v1/leverage` (TRADE) — change initial leverage
- POST `/fapi/v1/marginType` (TRADE) — change margin type (CROSSED/ISOLATED)
- POST `/fapi/v1/positionMargin` (TRADE) — modify isolated position margin
- GET  `/fapi/v1/positionMargin/history` (TRADE) — margin change history

## User Data Streams

- REST (USER_STREAM):
  - POST `/fapi/v1/listenKey` — start/refresh (returns current key if active)
  - PUT  `/fapi/v1/listenKey` — keepalive
  - DELETE `/fapi/v1/listenKey` — close
- WS: `wss://fstream.asterdex.com/ws/<listenKey>` — account/order/position events

---

## Coverage in this repo (current)

Implemented (public):
- `/fapi/v1/exchangeInfo` → `PublicClient.getExchangeInfo`
- `/fapi/v1/ticker/price` → `PublicClient.getTicker`
- `/fapi/v1/depth` → `PublicClient.getOrderbook`
- `/fapi/v1/klines` → `PublicClient.getKlines`
- `/fapi/v1/leverageBracket` → `PublicClient.getLeverageBrackets`

Planned (private, signed):
- Order placement/cancel/query, account/balance/positions, user streams (see `src/http/privateClient.ts`).

---

## Appendix: Filters & Enums (see official spec)

- Symbol filters: `PRICE_FILTER`, `LOT_SIZE`, `MARKET_LOT_SIZE`, `MAX_NUM_ORDERS`, `MAX_NUM_ALGO_ORDERS`, `PERCENT_PRICE`, `MIN_NOTIONAL`.
- Common enums: order types (LIMIT, MARKET, STOP, STOP_MARKET, TAKE_PROFIT, TAKE_PROFIT_MARKET, TRAILING_STOP_MARKET), timeInForce (GTC, IOC, FOK, GTX, HIDDEN), workingType (MARK_PRICE, CONTRACT_PRICE), positionSide (BOTH, LONG, SHORT).



