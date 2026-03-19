# ML Shadow Disagreement Analysis

## Purpose

Before using shadow ML anywhere in the decision flow, we need to measure **when shadow ML agrees or disagrees with staged decisions** and **whether disagreements are useful** (e.g. shadow finding missed opportunities vs noise). This layer is **descriptive only**: it compares staged decision outcomes with shadow ML advisory scores and reports cohort stats. It does **not** change runtime behavior, thresholds, or execution.

## What it does

1. **Loads MlShadowTrainingExample rows** (with optional filters: funderAddress, candidateSource, limit).
2. **Derives staged cohort** per row from stored fields:
   - **staged_block**: `wasBlocked === true`
   - **staged_allow**: `wasBlocked === false` and `reducedSizeIndicator === false`
   - **staged_reduce**: `wasBlocked === false` and `reducedSizeIndicator === true` (allowed but size reduced)
3. **Scores each row** with the current ACTIVE/APPROVED shadow model (same features as training) and maps score to **shadow band**: low (&lt;0.4), medium (0.4–0.6), high (≥0.6).
4. **Groups by (staged_cohort, shadow_band)** into nine cohorts: staged_block+low, staged_block+medium, staged_block+high, staged_allow+low, …, staged_reduce+high.
5. **Per cohort** computes:
   - total, evaluated (with outcomeClassification)
   - good_block, bad_block, good_allow, bad_allow counts
   - average 24h markout
   - stagedRightCount / shadowRightCount (outcome favored staged vs shadow)
   - **usefulnessSummary**: staged_more_right | shadow_more_right | tie | insufficient (requires ≥3 evaluated)
6. **Agreement vs disagreement**: Agreement = staged and shadow aligned (e.g. block+low, allow+high, reduce+medium/high). Disagreement = opposite (e.g. block+high, allow+low). Reports agreementRate and disagreementRate.
7. **Recent samples**: Up to 50 sample rows with cohort, score, outcome, markout, source, createdAt.

If **no shadow model** is ACTIVE/APPROVED, the API still returns the same structure with `modelId: null`, empty cohort counts, and no agreement/disagreement rates.

## Cohorts

| Staged cohort   | Meaning                          | Shadow bands |
|-----------------|----------------------------------|--------------|
| staged_block    | We blocked the trade             | low, medium, high |
| staged_allow    | We allowed full size             | low, medium, high |
| staged_reduce   | We allowed but reduced size     | low, medium, high |

- **Agreement**: staged_block+low (we blocked, ML says low good-decision score), staged_allow+high (we allowed, ML says high), staged_reduce+medium/high.
- **Disagreement**: staged_block+high (we blocked but ML says high → possible missed opportunity), staged_allow+low (we allowed but ML says low → possible bad allow).

## Usefulness

Per cohort, **stagedRightCount** = outcomes where the staged decision looked right (e.g. good_block when we blocked). **shadowRightCount** = outcomes where the shadow signal looked right (e.g. bad_block when we blocked → we missed a good trade). **usefulnessSummary**:

- **staged_more_right**: In this cohort, outcomes more often favored the staged decision.
- **shadow_more_right**: In this cohort, outcomes more often favored the shadow signal (e.g. missed opportunities when we blocked and shadow was high).
- **tie**: Equal.
- **insufficient**: Fewer than 3 evaluated rows; no conclusion.

Use this to see whether shadow ML is adding useful signal (e.g. staged_block+shadow_high with shadow_more_right → shadow is flagging missed opportunities) or mostly noise before integrating it into the decision flow.

## API

**GET /api/ops/ml-shadow-disagreement**

Query params (all optional):

- **funderAddress**: Filter to one funder.
- **candidateSource**: Filter by candidateSource (e.g. runtime_automated).
- **shadowBand**: Filter to one band (low | medium | high).
- **stagedCohort**: Filter to one staged cohort (staged_block | staged_allow | staged_reduce).
- **limit**: Max rows to analyze (default 5000, cap 10000).

Response: `DisagreementAnalysisResult` (modelId, cohortStats, agreementRate, disagreementRate, totalRows, evaluatedRows, recentSamples, advisoryOnly: true).

## Constraints

- **No runtime behavior change**: Analysis is read-only; it does not affect allow/block/sizing.
- **No live trading**: No execution.
- **No autonomous ML control**: Shadow ML remains advisory; this layer only measures agreement/disagreement.
- **No threshold auto-tuning**: No automatic change to score bands or decision logic.

## How to use the output

- **Agreement rate**: High agreement suggests shadow ML is aligned with current staged decisions; low may mean shadow is adding a different signal or noise.
- **Cohort usefulness**: Focus on disagreement cohorts (e.g. staged_block+high). If shadow_more_right and many bad_blocks, shadow may be identifying missed opportunities. If staged_more_right, blocking was often correct despite high shadow score.
- **Samples**: Use recentSamples to inspect individual disagreement cases (shadowCandidateId, outcome, markout) for manual review before any integration.
