# Paper relaxed candidate builder – implementation summary

## Problem

Relaxation-eligible BLOCK snapshots were correctly classified but **never reached shadow scoring** because they were dropped during candidate materialization:

1. **primaryActionType = avoid or sync_first** – the pipeline treated these as non–live-actionable and skipped them (incrementing `avoidedCount`) before asset resolution.
2. **Asset resolution** – only applied to candidates that had already passed the avoid/sync_first filter, so relaxed BLOCK candidates never got to asset/side/price derivation.

## Solution

A **paper-only derivation path** for already-eligible relaxed BLOCK snapshots that does not depend on live-actionability:

- Relaxed candidates (after `classifyPaperRelaxationEligibility` says `relaxed_block_candidate`) **bypass** the avoid/sync_first filter.
- A dedicated builder **derives** side/asset/price from recommendation + snapshot + synced market data; if derivation fails, the candidate is rejected with a structured reason and counted in diagnostics.

---

## Where candidates were previously dropped

- **File:** `lib/paper-trading/candidates.ts`
- **Place:** After setting `relaxedContext` for BLOCK+eligible snapshots, the next block was:
  ```ts
  if (rec.primaryActionType === "avoid" || rec.primaryActionType === "sync_first") {
    diag.avoidedCount!++;
    ...
    continue;
  }
  ```
  So **all** relaxed candidates (which often have avoid/sync_first) were discarded here and never reached asset resolution or scoring.

---

## Derivation fallback added

1. **New module:** `lib/paper-trading/relaxed-candidate-builder.ts`
   - **`buildRelaxedPaperCandidate(rec, snapshot, relaxedContext)`**  
     Resolves asset via `SyncedAsset` (marketId + outcome), derives side from `marketSignal.side`, price from `marketSignal.marketPrice`.  
     Returns `{ ok: true, candidate, derivationSource }` or `{ ok: false, rejectionReason }` where `rejectionReason` is one of:  
     `missingAssetResolution` | `missingSide` | `missingPriceContext` | `other`.

2. **Order of checks (fail-fast):**  
   marketId → side → price → asset lookup. So missing side/price is reported before hitting the DB.

3. **In candidates.ts:**  
   When `relaxedContext` is set we no longer run the avoid/sync_first filter for that rec. We call `buildRelaxedPaperCandidate`; on success we push the candidate and increment `relaxedBuiltSuccessfully`; on failure we increment the appropriate `relaxedDropped_*` and continue.

4. **Provenance:**  
   Every built relaxed candidate keeps: `paperPolicyMode`, `paperRelaxationReason`, `originalBlockingReasons`, `paperEligibilityVersion`, `sourceDecisionState`, `derivationSource` (and is stored on `PaperTrade` via existing columns + `metadataJson.derivationSource`).

---

## New diagnostics fields

| Field | Meaning |
|-------|--------|
| `relaxedCandidatesConsidered` | Number of BLOCK snapshots that were eligibility-accepted and entered the relaxed build path. |
| `relaxedDropped_actionTypeAvoid` | Reserved; not used (we no longer drop for avoid). |
| `relaxedDropped_actionTypeSyncFirst` | Reserved; not used (we no longer drop for sync_first). |
| `relaxedDropped_missingAssetResolution` | Relaxed build failed: no SyncedAsset for marketId+outcome. |
| `relaxedDropped_missingSide` | Relaxed build failed: missing or empty marketSignal.side. |
| `relaxedDropped_missingPriceContext` | Relaxed build failed: missing or empty marketSignal.marketPrice. |
| `relaxedDropped_other` | Relaxed build failed for another reason. |
| `relaxedBuiltSuccessfully` | Relaxed candidates that were built and added to the candidate list. |
| `relaxedScoredSuccessfully` | (Tick/engine) Count of relaxed candidates that were scored this tick (alias of `scoredAfterRelaxation`). |
| `relaxedOpenedTrades` | (Tick/engine) Count of paper trades opened from relaxed candidates this tick (alias of `paperTradesCreatedFromRelaxation`). |

Exposed in: **diagnostics API** (`GET /api/paper-trading/diagnostics`) and **paper-trading dashboard** (relaxed build section).

---

## Relaxed candidates now reach scoring

- **Before:** 224 eligibility-accepted relaxed snapshots were all dropped at avoid/sync_first → 0 candidates loaded → 0 scored.
- **After:** Same 224 enter the relaxed build path; all 224 built successfully (asset/side/price derived from recommendation + synced data) → 224 candidates loaded → 224 scored → 224 paper trades opened (until risk/cooldown limits apply in later runs).

Live execution is unchanged: no edits to execution policy, order generation, or action approval; only the **paper-trading candidate builder** was extended for already-eligible relaxed BLOCK snapshots.
