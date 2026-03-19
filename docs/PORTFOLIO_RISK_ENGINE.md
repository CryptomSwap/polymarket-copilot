# Portfolio Risk Engine

## Purpose

The portfolio risk engine turns raw portfolio state (positions, working orders) into a **deterministic, explainable, conservative** risk snapshot. It does not use black-box scoring or fake precision (e.g. no VaR/covariance math). It is used by:

- **Decision recompute** – to feed structured risk (total exposure, theme/market concentration) into blend and policy.
- **Execution policy** – to block or warn when total exposure or single-market/single-theme concentration exceeds limits.
- **Guardrails / API / UI** – to expose key risk metrics and flags for operator oversight.

## States and outputs

The engine has no internal state machine; it is **stateless**. Given a `PortfolioRiskInput`, it returns a `PortfolioRiskSnapshot` with:

- **Exposure**: gross, net, total open, total working order, total at-risk.
- **Concentration**: by market, by theme, by cluster (theme or theme+category), with max concentration % and ordered breakdown rows.
- **Estimates**: correlated exposure (heuristic), worst-case loss (conservative), near-resolution exposure, illiquid exposure (when liquidity context exists).
- **Flags**: concentration breaches, risk flags, warnings, and a JSON snapshot for audit.

## Metrics and assumptions

### Gross / net / open exposure

- **Gross exposure**: Sum of `|marketValue|` over all positions. Same as total open exposure when all positions are long; shorts contribute as absolute notional.
- **Net exposure**: Sum of signed notionals (LONG = +marketValue, SHORT = -marketValue). Single-funder view; multi-funder would require per-funder aggregation.
- **Total working order exposure**: Sum of `size * price` over working orders. Represented separately so callers can enforce limits or display “at risk” (open + working).

### Single-market concentration

- Exposure is summed by `marketId`. Each row has exposure, concentration % (of total open exposure), and position count.
- **Max single-market concentration %**: Largest market’s share of total open exposure. Used with a limit (e.g. from runtime risk limits) to block or warn.

### Single-theme concentration

- Exposure is summed by `theme` (default `"Other"` when missing). Same structure as market.
- **Max single-theme concentration %**: Largest theme’s share of total open exposure.

### Event-cluster concentration

- A **conservative heuristic** clusters positions by a configurable key:
  - `theme` – same theme.
  - `theme_category` – same theme and category (e.g. `Politics::Elections`).
- **Event cluster exposure**: Exposure of the single largest cluster. Used to gauge “narrative” or correlated risk without covariance.

### Correlated exposure estimate

- **Heuristic, not covariance.** When the top cluster is ≥30% of portfolio, the estimate is the sum of the top two clusters’ exposure; otherwise it is total open exposure. This highlights “same theme/category” concentration as a proxy for correlated risk. Methodology is documented in code and in this doc; no hidden weighting.

### Worst-case loss estimate

- **Conservative**: Sum of `|marketValue|` over all positions. Assumption: positions can go to zero (e.g. binary markets). We do not subtract hedges or add option-style complexity.

### Near-resolution risk

- Positions with `endDate` within a configurable number of hours (e.g. 72) are “near resolution.” Their exposure is summed as **near-resolution exposure**.
- A **risk flag** is added when near-resolution exposure is ≥20% of total open exposure, so operators can see concentration in soon-to-resolve markets.

### Illiquidity risk

- When a position has `illiquid: true`, its exposure is counted in **illiquid exposure estimate**.
- If no position has any liquidity context, **liquidity context missing** is set and a warning is added; we do not invent an illiquid number.

## What is measured vs estimated

| Metric | Measured | Estimated | Notes |
|--------|----------|-----------|--------|
| Gross / net / total open | ✓ | | From position inputs. |
| Working order exposure | ✓ | | From working order inputs. |
| Market / theme concentration % | ✓ | | From same inputs; deterministic. |
| Cluster concentration | ✓ | | Heuristic key (theme or theme+category). |
| Correlated exposure | | ✓ | Heuristic: top 2 clusters when top ≥30%. |
| Worst-case loss | | ✓ | Conservative: sum of notionals. |
| Near-resolution exposure | ✓ | | From `endDate` and threshold. |
| Illiquid exposure | ✓ | | Only when `illiquid` is provided. |

## How decision logic uses it

- **Decision recompute** builds `PortfolioRiskInput` from `DerivedPosition` rows (and optional reserved order value), calls `calculatePortfolioRisk`, then:
  - Uses `totalOpenExposure` and `maxSingleThemeConcentrationPct` for blend and policy.
  - Builds a theme → exposure map from `themeConcentrations` for per-recommendation `themeExposurePct`.
- The snapshot is also stored in memory via `setPortfolioRiskSnapshot` so the execution policy (e.g. in the worker) can read it when evaluating an order.

## How execution policy uses it

- The execution policy receives exposure/concentration from the caller (e.g. worker). When a **portfolio risk snapshot** is available (e.g. from the in-memory store updated by decision recompute or guardrails):
  - **Total exposure**: Compared to `maxTotalExposure`; breach blocks.
  - **Single-market concentration**: `currentSingleMarketConcentrationPct` vs `maxSingleMarketConcentrationPct`; breach blocks.
  - **Single-theme concentration**: `currentSingleThemeConcentrationPct` vs `maxSingleThemeConcentrationPct`; breach blocks.
- Limits (e.g. `maxSingleMarketConcentrationPct`) come from runtime risk limits (e.g. `perMarketNotionalLimitPct * 100`). Policy logic is explicit and fail-closed.

## How operators should interpret it

- **totalOpenExposure / totalWorkingOrderExposure**: Current and “pending” notional; compare to internal or policy limits.
- **maxSingleMarketConcentrationPct / maxSingleThemeConcentrationPct**: Largest market/theme share; high values mean concentration risk.
- **concentrationFlags / riskFlags**: Explain breaches (e.g. market or theme over limit, total exposure over limit, large near-resolution share). Act on “block” severity.
- **warnings**: E.g. missing liquidity context; do not treat as hard blocks but improve data or processes where possible.
- **worstCaseLossEstimate**: Conservative “all positions to zero” loss; use for sizing and stress-style awareness, not exact PnL.
- **nearResolutionExposure**: Notional in markets that resolve soon; high share may warrant reducing size or hedging.

## Constraints

- **Deterministic**: Same input ⇒ same snapshot.
- **Conservative**: Missing or ambiguous data does not inflate safety (e.g. we warn on missing liquidity context; we do not fake illiquid exposure).
- **Explainable**: All flags and warnings have explicit reasons; methodology is documented.
- **Paper-trading only**: No live trading enablement; the engine only informs decisions and guardrails.
