# Shadow ML Training

## Purpose

Shadow ML training uses **MlShadowTrainingExample** (built from shadow candidates and their outcomes) to train a model that predicts **whether the allow/block decision was good** or **whether we missed an opportunity**. The model is stored as an **MlModelRun** with `modelType: "logistic_regression_shadow"`, kept **separate** from recommendation ML (`modelType: "logistic_regression"`). It is used only for **advisory** scoring; it does not change execution behavior.

## Training targets

- **labelGoodDecision** (default): Binary label derived from outcome classification. Positive when the decision was good (good_allow, good_block); negative when bad_allow or when we blocked a good opportunity (bad_block).
- **labelMissedOpportunity**: Positive when we blocked and the outcome would have been favorable (bad_block); negative otherwise.

Start with **labelGoodDecision** for a conservative first pass. Add **labelMissedOpportunity** when you want a model that specifically flags “we should have allowed this.”

## Feature source

Features come from **MlShadowTrainingExample** columns, in a fixed order defined by **SHADOW_FEATURE_NAMES** in `lib/ml/shadow-train/features.ts`:

- Decision-stage: sizeMultiplier, finalSuggestedSize, eligibilityBlockersCount, reducedSizeIndicator, blockedIndicator, policyStateEnc.
- Execution-policy: executionAllow, executionWarningCount.
- Execution-quality: qualityStateEnc, spreadBps, estimatedSlippage, tradable.
- Portfolio-risk: grossExposure, totalOpenExposure, maxSingleMarketConcentrationPct, maxSingleThemeConcentrationPct, portfolioRiskFlagsCount.
- Runtime-safety: runtimeWarningCount, runtimeBlockingCount.
- Simple: intendedPrice, intendedSize, recommendationPresent, sideEnc, outcomeBlockedVsAllowedVsSubmittedEnc (training only; scoring uses 0).

Missing values are encoded as 0. Training uses a time-based train/validation split (default 80% oldest train, 20% newest val).

## Model separation from recommendation ML

- **Recommendation ML**: `modelType: "logistic_regression"`, trained on **MlTrainingExample** (one row per recommendation), targets labelPositive6h/labelPositive24h. Used by `scoreLiveRecommendations` and `getActiveOrApprovedModel` (which filters on `modelType: "logistic_regression"`).
- **Shadow ML**: `modelType: "logistic_regression_shadow"`, trained on **MlShadowTrainingExample** (one row per shadow candidate), targets labelGoodDecision or labelMissedOpportunity. Used by `scoreShadowCandidate` and `getActiveOrApprovedShadowModel` (which filters on `modelType: "logistic_regression_shadow"`).

Only one ACTIVE run per model type: activating a shadow model does not change the ACTIVE recommendation model, and vice versa.

## What this model is intended to predict

- For **labelGoodDecision**: “Given the same feature context, would we make a good decision?” (P(good decision)). High score → context typically associated with good decisions; low score → context associated with bad decisions or missed opportunities.
- For **labelMissedOpportunity**: “Given we blocked, did we miss a good opportunity?” Used to review blocks and tune guardrails.

The model is **advisory only**: it does not decide allow/block or size; it informs operator review and future tuning.

## Limitations and anti-overfitting

- **Small or skewed data**: Shadow dataset can be small or imbalanced (e.g. many blocks, few allows). Train with a reasonable `limit` and check validation metrics before promoting to ACTIVE/APPROVED.
- **Time leakage**: Training uses time-split (oldest train, newest val). Avoid using future-looking or post-outcome data in features.
- **Conservative targets**: Labels are derived from outcome classification (good_block, bad_block, good_allow, bad_allow). They are simple and conservative; do not overcomplicate with extra derived targets until the pipeline is stable.
- **No autonomous use**: Do not wire the model output to automatic block/allow or sizing. Keep it for dashboards, operator review, and offline analysis.

## How to run

- **API**: `POST /api/ops/ml-shadow-train` with body `{ funderAddress?, limit?, createdAfter?, createdBefore?, trainRatio?, targetLabel?: "labelGoodDecision" | "labelMissedOpportunity" }`.
- **Approve/activate**: Use existing `POST /api/ml/approve-run` and `POST /api/ml/activate-run` with the returned `modelRunId`. Only one ACTIVE shadow model at a time (per modelType).
- **List runs**: `GET /api/ml/runs` returns all runs; filter client-side by `modelType === "logistic_regression_shadow"` to see shadow runs.
