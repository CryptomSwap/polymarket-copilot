# Strategy Simulator / Backtest v1

Deterministic mean-reversion strategy backtest over historical price snapshots. No connection to live execution. Used to test strategy behavior before using it in bot policy or ML.

## Data source

- **MarketPriceSnapshot**: single replay source. Load all rows in `[startDate, endDate]` (and optional `marketIds`), ordered by `capturedAt`.
- **SyncedMarket**: used for `endDate` and `liquidityNum` per market (hours-to-resolution and liquidity fallback).

## Strategy: mean-reversion

### Entry (all must hold)

- Regime = **RANGE_MEAN_REVERTING** (from rolling features; same thresholds as regime scanner).
- **Near lower band**: `distanceFromRangeLow < entryNearLowThreshold` (default 0.35).
- **Liquidity**: `spreadLiquidityQuality >= minLiquidity` (default 0.15).
- **Not near resolution**: `hoursToResolution >= nearResolutionHours` (default 72), or null.
- No news-shock blocker (in backtest, news activity is not available; treated as 0).

### Exit (first that applies)

- **Near upper band**: `distanceFromRangeHigh < exitNearHighThreshold` (default 0.35).
- **Target profit**: `(price - entryPrice) / entryPrice >= targetProfitPct` (default 10%).
- **Regime change**: regime no longer RANGE_MEAN_REVERTING.
- **Near resolution**: `hoursToResolution < nearResolutionHours`.
- **Max hold**: hold time >= `maxHoldHours` (default 168 = 7 days).

## Rolling features

At each snapshot time `t`, features are computed from snapshots in `[t - rollingWindowHours, t]` (default 24h). Same logic as `lib/markets/regime/features.ts`: returns, rolling low/high, volatility, trend, distance from range, liquidity from snapshot (or market fallback), hours to resolution from market `endDate`. Regime is classified with the same thresholds as the regime scanner (no news in backtest).

## Output metrics

- **totalTrades**, **winCount**, **lossCount**, **winRate**
- **averageWinPct**, **averageLossPct**, **expectancyPct** (average PnL per trade)
- **drawdownProxyPct** (max peak-to-trough of cumulative PnL)
- **averageHoldHours**
- **blockedByReason**: counts of entry attempts blocked by each rule (e.g. `regime_not_range`, `not_near_low`, `low_liquidity`, `near_resolution`)

## API

- **POST /api/backtest/mean-reversion**  
  Body: `{ startDate, endDate, marketIds?, targetProfitPct?, maxHoldHours?, minLiquidity?, nearResolutionHours?, rollingWindowHours?, entryNearLowThreshold?, exitNearHighThreshold? }`  
  Returns: `{ config, trades, metrics, runAt }`. No side effects.

## UI

- **Bot Command Center** (`/bot`): "Strategy backtest" card. Set date range, run backtest, view metrics and blocked reasons; optional trades table.

## Reuse

- **Policy**: Entry/exit thresholds align with regime scanner and bot policy (near-resolution, liquidity). Config can be tuned to match live guardrails.
- **ML**: Backtest results (trades, metrics, blocked reasons) can inform feature selection and labeling for future models.
- **No live execution**: Simulator only reads snapshots and writes no orders.
