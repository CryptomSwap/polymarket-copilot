# Shadow ML Advisory Scoring

## How live advisory scoring works

Shadow scoring takes **current candidate context** (same feature set as training: decision/policy/quality/risk/safety and simple market fields), runs it through the **active or approved shadow-trained model**, and returns an **advisory** score and band. It does **not** read or write execution state, and it does **not** change allow/block or sizing decisions.

1. **Model load**: `getActiveOrApprovedShadowModel()` loads the latest **MlModelRun** with `modelType: "logistic_regression_shadow"` and status ACTIVE or APPROVED. If none exists, scoring returns an error (no score).
2. **Feature vector**: The candidate context is converted to a numeric vector via `toShadowFeatureVector` (same order as training). Missing fields are filled with 0.
3. **Inference**: The model outputs a probability (e.g. P(good decision)). It is returned with a band and metadata.
4. **Output**: `ShadowScoreResult`: shadowMlScore, shadowMlScoreBand, modelId, modelFeatureSet, modelTargetLabel, isShadowModel: true, featureCompletenessWarnings.

## Output fields

| Field | Meaning |
|-------|--------|
| **shadowMlScore** | Probability from the shadow model (e.g. P(good decision)). Range 0–1. |
| **shadowMlScoreBand** | "low" (\<0.4), "medium" (0.4–0.6), "high" (≥0.6). For operator display. |
| **modelId** | MlModelRun id used for this score. |
| **modelFeatureSet** | Feature set name (e.g. shadow_v1). |
| **modelTargetLabel** | Target the model was trained on (e.g. labelGoodDecision). |
| **isShadowModel** | Always true; distinguishes from recommendation ML. |
| **featureCompletenessWarnings** | List of warnings when features are missing or partial (e.g. portfolio_exposure_missing, execution_quality_partial). Use for operator review. |

## Where it may plug into operator review

- **Dashboard**: Show shadow score and band next to a candidate (e.g. in an ops or calibration UI). Operator can compare with actual allow/block and outcome.
- **Comparison with recommendation ML**: Recommendation ML scores “will this recommendation be profitable?”; shadow ML scores “is this context associated with good decisions?”. Both can be shown side by side for the same candidate when a recommendation exists.
- **Post-block review**: For blocked candidates, shadow score (e.g. labelGoodDecision) can help prioritize which blocks to review (e.g. low score + bad outcome → worth revisiting).

It does **not** plug into the execution path: the runtime does not call shadow scoring to decide allow/block or size.

## What it must NOT control yet

- **Execution**: Must not decide allow/block, size, or any trade execution.
- **Thresholds**: No automatic threshold or rule that turns the score into an action.
- **Replacement of staged decision**: Staged decision logic (eligibility, policy, risk, execution quality) remains the source of truth for blocking/allowing. Shadow ML is advisory only.
- **Autonomous use**: Do not use the score to auto-approve or auto-block. Keep it for human review and analysis.

## API

- **GET /api/ops/ml-shadow-score**: Returns whether an ACTIVE/APPROVED shadow model exists and its id, featureSetName, targetLabel. No scoring.
- **POST /api/ops/ml-shadow-score**: Body = candidate context (ShadowScoreInput). Returns advisory result (ShadowScoreResult) or error if no model.

## Missing optional features

If context is partial (e.g. no portfolio risk snapshot), missing features are encoded as 0. `featureCompletenessWarnings` lists which parts are missing (e.g. portfolio_exposure_missing, execution_quality_partial). The score is still computed; operators can treat warnings as a signal to interpret the score with caution.
