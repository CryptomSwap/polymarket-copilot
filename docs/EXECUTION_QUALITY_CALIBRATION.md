# Execution Quality Threshold Calibration

## Purpose

The execution-quality calibration workflow uses **shadow candidate outcomes** to produce **reviewable recommendations** for adjusting execution-quality thresholds. It does **not** auto-apply changes. Operators use the analysis to decide whether to loosen, tighten, or keep current guardrails based on evidence.

## Current Execution-Quality Thresholds

Thresholds are defined in `lib/execution-quality/config.ts` and used by `evaluateExecutionQuality()`:

| Config key | Default | Meaning |
|------------|--------|--------|
| `staleQuoteBlockMs` | 60_000 | Quote older than this (ms) → block |
| `staleQuoteWarnMs` | 30_000 | Quote older than this (ms) → warn |
| `spreadBlockBps` | 1500 | Spread ≥ this (bps) → block |
| `spreadWarnBps` | 400 | Spread ≥ this (bps) → warn |
| `minDepthBlockRatio` | 0.3 | Same-side depth / intendedSize below this → block |
| `minDepthWarnRatio` | 0.6 | Same-side depth / intendedSize below this → warn |
| `maxPriceDeviationPct` | 0.05 | Intended price &gt; this fraction from best → block |
| `slippageBlockBps` | 500 | Estimated slippage ≥ this (bps) → block |
| `slippageWarnBps` | 200 | Estimated slippage ≥ this (bps) → warn |
| `minLiquidityScoreBlock` | 0.15 | Liquidity score below this → block |
| `minLiquidityScoreWarn` | 0.25 | Liquidity score below this → warn |

Current values are exposed via **GET /api/ops/execution-quality-calibration** as `currentThresholds`.

## Evidence Used for Calibration

- **Shadow candidates** where blocking reasons or execution-quality snapshot warnings involve execution-quality:
  - **Blocked** candidates with at least one execution-quality block reason (e.g. `execution_quality:quote_stale`, `spread_too_wide`, `insufficient_depth`).
  - **Allowed** candidates whose `executionQualitySnapshotJson` contains warnings (e.g. `wide_spread`, `depth_low`) — the “warn-only” cohort.
- **Post-trade evaluation** (markouts, outcome classification) from the shadow-evaluation job:
  - `good_block`: blocked trade would have been unfavorable (block was correct).
  - `bad_block`: blocked trade would have been favorable (missed opportunity; threshold may be too strict).
  - `good_allow` / `bad_allow`: for allowed (including warn-only) trades, whether the outcome was favorable or not.

Calibration groups by **execution-quality subtype** (e.g. `stale_quote`, `spread_too_wide`, `insufficient_depth`, `slippage_too_high`, `not_tradable`, `low_liquidity_score`, `price_too_far_from_market`) and aggregates good_block / bad_block and, for the warn-only cohort, good_allow / bad_allow.

## How Recommendations Are Derived

Recommendations are **descriptive only**; they suggest review, not automatic changes.

| Recommendation | Meaning | Typical trigger |
|----------------|--------|------------------|
| **review_loosen** | Consider loosening the threshold for this subtype. | High bad_block rate (e.g. ≥50%) among evaluated blocked candidates with sufficient sample (e.g. ≥5). |
| **keep_strict** | Block appears beneficial; keep threshold as is. | High good_block rate (e.g. ≥60%) among evaluated blocked. |
| **review_tighten** | Consider tightening so more cases block instead of warn. | Warn-only cohort has high bad_allow rate (e.g. ≥50%). |
| **insufficient_data** | Not enough evaluated candidates to suggest a change. | Evaluated blocked or warn-only count below minimum (e.g. 5). |
| **monitor** | No strong signal; keep monitoring. | Mixed or neutral outcome rates. |

Rules are conservative: we do not claim statistical significance; we only surface counts and rates. The minimum evaluated count (default 5) is configurable via the API (`minEvaluated` query param) and is documented so operators can judge sample size.

## Why Changes Are Not Auto-Applied

- **Safety**: Thresholds directly affect submission-time safety. Automatic tuning could loosen guardrails based on noisy or short-horizon data.
- **Auditability**: All changes should be explicit and traceable (config change, deploy, or runtime override by operator).
- **Overfitting**: Small or biased samples could drive bad threshold changes; human review reduces that risk.

Threshold updates are done by:
- Editing `lib/execution-quality/config.ts` (defaults) and deploying, or
- Calling `setExecutionQualityThresholds()` only when an operator has approved a change (in-memory; process restart reverts to defaults unless persisted elsewhere).

## Anti-Overfitting Guidance

- Prefer **larger samples** before acting on review_loosen or review_tighten.
- Use **multiple horizons** (1h / 6h / 24h) in shadow evaluation; calibration currently uses 24h markout for classification.
- Avoid tuning on a **single market or short time window**; use filters (e.g. `funderAddress`, `source`) to inspect segments but base decisions on broader evidence.
- **Confounding**: A block may co-occur with other reasons (e.g. execution_quality + guardrail). Subtype grouping attributes the candidate to each matching subtype; recommendations are per subtype, not per unique reason combination.
- Re-run calibration after any threshold change to see how the next batch of shadow outcomes behaves.

## API

- **GET /api/ops/execution-quality-calibration**  
  Returns: `currentThresholds`, `perSubtype`, `recommendations`, `totalCandidates`, `eqRelevantCandidates`, `filters`.  
  Optional query: `funderAddress`, `minEvaluated`, `subtype`, `source`.

## Related Docs

- [Execution Quality Guardrails](./EXECUTION_QUALITY_GUARDRAILS.md) — thresholds and block/warn logic.
- [Shadow Mode Telemetry](./SHADOW_MODE_TELEMETRY.md) — what is recorded and where.
- [Post-Trade Evaluation](./POST_TRADE_EVALUATION.md) — markouts and outcome classification.
- [Shadow Threshold Calibration](./SHADOW_THRESHOLD_CALIBRATION.md) — generic shadow analysis by reason group.
