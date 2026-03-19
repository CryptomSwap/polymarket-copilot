# Runtime Policy / Freshness Threshold Calibration

## Purpose

The runtime-policy calibration workflow uses **shadow candidate outcomes** to produce **reviewable recommendations** for adjusting freshness and runtime-policy guardrails. It does **not** auto-apply changes. Operators use the analysis to decide whether to loosen, tighten, or keep current thresholds based on evidence.

These gates control whether the bot is acting on trustworthy, current information (market data, user feed, reconciliation, decision snapshot, runtime phase, exchange truth).

## Current Freshness / Runtime-Policy Thresholds

Thresholds are defined in `lib/runtime-policy-config` and exposed via `getRuntimePolicyThresholds()`:

| Config key | Default | Meaning |
|------------|--------|--------|
| `marketDataFreshnessWarnMs` | 30_000 | Market data: warn when older than this (ms). |
| `marketDataFreshnessBlockMs` | 60_000 | Market data: block when older than this (ms). |
| `userFeedFreshnessWarnMs` | 60_000 | User feed: warn when older than this (ms). |
| `userFeedFreshnessBlockMs` | 90_000 | User feed: block when older than this (ms). |
| `portfolioTruthFreshnessWarnMs` | 60_000 | Portfolio/position truth: warn when older (ms). |
| `portfolioTruthFreshnessBlockMs` | 120_000 | Portfolio/position truth: block when older (ms). |
| `reconciliationFreshnessWarnMs` | 60_000 | Reconciliation: warn when last run older (ms). |
| `reconciliationFreshnessBlockMs` | 120_000 | Reconciliation: block when last run older (ms). |
| `decisionSnapshotMaxAgeMs` | 300_000 | Decision snapshot: max age (ms) before stale. |
| `runtimeErrorWarnCount` | 5 | Runtime errors: warn above this count. |
| `runtimeErrorBlockCount` | 20 | Runtime errors: block above this count. |
| `fillReplayBacklogWarn` | 10 | Fill replay backlog: warn above this. |
| `fillReplayBacklogBlock` | 50 | Fill replay backlog: block above this. |
| `exchangeTruthUnavailableBlocks` | true | When true, exchange truth unavailable blocks. |
| `runtimePhaseBlockOnStartup` | true | Block when phase is starting. |
| `runtimePhaseBlockOnRebuilding` | true | Block when phase is rebuilding. |
| `runtimePhaseBlockOnReconciling` | true | Block when phase is reconciling. |

These defaults are aligned with current execution-policy, stream-watchdog, and stream-runtime usage. Runtime behavior is unchanged until callers are wired to use `getRuntimePolicyThresholds()`.

## Evidence Used for Calibration

- **Shadow candidates** where blocking reasons or runtime-safety snapshots indicate freshness/runtime-policy influence:
  - **Blocked** candidates with at least one runtime-policy–related block reason (e.g. `market_data_stale`, `user_data_stale`, `reconciliation_stale`, `decision_snapshot_stale`, `runtime_not_ready`, `runtime_rebuilding`, `runtime_reconciling`, `exchange_truth_unavailable`, `kill_switch_global`, or `freshness:*`).
  - **Allowed** candidates whose `runtimeSafetySnapshotJson` contains policy-related reasons (e.g. warning state at decision time).
- **Post-trade evaluation** (markouts, outcome classification) from the shadow-evaluation job:
  - **good_block**: blocked trade would have been unfavorable (block was correct).
  - **bad_block**: blocked trade would have been favorable (missed opportunity; threshold may be too strict).
  - **good_allow** / **bad_allow**: for allowed trades, whether the outcome was favorable or not.

Calibration groups by **runtime-policy subtype** and aggregates good_block / bad_block and good_allow / bad_allow per subtype.

## Subtype Meanings

