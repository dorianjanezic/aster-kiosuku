# Aster Kiosuku - AI Crypto Pair Trading Agent

A sophisticated AI-powered statistical arbitrage system for cryptocurrency pair trading, implementing advanced quantitative strategies with real-time market analysis and automated trade execution.

## Overview

Aster Kiosuku is an intelligent trading agent that identifies and manages market-neutral cryptocurrency pairs using statistical arbitrage techniques. The system combines quantitative analysis, technical indicators, fundamental data, and social sentiment to make informed trading decisions.

### Key Capabilities

- **Statistical Arbitrage**: Identifies cointegrated pairs using correlation, ADF tests, and half-life calculations
- **Real-time Analysis**: Continuous market monitoring with Z-score spread analysis
- **AI Decision Making**: LLM-powered trade decisions with structured reasoning
- **Risk Management**: Automated position sizing, leverage management, and stop-loss mechanisms
- **Multi-source Data**: Technical indicators, fundamental data (CoinGecko), and social sentiment
- **Portfolio Optimization**: Market-neutral strategies with dynamic position management

## Architecture

### Core Components

```
├── Agent (orchestrator.ts)
│   ├── Decision Engine (LLM + structured schemas)
│   ├── Risk Management (position sizing, leverage)
│   └── Trade Execution (simulated/paper trading)
│
├── Data Pipeline
│   ├── Market Data (price feeds, order books)
│   ├── Technical Analysis (RSI, MACD, ADX, Bollinger Bands)
│   ├── Fundamental Data (CoinGecko API)
│   └── Social Sentiment (X/Twitter search)
│
├── Simulation Engine
│   ├── Order matching and execution
│   ├── Portfolio tracking
│   └── Performance analytics
│
└── Dashboard (Next.js)
    ├── Real-time portfolio view
    ├── Trade history and analytics
    └── Performance metrics
```

### Technology Stack

- **Backend**: Node.js, TypeScript
- **AI/ML**: Grok API (xAI) for decision making
- **Data Sources**: Aster DEX API, CoinGecko API
- **Technical Analysis**: `technicalindicators` library
- **Simulation**: Custom matching engine
- **Frontend**: Next.js, React, Tailwind CSS
- **Persistence**: JSONL logging, in-memory state

## Quick Start

### Prerequisites

- Node.js 18+
- npm/pnpm
- Git

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/aster-kiosuku.git
cd aster-kiosuku

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your API keys
```

### Environment Configuration

```env
# Required
ASTER_BASE_URL=https://fapi.asterdex.com
ASTER_BASE_PATH=/fapi/v1
GROK_API_KEY=your_grok_api_key_here

# Optional
PORTFOLIO_BASE_BALANCE=10000
NEXT_PUBLIC_DASHBOARD_BASE_URL=http://localhost:3000
```

### Running the System

```bash
# Start the dashboard (development)
pnpm run dev

# Start the trading agent
pnpm run agent

# Run tests
pnpm test

# Build for production
pnpm build
```

## Key Features

### Quantitative Analysis

- **Cointegration Testing**: ADF test on log-price spreads
- **Correlation Analysis**: Rolling correlation calculations
- **Spread Analysis**: Z-score normalization with dynamic thresholds
- **Half-Life Estimation**: Mean-reversion speed calculation

### AI Decision Engine

- **Structured Reasoning**: JSON schema-based decision making
- **Multi-factor Analysis**: Technical, fundamental, and sentiment integration
- **Risk Assessment**: Dynamic leverage and position sizing
- **Exit Strategies**: Profit targets, time stops, and convergence triggers

### Data Integration

- **Real-time Prices**: Live market data from Aster DEX
- **Technical Indicators**: RSI, MACD, Bollinger Bands, ADX
- **Fundamental Data**: Market cap, volume, supply metrics from CoinGecko
- **Social Sentiment**: X/Twitter sentiment analysis

### Risk Management

- **Position Limits**: Maximum 10 pairs (20 positions)
- **Margin Requirements**: Minimum $500 per position
- **Leverage Scaling**: 1x-5x based on pair quality
- **Stop Losses**: Dynamic risk management
- **Portfolio Neutrality**: Beta-adjusted hedging

## Configuration

### Trading Parameters

```typescript
// Statistical thresholds
CORRELATION_THRESHOLD = 0.7
ADF_SIGNIFICANCE = -1.645  // 90% confidence
MAX_HALF_LIFE = 40
SPREAD_Z_THRESHOLD = 0.8

