# Shadow Threshold Calibration

## What the Analysis Does

The shadow threshold calibration layer uses **shadow candidates** (recorded at decision time) and their **post-trade outcomes** (good_block, bad_block, good_allow, bad_allow) to produce **descriptive** summaries and calibration suggestions. It does **not** change any thresholds automatically. It answers:

- Which gates blocked trades and how often?
- Of those blocks, how many were beneficial (good_block) vs missed opportunities (bad_block)?
- Of allowed trades, how many were favorable (good_allow) vs unfavorable (bad_allow)?
- Which blocking reasons look too strict (high bad_block rate) or well-calibrated (high good_block rate)?
- Do warning-only (allowed-with-warnings) trades perform differently from clean allows?

Outputs are **operator-readable reports and API payloads** plus optional **suggestions** (review_threshold, keep_strict, insufficient_data, monitor). No parameter mutation is performed.

## How Reason Grouping Works

Raw blocking reasons come from guardrails, execution policy, and execution quality. They are **normalized into groups** so that similar reasons can be aggregated. Raw reasons are **preserved** in samples; grouping is deterministic and explicit.

| Group | Examples of raw reasons that map here |
|-------|--------------------------------------|
| **execution_quality** | `execution_quality:*`, `quote_stale`, `spread_too_wide`, `insufficient_depth`, `crossed_book`, `estimated_slippage_high`, etc. |
| **execution_policy_freshness** | `freshness:*` |
| **execution_policy_exposure** | `exposure:*` (concentration, limits) |
| **execution_policy_liquidity** | `liquidity:*` (includes execution_quality sub-reasons when surfaced via policy) |
| **execution_policy_pricing** | `pricing:*` |
| **execution_policy_operational** | `operational:*` |
| **execution_policy_recommendation** | `recommendation:*` |
| **guardrail_freshness** | `market_data_stale`, `user_data_stale`, `reconciliation_stale`, `runtime_rebuilding`, `exchange_truth_*` |
| **guardrail_liquidity** | `liquidity_below_threshold`, `spread_below_threshold`, `not_tradable` |
| **guardrail_exposure** | `exposure_total_breach`, `working_orders_breach`, `inventory_per_asset_breach` |
| **guardrail_operational** | `kill_switch_*`, `exchange_unhealthy`, `asset_execution_frozen`, etc. |
| **guardrail_market_health** | `market_stale`, `market_degraded`, `position_*` |
| **other** | Anything that does not match the above |

The mapping is implemented in `lib/shadow-analysis/reasons.ts` and is **deterministic**: the same raw string always maps to the same group.

## What good_block / bad_block / good_allow / bad_allow Imply

- **good_block**: The trade was blocked; in hindsight, price moved against the trade (e.g. we would have lost). The block was **beneficial**.
- **bad_block**: The trade was blocked; in hindsight, price moved in favor of the trade (e.g. we would have gained). **Missed opportunity**; the gate may be too strict.
- **good_allow**: The trade was allowed; in hindsight, price moved in favor. **Good decision** to allow.
- **bad_allow**: The trade was allowed; in hindsight, price moved against. **Harmful in hindsight**; the gate may be too loose or the decision was poor.

These are **descriptive**: they describe what happened to price after the decision, not a causal claim that the gate “caused” the outcome.

## How to Interpret Calibration Suggestions

Suggestions are computed per **reason group** (only for blocked candidates that have that reason). They are:

| Suggestion | Meaning |
|------------|--------|
| **review_threshold** | Among evaluated blocks with this reason, a **high share are bad_block** (e.g. ≥50%). Consider reviewing whether the threshold is too strict. Do **not** auto-loosen. |
| **keep_strict** | Among evaluated blocks, a **high share are good_block** (e.g. ≥60%). The gate appears to be blocking harmful trades; keep it strict. |
| **insufficient_data** | Fewer than the minimum evaluated blocks (e.g. 5) for this reason. No suggestion; need more data. |
| **monitor** | Mixed outcomes; neither clearly too strict nor clearly beneficial. Keep monitoring. |

Constants (e.g. minimum evaluated count, bad_block rate for “review”, good_block rate for “keep_strict”) are in code and documented there. They are **conservative** so we avoid overfitting to small samples.

## Why This Is Descriptive, Not Auto-Optimization

- The analysis **only reads** shadow and evaluation data and **outputs** summaries and suggestions.
- **No threshold or config is written** by this layer.
- Operators use the API and reports to **manually** decide whether to change policy, execution quality, or guardrail thresholds.
- We **do not** run an optimizer or regression to “best” parameters; we only highlight likely calibration issues.

## Known Limitations and Anti-Overfitting Guidance

- **Sample size**: Small counts (e.g. &lt;5 evaluated per reason) lead to “insufficient_data”. Avoid drawing strong conclusions from tiny samples.
- **Confounding**: Many blocks have multiple reasons; we attribute to each reason group. A “bad_block” might be driven by a different factor than the reason we grouped by.
- **Single horizon**: Outcomes use 24h markout; shorter or longer horizons could change the picture.
- **No causality**: We report correlation (block + later price move), not that the gate “caused” the outcome.
- **Strategy drift**: If the strategy or market regime changes, past calibration may not apply.

**Anti-overfitting**: Prefer acting on **review_threshold** / **keep_strict** only when the evaluated count is meaningfully large and the pattern is stable over time. Do not tune thresholds on a single day of shadow data.

## API and Jobs

- **GET /api/ops/shadow-analysis**: Returns overall summary, byReasonGroup, bySource, calibrationSuggestions, and warning-only counts. Optional query params: `funderAddress`, `minCandidates`, `onlyEvaluated`, `source`, `reasonGroup`.
- **Scheduled job** `shadow_analysis`: Runs `runShadowAnalysis({})` on an interval (e.g. every 6h). No output is stored; use the API to inspect results or add logging in the job if desired.
