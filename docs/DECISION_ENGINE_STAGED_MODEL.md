# Decision Engine – Staged Model

## Purpose

The decision engine is refactored into **explicit stages** so that:

- **Eligibility** is a hard gate (blockers → no sizing), not silent score decay.
- **Edge** reflects thesis strength only (heuristic, ML, news as edge modifiers, setup history).
- **Market quality** is separate (liquidity, crowding, news saturation).
- **Portfolio fit** uses concentration and penalties to reduce or block sizing without changing edge.
- **Sizing** runs only after earlier stages and uses structured modifiers.
- **Explanation** is assembled in a fixed order: blockers → edge → market quality → portfolio fit → sizing.

The result is more stable, auditable, and less prone to hidden double-counting than a single blended score.

## Staged architecture

```
StagedDecisionInput
       ↓
  1. Eligibility   →  eligible, blockers, warnings
       ↓
  2. Edge         →  edgeState, convictionScore, edgeReasons
       ↓
  3. MarketQuality →  marketQualityState, marketQualityReasons, block, warnings
       ↓
  4. PortfolioFit →  portfolioFitState, portfolioFitPenalty, reasons
       ↓
  5. Sizing       →  suggestedSize, sizeMultiplier, sizingReasons  (uses 1–4)
       ↓
  6. Explanation  →  ordered lines (blockers, edge, market, portfolio, sizing)
       ↓
StagedDecisionResult (+ legacy blendedScore, policyState, blockReason, finalSuggestedSize)
```

## Stage responsibilities

### 1. Eligibility

- **Responsibility:** Hard blockers only. No score decay.
- **Inputs:** `blockedReason`, `qualityBlocker`, `reviewStatus` (REJECTED → block), `action`, `signalType` (chase + low conviction → block).
- **Output:** `eligible`, `blockers`, `warnings`.
- **Rules:** Any blocker → not eligible. Sizing stage returns 0 when not eligible.

### 2. Edge assessment

- **Responsibility:** Thesis strength: heuristic + ML + news (as edge modifiers) + setup history. No concentration or sizing.
- **Inputs:** `heuristicPriorityScore`, `mlScore`, `newsCatalystBoost`, `newsSaturationPenalty`, `setupActedWinRate`, `setupOverrideWinRate`, `setupSampleCount`.
- **Output:** `edgeState` (high/medium/low/negative), `convictionScore` (0–1), `edgeReasons`.
- **Rules:** Fixed weights (e.g. ML 0.35, heuristic 0.65). Setup win rate adds/subtracts a small delta. News catalyst/saturation applied once here; not applied again in portfolio or sizing.

### 3. Market quality

- **Responsibility:** Is the market a good vehicle? Liquidity, crowding, news saturation.
- **Inputs:** `liquidityScore`, `signalType` (e.g. OVERCROWDED_THEME), `newsSaturationPenalty`.
- **Output:** `marketQualityState` (ok/degraded/poor), `marketQualityReasons`, `block`, `warnings`.
- **Rules:** Very low liquidity or overcrowded theme → block. High news saturation → reason/warning. Does not change edge score.

### 4. Portfolio fit

- **Responsibility:** Concentration and behavior/portfolio penalties. Reduces or blocks sizing; does not change edge.
- **Inputs:** `themeExposurePct`, `topThemeConcentrationPct`, `behaviorPenalty`, `portfolioPenalty`.
- **Output:** `portfolioFitState` (ok/caution/block), `portfolioFitPenalty`, `reasons`.
- **Rules:** High theme/top concentration or high penalties → block or caution and penalty. Sizing stage uses penalty and state.

### 5. Sizing

- **Responsibility:** Suggested size and multiplier only after eligibility, edge, market quality, portfolio fit.
- **Inputs:** All prior stage outputs, plus `action`, `suggestedSizeFromRec`, `reviewStatus`, `themeExposurePct`, `topThemeConcentrationPct`, ML/heuristic disagreement.
- **Output:** `suggestedSize`, `sizeMultiplier`, `sizingReasons`.
- **Rules:** Not eligible or portfolio/market block → 0. EXIT/TRIM use fixed logic. Otherwise apply portfolio fit penalty and concentration/review/disagreement multipliers.

### 6. Explanation

- **Responsibility:** Single ordered list for operators and UI.
- **Inputs:** All stage outputs.
- **Output:** `explanation: string[]` and `reasoningBreakdown` (blockers, supportive, edgeReasons, marketQualityReasons, portfolioFitReasons, sizingReasons).
- **Rules:** Blockers first, then edge, market quality, portfolio fit, sizing.

## What no longer belongs in blended scoring

- **Blockers** are not subtracted from a score; they set eligibility to false and size to 0.
- **Concentration** does not reduce the edge (conviction) score; it only affects portfolio fit and sizing.
- **News saturation** is applied once in edge (and optionally in market quality for explanation); it is not applied again in portfolio or sizing.
- **Review status** does not change edge; it only affects sizing multiplier and policy state.
- **qualityBlocker** is an eligibility blocker only; it was previously not in the blend at all.

## How the final decision output is assembled

- **blendedScore:** `convictionScore - portfolioFitPenalty`, clamped 0–1. Legacy field for `DecisionPolicySnapshot.blendedScore`.
- **policyState:** From block reason (BLOCK / REVIEW_REQUIRED), or action (EXIT, TRIM), or from blendedScore + size + review (ALLOW_HIGH_CONVICTION, ALLOW_NORMAL, ALLOW_SMALL, REVIEW_REQUIRED, BLOCK).
- **blockReason:** First eligibility blocker, or concentration block, or portfolio fit block, or market quality block.
- **sizeMultiplier / finalSuggestedSize:** From sizing stage.
- **reasoningJson:** Serialized `reasoningBreakdown` plus `policyState`, `sizeMultiplier`, `blockReason`, `blendedScore` for backward compatibility.

## Constraints

- Deterministic: same input → same output.
- Explainable: every stage has explicit reasons.
- No black-box blending: weights and thresholds are in code.
- Paper-trading only; no live trading enablement.
