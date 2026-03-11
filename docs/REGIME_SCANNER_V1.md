# Regime Scanner v1

Deterministic market regime layer for the Polymarket copilot. Classifies markets into regimes and exposes rule-based signals so the bot and recommendations can distinguish volatile range (buy-low/sell-high) opportunities from unsafe trend/news repricing.

## Data sources

- **Price / timing**: `SyncedMarket` (endDate, liquidityNum), `MarketPriceSnapshot` (price, volume, liquidity, capturedAt).
- **News / shock proxy**: `MarketNewsLink` (count by market, recent 7d), `MarketEventLink` (count with confidence ≥ 0.3).

All features are computed from existing data; no new ingestion.

## Features (see `lib/markets/regime/features.ts`)

| Feature | Description |
|--------|-------------|
| lastPrice | Last price (0–1) from latest snapshot or market raw |
| return1h / return6h / return24h | Returns over 1h, 6h, 24h from snapshots |
| rollingLow / rollingHigh | Min/max price over last 24h of snapshots |
| volatilityScore | 0–1 from snapshot std dev |
| trendScore | 0–1; 0.5 = flat, >0.5 = up, <0.5 = down |
| distanceFromRangeLow / distanceFromRangeHigh | 0–1 position in range; null if no range |
| spreadLiquidityQuality | 0–1 from market liquidityNum |
| hoursToResolution | Hours until market endDate |
| newsActivityCount | Count of MarketNewsLink (created last 7d) |
| newsShockProxy | Count of MarketEventLink with confidence ≥ 0.3 |

## Regime labels (see `lib/markets/regime/classifier.ts`)

- **RANGE_MEAN_REVERTING** – Volatility and range; suitable for mean reversion.
- **TRENDING_UP** / **TRENDING_DOWN** – Momentum; not range.
- **NEWS_SHOCK** – Event/news activity; repricing risk.
- **ILLIQUID_NOISY** – Low liquidity; price may be noisy.
- **NEAR_RESOLUTION_UNSAFE** – Resolves within 72h; unsafe for new mean-reversion.

Classification is threshold-based and explainable (see `explanation` on result).

## Rule-based signals (see `lib/markets/regime/signals.ts`)

- **meanReversionBuyCandidate** – Range regime and price near rolling low (distanceFromRangeLow < 0.35).
- **meanReversionSellCandidate** – Range regime and price near rolling high.
- **breakoutRisk** – Regime is TRENDING_UP, TRENDING_DOWN, or NEWS_SHOCK (unsafe for mean reversion).

## API

- **GET /api/markets/regime?marketId=...** or **?slug=...**  
  Returns `{ features, regime, signals }` for one market. Optional **?persist=1** to write a `MarketRegimeSnapshot` for evaluation/ML.

## Reuse

- **Bot dry-run**: **GET /api/bot/dry-run?regime=1** attaches per-candidate `regimeSnapshot: { regime, signals }` (by marketId).
- **Recommendation engine**: Call `runRegimeScan({ marketId })` and use `regime` / `signals` to filter or rank.
- **Backtests**: Persist snapshots with `?persist=1` or `persistRegimeSnapshot(result)`; query `MarketRegimeSnapshot` by time and regime.

## Persistence

`MarketRegimeSnapshot` stores one row per scan: marketId, assetId, regime, featuresJson, signalsJson, explanation, createdAt. Append-only; used for evaluation and future ML.

## No ML

All logic is deterministic and threshold-based. Thresholds are in code (classifier.ts, signals.ts) and can be moved to config later.
