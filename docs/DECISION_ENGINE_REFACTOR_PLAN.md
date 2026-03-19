# Decision Engine Refactor Plan

## A. Current decision inputs

Every important input currently affecting decision results, with file/function references:

| Input | Source | File / function |
|-------|--------|------------------|
| **Heuristic score** | `rec.priorityScore` (from recommendation engine) | `lib/decision/recompute.ts` → `computeBlendedScore({ heuristicPriorityScore: rec.priorityScore })`; `lib/decision/blend.ts` `BlendInput.heuristicPriorityScore`. Originates in `lib/polymarket/recommendations.ts` `signalToRecommendation` / `signalToRecommendationV2`: `priorityScore = (|edge|*0.5 + confidence*0.3 + STRONG_BUY?0.2) * (NO_TRADE?0.1:1)`, then down-weighted by overlap/sync_first/near-resolution. |
| **ML score** | `rec.mlScore` (from score-live pipeline) | `lib/decision/recompute.ts` → `computeBlendedScore({ mlScore: rec.mlScore })`; `lib/decision/blend.ts`; `lib/ml/score-live.ts` `scoreLiveRecommendations` (optional denormalized update). |
| **News / catalyst** | `newsCatalystBoost`, `newsSaturationPenalty` | `lib/news/recommendation-influence.ts` `getNewsInfluenceByMarket`; `lib/decision/recompute.ts` fetches per market, passes to `computeBlendedScore`. |
| **Theme exposure %** | Portfolio risk snapshot → themeConcentrations | `lib/decision/recompute.ts`: `themeExposurePct` from portfolio risk `themeExposureMap`; used in blend and policy. |
| **Top theme concentration %** | Portfolio risk snapshot | `lib/decision/recompute.ts`: `topThemeConcentrationPct = portfolioRiskSnapshot.maxSingleThemeConcentrationPct`; `lib/decision/blend.ts` (blockers/supportive, concentrationPenalty); `lib/decision/policy.ts` (block, size multiplier). |
| **Behavior penalty** | `rec.marketSignal.behaviorPenalty` | `lib/decision/recompute.ts` → `computeBlendedScore`; `lib/decision/blend.ts` (blockers, blendedRaw). Set upstream in signal/recommendation pipeline. |
| **Portfolio penalty** | `rec.marketSignal.portfolioPenalty` | Same as behavior; `lib/decision/blend.ts` concentrationPenalty + portPen. |
| **Setup adjustment** | Setup performance profiles | `lib/decision/setup-performance.ts` `getSetupAdjustment(signalType, category, theme, reviewStatus)`; `lib/decision/recompute.ts` → `computeBlendedScore({ setupAdjustment })`; `lib/decision/blend.ts` (actedWinRate, overrideWinRate → setupAdjust, supportive/blockers). |
| **Review status** | `rec.review?.status` | `lib/decision/recompute.ts` → blend and policy; `lib/decision/blend.ts` (reviewAdjust, supportive/blockers); `lib/decision/policy.ts` (size multiplier, policy state). |
| **blockedReason** | `rec.blockedReason` | `lib/decision/recompute.ts` → `computeBlendedScore`, `applyPolicy`; `lib/decision/blend.ts` (blockers); `lib/decision/policy.ts` (blockReason → BLOCK/REVIEW_REQUIRED). Set in `lib/polymarket/recommendations.ts` (action logic, concentration, chase, liquidity, edge). |
| **qualityBlocker** | `rec.qualityBlocker` | Not currently passed into blend/policy; used in `lib/recommendations/explainability.ts` and `lib/polymarket/recommendations-recompute.ts`. Should be treated as eligibility blocker. |
| **Action** | `rec.action` | `lib/decision/recompute.ts` → `applyPolicy`; `lib/decision/policy.ts` (EXIT/TRIM/NO_TRADE/WATCH → state and size). |
| **Suggested size from rec** | `rec.suggestedSize` | `lib/decision/recompute.ts` → `applyPolicy({ suggestedSizeFromRec })`; `lib/decision/policy.ts` (finalSuggestedSize = suggestedSizeFromRec * sizeMultiplier). |
| **Signal type** | `rec.marketSignal.signalType` | `lib/decision/recompute.ts` → `applyPolicy({ signalType })`; `lib/decision/policy.ts` (CHASE_TYPES, chase block). |
| **Has existing position** | DB lookup per rec | `lib/decision/recompute.ts` (derivedPosition findUnique); `applyPolicy({ hasExistingPosition })`. |

Explainability / display: `lib/recommendations/explainability.ts` builds `RecommendationExplanation` from persisted recommendation (blockedReason, qualityBlocker, priorityScore, rationale, etc.); not part of the numeric decision path but consumes same fields.

---

## B. Suspected overlap / double-counting

