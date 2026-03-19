# ML Shadow Dataset Pipeline

## Why this dataset exists

The existing ML pipeline (`lib/ml/dataset.ts`, `MlTrainingExample`) is **recommendation-centric**: one row per recommendation, with features from signals/portfolio/news and labels from `RecommendationEvaluation` (forward returns, labelPositive6h/24h). It answers: *“Did this recommendation’s outcome look good?”*

The **shadow dataset** is **trading-bot-centric**: one row per **shadow candidate** (every trade the bot considered—blocked or allowed—in paper/shadow mode). It answers: *“Given the full decision/execution/risk context at runtime, was the allow/block decision good, and how did the market move later?”* It is built so we can train or tune models to improve **bot behavior** (when to allow vs block, size, which checks matter) instead of only improving recommendation scoring.

## How it differs from the recommendation ML dataset

| Aspect | Recommendation ML (`MlTrainingExample`) | Shadow ML (`MlShadowTrainingExample`) |
|--------|----------------------------------------|--------------------------------------|
| **Source** | `Recommendation` + `RecommendationEvaluation` | `ShadowCandidate` + decision/policy/quality/risk/safety snapshots |
| **Unit** | One row per recommendation | One row per shadow candidate (block or allow) |
| **Labels** | Forward return 1h/6h/24h, labelPositive* | Markouts 1h/6h/24h, outcomeClassification, labelGoodDecision / labelBadDecision / labelMissedOpportunity |
| **Use** | Train “will this recommendation be profitable?” | Train “was this allow/block/sizing decision good?” and “which guards add value?” |
| **Table** | `MlTrainingExample` (key: recommendationId) | `MlShadowTrainingExample` (key: shadowCandidateId) |

The two datasets are **separate tables** and **separate code paths**. Shadow examples are never mixed with recommendation examples.

## Feature groups

Features are extracted **explicitly** from `ShadowCandidate` and its snapshot JSONs (no implicit parsing).

- **Identifiers / linkage**: shadowCandidateId, funderAddress, recommendationId, orderIntentId, assetId, marketId, candidateSource, createdAt.
- **A. Decision-stage**: policyState, sizeMultiplier, finalSuggestedSize, eligibilityBlockersCount, reducedSizeIndicator, blockedIndicator (from `decisionSnapshotJson` / `DecisionSnapshotLike`).
- **B. Execution-policy**: executionAllow, executionBlockingReasonGroups (e.g. `exposure,freshness`), executionWarningCount (from `executionPolicySnapshotJson`).
- **C. Execution-quality**: qualityState, spreadBps, estimatedSlippage, depthSufficiency, quoteFreshnessState, tradable (from `executionQualitySnapshotJson`).
- **D. Portfolio-risk**: grossExposure, totalOpenExposure, workingOrderExposure, max single-market/theme concentration %, worstCaseLossEstimate, nearResolutionExposure, illiquid/correlated estimates, portfolioRiskFlagsCount (from `portfolioRiskSnapshotJson` when present).
- **E. Runtime-safety**: runtimeSafetyState, runtimeWarningCount, runtimeBlockingCount (from `runtimeSafetySnapshotJson`).
- **F. Simple market/candidate**: side, intendedPrice, intendedSize, recommendationPresent, outcomeBlockedVsAllowedVsSubmitted (blocked | allowed | submitted).

Missing snapshots produce **null** or default values for that group; the row is still valid (partial features).

## Label semantics

- **outcomeClassification** (from shadow evaluation): `good_block` | `bad_block` | `good_allow` | `bad_allow`.
- **markout1h / markout6h / markout24h**: (priceLater − price0)/price0 for BUY; sign flipped for SELL. Stored as strings; null if not evaluated.
- **Derived labels** (conservative, from outcome only):
  - **labelGoodDecision**: true for `good_allow` or `good_block`; false for `bad_allow`; false for `bad_block` (we blocked something that would have been good).
  - **labelBadDecision**: true only for `bad_allow`.
  - **labelMissedOpportunity**: true for `bad_block` (we blocked, outcome would have been favorable).
  - **labelExecutionUnsafe**: true only when `bad_allow` and execution-quality snapshot had blocking reasons; null otherwise. Conservative: do not use for training until you have more evidence.

Semantics in short:

- **good_allow** → positive allow decision.
- **bad_allow** → negative allow decision.
- **good_block** → positive block decision.
- **bad_block** → missed opportunity (negative block decision).

## What it is safe to use for

- **Offline analysis**: understand which guards correlate with good/bad outcomes and missed opportunities.
- **Building a separate training dataset** for “allow vs block” or “block reason” models, without touching the recommendation model.
- **Auditing**: trace from shadow candidate → features → labels for any row.
- **Future bot-improvement ML**: once validated, this dataset can feed models that advise *when* to allow/block or *how* to size; the pipeline remains **advisory only**.

## What it should NOT be used for (yet)

- **Live trading**: the pipeline does not enable live trading and does not change runtime behavior.
- **Autonomous ML**: no model is auto-retrained or auto-deployed from this dataset; no threshold auto-tuning.
- **Replacing recommendation ML**: the recommendation dataset and models stay as-is; shadow data is additive.
- **labelExecutionUnsafe** as a primary target until you have more evidence and a clear definition of “execution unsafe” in your policy.

## How it supports future bot-improvement ML

1. **Continuous collection**: shadow candidates are recorded at runtime; after evaluation (markouts/classification), `ml_shadow_dataset_build` (or the ops API) turns them into `MlShadowTrainingExample` rows.
2. **Explicit features**: decision, execution policy, execution quality, portfolio risk, and runtime safety are stored in a boring, auditable way so future models can use them without re-parsing raw JSON in ad hoc ways.
3. **Conservative labels**: good/bad/missed-opportunity labels are derived from existing outcome classification so we can train “was this decision good?” without overclaiming.
4. **Separation of concerns**: recommendation ML stays recommendation-centric; shadow ML stays bot-centric. No mixing of the two in one table.

## Pipeline flow

1. **Runtime**: Bot produces shadow candidates (block or allow) and writes `ShadowCandidate` + snapshot JSONs.
2. **Evaluation**: `evaluateShadowCandidates` (job or API) fills markouts and `outcomeClassification` on `ShadowCandidate`.
3. **Dataset build**: `persistShadowTrainingExamples()` (job `ml_shadow_dataset_build` or `POST /api/ops/ml-shadow-dataset`) scans evaluated candidates, builds one `ShadowTrainingRow` per candidate, and persists to `MlShadowTrainingExample`, skipping candidates that already have an example (no duplicates per shadowCandidateId).

## Running the pipeline

- **Job**: `ml_shadow_dataset_build` (e.g. via `POST /api/ops/run-job` with `{ "jobName": "ml_shadow_dataset_build" }` or on schedule).
- **API**:
  - `GET /api/ops/ml-shadow-dataset?funderAddress=0x...&limit=10`: counts and recent examples.
  - `POST /api/ops/ml-shadow-dataset`: body `{ "funderAddress?", "limit?", "createdAfter?", "createdBefore?", "evaluatedOnly?", "dryRun?" }` to run the build (optionally dry run).

After adding the `MlShadowTrainingExample` model, run `npx prisma migrate dev` (or deploy migrations) and `npx prisma generate` before using the API or job.
