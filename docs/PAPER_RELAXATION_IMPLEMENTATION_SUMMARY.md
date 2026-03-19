# Paper-only policy relaxation – implementation summary

## Overview

Paper trading can now score and open paper trades from a narrow allowlisted subset of **BLOCK** staged decisions (salvaged candidates) without changing any real execution behavior. Blocked candidates with `finalSuggestedSize = 0` receive a conservative paper-only stake and full provenance for dashboard and analytics.

---

## Files changed

| File | Change |
|------|--------|
| `lib/paper-trading/paper-relaxation.ts` | **New.** Eligibility classification, allowlist, disallowed patterns, `getRelaxedPaperStake()`, `parseBlockingReasonsFromSnapshot()`. |
| `lib/paper-trading/candidates.ts` | BLOCK branch replaced with paper-relaxation flow; derived candidates get relaxed stake and provenance; new diagnostics counters. |
| `lib/paper-trading/engine.ts` | Persist `sourceDecisionState`, `paperPolicyMode`, `paperRelaxationReason`, `originalBlockingReasons`, `paperEligibilityVersion` on create; tick result includes `scoredAfterRelaxation`, `paperTradesCreatedFromRelaxation`; loadDiagnostics includes new counters. |
| `prisma/schema.prisma` | `PaperTrade`: added optional `sourceDecisionState`, `paperPolicyMode`, `paperRelaxationReason`, `originalBlockingReasons`, `paperEligibilityVersion`; index on `paperPolicyMode`. |
| `prisma/migrations/20260316200000_paper_trade_relaxation_provenance/migration.sql` | **New.** Additive migration for the above columns. |
| `app/api/paper-trading/diagnostics/route.ts` | Expose last-tick relaxation counters and DB aggregates: `paperTradeCountByPolicyMode`, `relaxedTradeCountByReason`, and all new diagnostics fields. |
| `app/api/paper-trading/summary/route.ts` | Add `pnlByPolicyMode` (normal vs `relaxed_block_candidate`: count, win/loss, avg/cumulative PnL). |
| `app/(dashboard)/paper-trading/page.tsx` | Diagnostics: show blocked/eligible/rejected/accepted-by-reason, scored/opened from relaxation, counts by mode and by reason; new “PnL by policy mode” card. |
| `lib/paper-trading/__tests__/paper-relaxation.test.ts` | **New.** Unit tests for eligibility, rejection, stake, and constants. |

---

## Eligibility rule (exact)

- **Eligible** only when **all** of:
  1. `policyState === "BLOCK"`
  2. `finalSuggestedSize` is 0 or non-actionable (parsed as ≤ 0)
  3. At least one blocking reason exists (from `reasoningJson`: `blockReason` + `blockers[]`)
  4. **Every** blocking reason is in the allowlist (see below)
  5. **No** blocking reason is disallowed (exact or pattern match)

- **Allowlist** (only these two):
  - `"Edge too small for action."`
  - `"Liquidity too low for suggested size."`

- **Explicitly not allowed:**  
  `"Market crowded or low liquidity."` (exact), and any reason matching disallowed patterns: portfolio, theme concentration, behavior, review, eligibility, risk, exposure, saturation, no-trade/watch, etc. (see `DISALLOWED_PATTERNS` and `DISALLOWED_REASONS_EXACT` in `paper-relaxation.ts`).

- **Mixed blockers:** If any one reason is not allowlisted or is disallowed, the decision is **rejected** (no salvage).

---

## Paper stake rule for relaxed candidates (exact)

- **Function:** `getRelaxedPaperStake()` in `lib/paper-trading/paper-relaxation.ts`.
- **Behavior:** Returns a fixed conservative notional (e.g. `"10"`) for paper-only use.
- **Isolation:** Used only for salvaged BLOCK candidates when building the paper candidate’s `intendedSize`. Not used by live sizing or real execution.

---

## New diagnostics fields

- **From last tick / loadDiagnostics:**  
  `recommendationsFound`, `afterNormalPolicyFilter` (same as `afterPolicyFilter`), `blockedCandidatesSeen`, `paperRelaxationEligible`, `paperRelaxationRejected`, `paperRelaxationAccepted_edgeTooSmall`, `paperRelaxationAccepted_liquidityTooLow`, `paperRelaxationAccepted_multiAllowed`, `scoredAfterRelaxation`, `paperTradesCreatedFromRelaxation`.

- **From diagnostics API (DB):**  
  `paperTradeCountByPolicyMode` (normal / relaxed_block_candidate), `relaxedTradeCountByReason` (counts by `paperRelaxationReason`).

- **From summary API:**  
  `pnlByPolicyMode`: for `normal` and `relaxed_block_candidate`, closed-trade count, win/loss counts, average PnL %, cumulative PnL %.

---

## Design notes

- The original staged decision is **never** mutated; a separate paper-only derived context (and candidate) is created with `paperPolicyMode`, `paperRelaxationReason`, `originalBlockingReasons`, `paperEligibilityVersion`, `sourceDecisionState`, and effective paper stake.
- Real execution behavior, live order generation, and staged decision approval semantics are **unchanged**; only the paper candidate list and PaperTrade persistence are affected.
- Provenance is stored on `PaperTrade` (and in `metadataJson` for backward compatibility) so dashboard and analytics can distinguish normal vs salvaged paper trades and report PnL by mode.
