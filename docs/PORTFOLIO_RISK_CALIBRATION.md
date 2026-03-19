# Portfolio Risk Threshold Calibration

## Purpose

The portfolio-risk calibration workflow uses **shadow candidate outcomes** to produce **reviewable recommendations** for adjusting concentration and exposure guardrails. It does **not** auto-apply changes. Operators use the analysis to decide whether to loosen, tighten, or keep current limits based on evidence.

## Current Portfolio-Risk Thresholds

Thresholds are defined in `lib/portfolio-risk/config.ts` and exposed via `getPortfolioRiskThresholds()`:

| Config key | Default | Meaning |
|------------|--------|--------|
| `maxTotalExposure` | 100_000 | Max total gross / at-risk exposure (notional). |
| `maxSingleMarketConcentrationPct` | 50 | Max single-market concentration (0–100). |
| `maxSingleThemeConcentrationPct` | 50 | Max single-theme concentration (0–100). |
| `nearResolutionHoursThreshold` | 72 | Hours to resolution below which position is "near resolution". |
| `nearResolutionExposureWarnPct` | 20 | Near-resolution exposure as % of total: above → warn. |
| `nearResolutionExposureBlockPct` | 50 | Near-resolution exposure as % of total: above → block (if used). |
| `illiquidExposureWarnPct` | 30 | Illiquid exposure as % of total: above → warn. |
| `illiquidExposureBlockPct` | 60 | Illiquid exposure as % of total: above → block (if used). |
| `correlatedExposureWarnPct` | 60 | Correlated exposure as % of total: above → warn. |
| `correlatedExposureBlockPct` | 85 | Correlated exposure as % of total: above → block (if used). |

Runtime and execution-policy exposure limits (e.g. `maxTotalExposure`, concentration %) are today supplied by callers; the config above is the **central default** for calibration and future wiring. Current behavior is unchanged until callers are updated to use `getPortfolioRiskThresholds()`.

## Evidence Used for Calibration

- **Shadow candidates** where blocking reasons, execution-policy exposure checks, or portfolio-risk snapshots indicate portfolio-risk / concentration influence:
  - **Blocked** candidates with at least one portfolio-risk–related block reason (e.g. `exposure_total_breach`, `single_market_concentration_breach`, `single_theme_concentration_breach`, or concentration/risk flags from `portfolioRiskSnapshotJson`).
  - **Allowed** candidates whose `portfolioRiskSnapshotJson` contains concentration or risk flags (e.g. warning state at decision time).
- **Post-trade evaluation** (markouts, outcome classification) from the shadow-evaluation job:
  - **good_block**: blocked trade would have been unfavorable (block was correct).
  - **bad_block**: blocked trade would have been favorable (missed opportunity; threshold may be too strict).
  - **good_allow** / **bad_allow**: for allowed trades, whether the outcome was favorable or not.

Calibration groups by **portfolio-risk subtype** (e.g. `total_exposure`, `single_market_concentration`, `single_theme_concentration`, `near_resolution_exposure`, `illiquid_exposure`, `correlated_exposure`, `portfolio_fit_penalty`, `behavior_conflict`, `other_portfolio_risk`) and aggregates good_block / bad_block and good_allow / bad_allow per subtype.

## Subtype Meanings

| Subtype | Meaning | Example raw reasons / flags |
|--------|--------|-----------------------------|
| `total_exposure` | Total at-risk exposure over limit | exposure_total_breach, total_exposure_breach |
| `single_market_concentration` | Single-market concentration over limit | single_market_concentration_breach, market_concentration_breach, single_market |
| `single_theme_concentration` | Single-theme concentration over limit | single_theme_concentration_breach, theme_concentration_breach, single_theme |
| `near_resolution_exposure` | High exposure in markets resolving soon | near_resolution_concentration |
| `illiquid_exposure` | High exposure in illiquid positions | illiquid_exposure, illiquid |
| `correlated_exposure` | High correlated (e.g. cluster) exposure | correlated_exposure, correlated |
| `portfolio_fit_penalty` | Decision-layer portfolio-fit / concentration penalty | High concentration, theme concentration exceeds limit |
| `behavior_conflict` | Behavior or trim-before-automation conflict | behavior_conflict, trim before automation |
| `other_portfolio_risk` | Other concentration/exposure-related | Generic concentration/exposure breach |

## How Recommendations Are Derived

Recommendations are **descriptive only**; they suggest review, not automatic changes.

| Recommendation | Meaning | Typical trigger |
|----------------|--------|------------------|
| **review_loosen** | Consider loosening the threshold for this subtype. | High bad_block rate (e.g. ≥50%) among evaluated blocked candidates with sufficient sample (e.g. ≥5). |
| **keep_strict** | Block appears beneficial; keep threshold as is. | High good_block rate (e.g. ≥60%) among evaluated blocked. |
| **review_tighten** | Consider tightening so more cases block. | Allowed cohort has high bad_allow rate (e.g. ≥50%). |
| **insufficient_data** | Not enough evaluated candidates to suggest a change. | Evaluated blocked or allowed count below minimum (e.g. 5). |
| **monitor** | No strong signal; keep monitoring. | Mixed or neutral outcome rates. |

Rules are conservative; we do not claim statistical significance. The minimum evaluated count (default 5) is configurable via the API (`minEvaluated` query param).

## Why Changes Are Not Auto-Applied

- **Safety**: Concentration and exposure limits directly affect risk. Automatic tuning could loosen guardrails based on noisy or short-horizon data.
- **Auditability**: All changes should be explicit and traceable (config change, deploy, or runtime override by operator).
- **Overfitting**: Small or biased samples could drive bad threshold changes; human review reduces that risk.

Threshold updates are done by editing `lib/portfolio-risk/config.ts` (defaults) and deploying, or by calling `setPortfolioRiskThresholds()` only when an operator has approved a change (in-memory; process restart reverts to defaults unless persisted elsewhere).

## Anti-Overfitting Guidance

- Prefer **larger samples** before acting on review_loosen or review_tighten.
- Use **multiple horizons** (1h / 6h / 24h) in shadow evaluation; calibration uses 24h markout for classification.
- Avoid tuning on a **single market or short time window**; use filters (e.g. `funderAddress`, `source`) to inspect segments but base decisions on broader evidence.
- **Confounding**: A block may co-occur with other reasons (e.g. concentration + execution quality). Subtype grouping attributes the candidate to each matching subtype; recommendations are per subtype.
- Re-run calibration after any threshold change to see how the next batch of shadow outcomes behaves.

## API

- **GET /api/ops/portfolio-risk-calibration**  
  Returns: `currentThresholds`, `perSubtype`, `recommendations`, `totalCandidates`, `riskRelevantCandidates`, `filters`.  
  Optional query: `funderAddress`, `minEvaluated`, `subtype`, `source`.

## Related Docs

- [Shadow Mode Telemetry](./SHADOW_MODE_TELEMETRY.md) — what is recorded and where.
- [Post-Trade Evaluation](./POST_TRADE_EVALUATION.md) — markouts and outcome classification.
- [Shadow Threshold Calibration](./SHADOW_THRESHOLD_CALIBRATION.md) — generic shadow analysis by reason group.
- [Execution Quality Calibration](./EXECUTION_QUALITY_CALIBRATION.md) — execution-quality–specific calibration.