| Area | Overlap | Notes |
|------|--------|--------|
| **Momentum vs catalyst/news** | Heuristic priorityScore already incorporates confidence; news catalyst/saturation are applied again in blend (add/penalize). Recommendation layer in `recommendations.ts` also applies `newsCatalystBoost`/`newsSaturationPenalty` to confidence before action. So news can affect (1) recommendation action/size, (2) priorityScore indirectly, (3) blend again. Risk of double-counting. |
| **Portfolio penalty vs concentration vs risk engine** | `portfolioPenalty` and `themeExposurePct`/`topThemeConcentrationPct` both feed blend (concentrationPenalty, blockers) and policy (block, size multiplier). Portfolio risk engine now provides structured concentration; blend still has its own concentrationPenalty formula and theme/block thresholds. Theme exposure is used in three places: blend blockers, blend concentrationPenalty, policy block/multiplier. |
| **blockedReason / qualityBlocker vs score** | `blockedReason` is pushed into blend as a blocker string and also drives policy `blockReason` directly. So the same condition can both reduce blended score (via blockers array and any downstream logic) and hard-block. qualityBlocker is not in blend; if we add it, should be eligibility-only (hard block), not score decay. |
| **Behavior vs portfolio fit** | Behavior penalty and portfolio penalty are both subtracted in blend and can add to blockers. Conceptually behavior could be “portfolio fit” (e.g. overtrading) vs “signal quality”; currently both are just numeric penalties. |
| **Confidence vs size multiplier** | Policy applies size multiplier from theme concentration, review status, ML/heuristic disagreement, and supportive reasons. Confidence is already inside heuristic priorityScore and ML score. So concentration and review reduce size again after score—appropriate, but the “disagreement” multiplier (ML < heuristic) mixes edge with sizing in one step. |
| **Setup history vs edge** | Setup adjustment (actedWinRate, overrideWinRate) changes blended score. That’s a form of “edge assessment” (historical edge by setup type) but is applied in the same blend as concentration/review. Clearer to treat setup as an edge modifier, then let portfolio/sizing stages act separately. |

---

## C. Proposed staged model

Explicit stages and outputs:

1. **Eligibility**
   - **Inputs:** blockedReason, qualityBlocker, reviewStatus (REJECTED → block), action (NO_TRADE/WATCH with block), required metadata presence.
   - **Output:** `eligible: boolean`, `blockers: string[]`, `warnings: string[]`.
   - **Rules:** Any hard blocker → not eligible; no sizing if not eligible.

2. **Edge assessment**
   - **Inputs:** heuristic (priorityScore), mlScore, news catalyst/saturation (as edge modifiers, not portfolio), setup adjustment (actedWinRate, overrideWinRate), confidence/edge from signal if needed.
   - **Output:** `edgeState: "high" | "medium" | "low" | "negative"`, `convictionScore: number` (or band), `edgeReasons: string[]`.
   - **Rules:** No concentration/sizing here; only thesis strength and historical setup performance.

3. **Market quality**
   - **Inputs:** liquidity (from signal or context), crowding/signalType (e.g. OVERCROWDED_THEME), news saturation (as market-quality signal), data completeness/stale.
   - **Output:** `marketQualityState: "ok" | "degraded" | "poor"`, `marketQualityReasons: string[]`, optional blockers/warnings.
   - **Rules:** Poor market quality can block or warn; separate from edge.

4. **Portfolio fit**
   - **Inputs:** themeExposurePct, topThemeConcentrationPct (from portfolio risk snapshot), behavior penalty, portfolio penalty, near-resolution, correlated exposure (from snapshot if available).
   - **Output:** `portfolioFitState: "ok" | "caution" | "block"`, `portfolioFitPenalty: number` (for sizing), `reasons: string[]`.
   - **Rules:** Can reduce or block sizing; does not change core edge.

5. **Sizing**
   - **Inputs:** Eligibility result, edge result, market quality, portfolio fit, action, suggestedSizeFromRec, review status.
   - **Output:** `suggestedSize: number`, `sizeMultiplier: number`, `sizingReasons: string[]`.
   - **Rules:** Blocked → 0; otherwise apply structured modifiers from portfolio fit and policy rules (concentration, review, chase).

6. **Explanation**
   - **Inputs:** All stage outputs.
   - **Output:** Ordered human-readable reasoning: blockers first, then edge, market quality, portfolio fit, sizing.

---

## D. Migration plan

- **Preserve old fields:** Keep `DecisionPolicySnapshot` (policyState, blendedScore, sizeMultiplier, finalSuggestedSize, reasoningJson). Build `reasoningJson` and blendedScore from staged outputs so existing consumers see same shape.
- **Backward compatibility:** Map staged `convictionScore`/edge band + modifiers into a single `blendedScore` (0–1) for storage; map stage blockers + reasons into `reasoningJson` structure that includes existing keys (blockers, supportive, policyState, blockReason, sizeMultiplier).
- **Isolate stages internally first:** Implement stages in `lib/decision/stages/*`; recompute calls stages in order, then assembles final decision and snapshot. No change to API or DB schema initially.
- **API shape:** Keep `GET` endpoints and any UI that read `reasoningJson` / policy state unchanged; populate from staged explanation and sizing outputs.

Low-risk rollout: (1) Add stage modules and a single `evaluateDecisionStaged()` that returns staged result + legacy-shaped output. (2) In recompute, call `evaluateDecisionStaged()` and write same DecisionPolicySnapshot fields from it. (3) Deprecate direct `computeBlendedScore` + `applyPolicy` in recompute once staged path is default. (4) Optionally add new fields (e.g. `stagedSummary`) to reasoningJson for operators without breaking existing parsers.
