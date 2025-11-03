## Tools Overview

Exposed tool schemas (simulation-first):

- get_markets(): consolidated markets from exchangeInfo + tickers + leverage
- get_ticker({ symbol })
- get_orderbook({ symbol, limit? })
- get_ohlcv({ symbol, interval, limit? })
- get_open_orders()
- get_account_state()
- get_positions()
- place_order({ symbol, side, type, quantity, price?, timeInForce?, reduceOnly?, clientOrderId?, leverage? })

All inputs/outputs are validated (Zod). place_order is normalized to tick/step and enforces leverage caps via markets.json.

