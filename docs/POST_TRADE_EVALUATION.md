# Post-Trade Evaluation

## Purpose

Post-trade evaluation takes **shadow candidates** (recorded at decision time) and, after a time horizon has passed, computes **markouts** (forward returns) and an **outcome classification**. This lets operators see whether blocked trades would have helped or hurt, and whether allowed trades were favorable or unfavorable.

## How Outcomes Are Computed

1. **Eligible candidates**: Rows in `ShadowCandidate` with `evaluatedAt` null and `createdAt` older than the required horizon (default 25h so that 24h of data is available).
2. **Decision-time price**: From `MarketPriceSnapshot` at or just before `createdAt` for that asset/market; if missing, `intendedPrice` is used as fallback. If no price is available, the row is marked evaluated with note `no_decision_price` and no markout.
3. **Horizon prices**: Prices at `createdAt + 1h`, `+ 6h`, `+ 24h` from `MarketPriceSnapshot` (latest snapshot at or before that time).
4. **Markout** (per horizon):
   - **BUY**: `(priceLater - price0) / price0`. Positive = price went up (favorable).
   - **SELL**: `(price0 - priceLater) / price0`. Positive = price went down after sell (favorable).
5. **Classification** (using 24h markout when available):
   - **good_block**: Blocked and the trade would have been unfavorable (we avoided a bad trade).
   - **bad_block**: Blocked and the trade would have been favorable (missed opportunity).
   - **good_allow**: Allowed and the trade would have been favorable.
   - **bad_allow**: Allowed and the trade would have been unfavorable.

Classification is only set when we have a valid 24h markout; otherwise it stays null and notes can indicate partial data.

## Horizon Assumptions

- **1h / 6h / 24h**: Fixed horizons from decision time. Evaluation runs only for candidates older than 25h so that 24h post-decision data can exist.
- Prices come from **MarketPriceSnapshot**. If snapshots are not captured for that asset/market at the right times, markouts are null and we do not invent data.
- No extrapolation or smoothing; one snapshot per horizon (latest at or before the target time).

## Good Block / Bad Block / Good Allow / Bad Allow Logic

| Classification | Meaning |
|----------------|--------|
| **good_block** | We blocked this trade; in hindsight price moved against the trade (e.g. BUY and price fell). Block was beneficial. |
| **bad_block** | We blocked this trade; in hindsight price moved in favor of the trade (e.g. BUY and price rose). Missed opportunity. |
| **good_allow** | We allowed this trade; in hindsight price moved in favor (e.g. BUY and price rose). Good decision to allow. |
| **bad_allow** | We allowed this trade; in hindsight price moved against (e.g. BUY and price fell). Allowing was harmful in hindsight. |

“Favorable” is defined as **markout > 0** (for both BUY and SELL, given how markout is signed).

## Limitations and Operator Interpretation

- **Price source**: Only as good as `MarketPriceSnapshot` coverage. Thin or missing snapshots lead to null markouts or `no_decision_price` / `partial_price_data` notes.
- **Single price per horizon**: We use one snapshot per time point; no volume-weighted or mid-point logic.
- **No transaction costs or slippage**: Markout is purely price return. Real execution would have spread/slippage.
- **Paper vs live**: Allowed candidates are paper submissions; real execution could differ.
- **Causal interpretation**: Classification is descriptive (what happened to price after decision), not a claim that the block/allow “caused” the outcome.

Operators should use these metrics to:
- Tune policy/guardrails (e.g. many bad_blocks might suggest over-blocking).
- Review decision quality and execution quality assumptions.
- Spot patterns (e.g. certain blocking reasons correlating with good_block vs bad_block).

## Triggering Evaluation

- **Scheduled job**: `shadow_evaluation` runs on an interval (e.g. every 6h) and evaluates up to a limit of unevaluated candidates older than the horizon.
- **Manual**: `POST /api/ops/shadow-evaluation` with optional `minAgeMs` and `limit` in the body.
- **Summary and sample**: `GET /api/ops/shadow-evaluation` returns aggregate counts, good_block/bad_block/good_allow/bad_allow, average markouts, and a recent sample of rows.