// Position management
MAX_PAIRS = 10
MIN_MARGIN_PER_POSITION = 500
MAX_MARGIN_PER_POSITION = 1000
LEVERAGE_RANGE = [1, 5]
```

### Decision Weights

- **Quantitative Stats**: 20% (correlation, cointegration, spread)
- **Technical Analysis**: 30% (RSI, volume, regime)
- **Fundamental Data**: 10% (market cap, volume, ranking)
- **Social Sentiment**: 40% (X posts, news, web search)

## Usage Examples

### Starting a New Pair

```json
{
  "summary": "Strong statistical pair identified with positive fundamentals",
  "mode": "PAIR",
  "pair": {
    "long": "ADAUSDT",
    "short": "NEARUSDT",
    "corr": 0.83,
    "beta": 1.034,
    "spreadZ": -1.47,
    "halfLife": 11.2
  },
  "signal": "ENTER",
  "sizing": {
    "longSizeUsd": 3000,
    "shortSizeUsd": 3100,
    "leverage": 3
  },
  "risk": {
    "long": {"stopLoss": -5, "takeProfit": 10, "leverage": 3},
    "short": {"stopLoss": 5, "takeProfit": -10, "leverage": 3}
  },
  "rationale": [
    "Correlation 0.83 meets threshold",
    "ADF t-stat -7.28 indicates cointegration",
    "Both projects in top 50 by market cap",
    "Positive social sentiment on X"
  ]
}
```

### Monitoring Active Pairs

The agent continuously monitors:
- Spread convergence (profit targets)
- Time-based exits (half-life limits)
- Risk reduction triggers
- Social sentiment changes

## API Endpoints

### Portfolio Data
- `GET /api/portfolio` - Current portfolio state
- `GET /api/pairs` - Available trading pairs
- `GET /api/cycles` - Agent decision history

### Market Data
- `GET /api/markets` - Tradable markets
- `GET /api/technicals` - Technical indicators

## Development

### Project Structure

```
├── apps/dashboard/          # Next.js frontend
├── src/
│   ├── agent/               # AI orchestrator
│   │   ├── orchestrator.ts  # Main agent logic
│   │   └── decisionSchema.ts # LLM response schemas
│   ├── llm/                 # Language model integration
│   │   └── tools.ts         # Available functions
│   ├── services/            # External services
│   ├── strategies/          # Trading strategies
│   ├── sim/                 # Simulation engine
│   └── types/               # TypeScript definitions
├── sim_data/                # Simulation data/logs
└── scripts/                 # Utility scripts
```

### Testing

```bash
# Unit tests
pnpm test:unit

# Integration tests
pnpm test:integration

# E2E tests
pnpm test:e2e
```

### Code Quality

```bash
# Lint code
pnpm lint

# Format code
pnpm format

# Type checking
pnpm type-check

# Pre-commit hooks
pnpm pre-commit
```

## Research & Methodology

### Statistical Framework

- **Stationarity Testing**: Augmented Dickey-Fuller tests
- **Cointegration**: Engle-Granger methodology
- **Spread Calculation**: Log-price differences with OLS hedging
- **Z-Score Normalization**: Rolling standard deviation

### Technical Analysis

- **RSI Divergence**: Momentum analysis across pairs
- **Volume Confirmation**: Trade validation with volume trends
- **ADX Regime Detection**: Trending vs ranging market identification
- **Bollinger Bands**: Volatility-based entry/exit signals

### Risk Metrics

- **Value at Risk (VaR)**: Portfolio-level risk assessment
- **Maximum Drawdown**: Peak-to-trough analysis
- **Sharpe Ratio**: Risk-adjusted returns
- **Calmar Ratio**: Drawdown-adjusted performance

## Contributing

### Development Workflow

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Guidelines

- Follow TypeScript strict mode
- Add tests for new features
- Update documentation
- Use conventional commits
- Run pre-commit hooks

### Areas for Contribution

- **New Strategies**: Additional pair selection algorithms
- **Risk Models**: Enhanced portfolio optimization
- **Data Sources**: Integration with more exchanges/protocols
- **ML Models**: Predictive analytics for spread movements
- **UI/UX**: Dashboard improvements and visualizations

## Next Steps

### Configuration Enhancements
- **Dynamic Risk Parameters**: Runtime adjustment of correlation thresholds, leverage limits, and position sizes
- **Strategy Profiles**: Pre-configured trading profiles (conservative, aggressive, balanced)
- **Market Condition Adaptation**: Automatic parameter tuning based on volatility regimes
- **Custom Indicators**: User-defined technical indicators and scoring functions

### User Interface & Experience
- **Wallet Integration**: Connect external wallets for real trading (MetaMask, WalletConnect)
- **Agent Chat Interface**: Direct conversation with the AI agent for strategy questions and explanations
- **Real-time Alerts**: Push notifications for trade signals and portfolio updates
- **Advanced Analytics**: Interactive charts, backtesting visualization, and performance attribution

### Trading Features
- **Additional Strategies**: Momentum, mean-reversion, and custom algorithmic strategies beyond pair trading
- **Multi-exchange Support**: Simultaneous trading across multiple DEXs and CEXs
- **Cross-pair Arbitrage**: Triangular arbitrage and multi-asset strategies
- **Options Integration**: DeFi options for volatility hedging and yield enhancement
- **Portfolio Rebalancing**: Automated rebalancing based on target allocations

### Risk Management
- **Advanced Risk Metrics**: Real-time VaR, CVaR, and stress testing
- **Portfolio Optimization**: Mean-variance optimization and risk parity strategies
- **Liquidity Monitoring**: Automatic position reduction during low liquidity periods
- **Circuit Breakers**: Emergency stop mechanisms for extreme market conditions

### Data & Analytics
- **Enhanced Sentiment Analysis**: NLP processing of social media and news feeds
- **On-chain Analytics**: Smart contract interaction data and whale wallet monitoring
- **Market Microstructure**: Order book depth analysis and slippage modeling
- **Performance Attribution**: Factor analysis of returns (momentum, value, size effects)

### Infrastructure
- **Cloud Deployment**: Docker containers and Kubernetes orchestration
- **Database Integration**: Time-series databases for historical data storage
- **API Rate Limiting**: Intelligent request throttling and caching strategies
- **Monitoring & Logging**: Comprehensive observability with ELK stack integration


## Disclaimer

This software is for educational and research purposes only. It is not financial advice and should not be used for actual trading without thorough testing and risk assessment. Cryptocurrency trading involves significant risk of loss.

## Acknowledgments

- **xAI** for Grok API access
- **Aster DEX** for market data
- **CoinGecko** for fundamental data
- **Technical Indicators** library for analysis tools

---

Built for the decentralized and open-source future