| Subtype | Meaning | Example raw reasons |
|--------|--------|----------------------|
| `stale_market_data` | Market data too old | market_data_stale, freshness:market_data_stale |
| `stale_user_feed` | User feed too old | user_data_stale, freshness:user_data_stale |
| `stale_portfolio_truth` | Portfolio/position truth too old | (portfolio + stale) |
| `stale_reconciliation` | Reconciliation too old or drift | reconciliation_stale, reconciliation_drift |
| `stale_decision_snapshot` | Decision snapshot too old | decision_snapshot_stale, stale_decision_snapshot |
| `runtime_phase_block` | Runtime not ready (rebuilding/reconciling/starting) | runtime_not_ready, runtime_rebuilding, runtime_reconciling |
| `runtime_safety_blocked` | Runtime safety state blocked | runtime_safety_blocked, blocked |
| `runtime_safety_kill_switch` | Kill switch active | kill_switch_global, watchdog_kill_switch |
| `exchange_truth_unavailable` | Exchange orders/fills truth unavailable or stale | exchange_truth_unavailable, exchange_truth_stale |
| `replay_backlog` | Fill replay backlog | replay_backlog |
| `runtime_error` | Runtime errors | runtime_error |
| `other_freshness_policy` | Other freshness/policy-related | Generic stale/freshness |

## How Recommendations Are Derived

Recommendations are **descriptive only**; they suggest review, not automatic changes.

| Recommendation | Meaning | Typical trigger |
|----------------|--------|------------------|
| **review_loosen** | Consider loosening the threshold for this subtype. | High bad_block rate (e.g. ≥50%) among evaluated blocked with sufficient sample (e.g. ≥5). |
| **keep_strict** | Block appears beneficial; keep threshold as is. | High good_block rate (e.g. ≥60%) among evaluated blocked. |
| **review_tighten** | Consider tightening so more cases block. | Allowed cohort has high bad_allow rate (e.g. ≥50%). |
| **insufficient_data** | Not enough evaluated candidates to suggest a change. | Evaluated blocked or allowed count below minimum (e.g. 5). |
| **monitor** | No strong signal; keep monitoring. | Mixed or neutral outcome rates. |

Rules are conservative; we do not claim statistical significance. The minimum evaluated count (default 5) is configurable via the API (`minEvaluated` query param).

## Why Changes Are Not Auto-Applied

- **Safety**: Freshness and runtime-policy gates ensure the bot acts on current, trustworthy data. Automatic tuning could loosen them based on noisy or short-horizon data.
- **Auditability**: All changes should be explicit and traceable (config change, deploy, or runtime override by operator).
- **Overfitting**: Small or biased samples could drive bad threshold changes; human review reduces that risk.

Threshold updates are done by editing `lib/runtime-policy-config/defaults.ts` (or using a dedicated config module) and deploying, or by calling `setRuntimePolicyThresholds()` only when an operator has approved (in-memory; process restart reverts to defaults unless persisted elsewhere).

## Anti-Overfitting Guidance

- Prefer **larger samples** before acting on review_loosen or review_tighten.
- Use **multiple horizons** (1h / 6h / 24h) in shadow evaluation; calibration uses 24h markout for classification.
- Avoid tuning on a **single market or short time window**; use filters (e.g. `funderAddress`, `source`) to inspect segments but base decisions on broader evidence.
- **Confounding**: A block may co-occur with other reasons (e.g. freshness + execution quality). Subtype grouping attributes the candidate to each matching subtype; recommendations are per subtype.
- Re-run calibration after any threshold change to see how the next batch of shadow outcomes behaves.

## API

- **GET /api/ops/runtime-policy-calibration**  
  Returns: `currentThresholds`, `perSubtype`, `recommendations`, `totalCandidates`, `runtimePolicyRelevantCandidates`, `filters`.  
  Optional query: `funderAddress`, `minEvaluated`, `subtype`, `source`.

## Related Docs

- [Shadow Mode Telemetry](./SHADOW_MODE_TELEMETRY.md) — what is recorded and where.
- [Post-Trade Evaluation](./POST_TRADE_EVALUATION.md) — markouts and outcome classification.
- [Execution Quality Calibration](./EXECUTION_QUALITY_CALIBRATION.md) — execution-quality thresholds.
- [Portfolio Risk Calibration](./PORTFOLIO_RISK_CALIBRATION.md) — portfolio-risk thresholds.
