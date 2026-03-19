# Architecture Consolidation

## Purpose

This document describes the cleanup and consolidation pass that makes the **execution ledger** and the **staged decision engine** the clear primary paths, and clarifies what is deprecated or secondary so the codebase is harder to misuse and easier to audit.

## Current authoritative components

| Component | Role |
|-----------|------|
| **Execution ledger** (lib/execution-ledger) | Authoritative durable record for order lifecycle: OrderIntent, OrderIntentEvent, ExecutedOrder, ExecutedOrderEvent, CancelRequest, ReplaceRequest, FillLedgerEntry. All runtime order/fill/cancel/replace persistence should go through the execution-ledger service where applicable. |
| **Staged decision engine** (lib/decision/evaluate-staged.ts, lib/decision/stages/*) | Active decision path for recommendation evaluation. Recompute uses only this path; it produces policy state, size, and reasoning for DecisionPolicySnapshot. |
| **Execution policy** (lib/execution-policy) | Pre-trade safety gate. Runtime evaluates it before submitting to the order manager; result is persisted on OrderIntent when allowed. |
| **Runtime safety** (lib/runtime-safety) | Central state machine for trading operations (normal/degraded/blocked/kill_switch). Feeds into execution policy. |
| **Portfolio risk engine** (lib/portfolio-risk) | Deterministic risk snapshot (exposure, concentration, etc.). Used by decision stages and execution policy. |

## What was cleaned up

- **Decision layer:** Legacy **blend.ts** and **policy.ts** are **deprecated**. They are not used by recompute; the staged engine (evaluate-staged.ts + stages) is the only active path. Deprecation comments were added; the files were kept for reference. Recompute comment updated to state it uses the staged engine only.
- **Journal:** The order lifecycle journal (lib/runtime/journal/order-lifecycle-journal.ts) is documented as a **secondary operator trace**. The execution ledger is the authoritative lifecycle persistence layer. Journal entries are supplementary and must not contradict the ledger; when both are written, meanings are aligned.
- **API/docs:** The lifecycle-history API (GET /api/orders/lifecycle-history) comment was updated to state it returns the “secondary operator trace” and that the execution ledger is authoritative for lifecycle.
- **Fill ledger:** lib/live/fill-ledger.ts is documented as **legacy**. The preferred path is the execution-ledger service (recordFillAndReturnDedupResult, getAppliedFillsForRebuild). The runtime fill path uses execution-ledger; this module remains for debug scripts and some tests.
- **Trading (API) path:** lib/polymarket/trading.ts is documented as a **bypass**: it creates/updates OrderIntent and ExecutedOrder via Prisma directly. The runtime path uses the execution-ledger service. Refactoring trading.ts to use the execution-ledger is recommended for full audit consistency.

## What was removed vs deprecated

- **Removed:** No files were deleted. Consolidation preferred deprecation and documentation to avoid breaking callers (tests, scripts, API).
- **Deprecated (kept):**
  - **lib/decision/blend.ts** – @deprecated; do not use in new code; recompute does not use it.
  - **lib/decision/policy.ts** – @deprecated; do not use in new code; recompute does not use it.
  - **lib/live/fill-ledger.ts** – Documented as legacy; new code should use execution-ledger.
- **Bypass (documented, not removed):**
  - **lib/polymarket/trading.ts** – Direct Prisma writes for OrderIntent/ExecutedOrder; future refactor to use execution-ledger.

## Remaining intentional legacy areas

- **Journal:** Still written by runtime, paper order manager, reconciliation, lifecycle handler, stale sweeper, rebuild. It remains useful for operator event traces and existing APIs. It is explicitly **not** the source of truth; the ledger is.
- **lib/live/fill-ledger.ts:** Still used by debug-fill-ledger script and some tests (UnappliedFillEntry type, getFillsForRebuild). Migration to execution-ledger types/APIs can be done later.
- **lib/polymarket/trading.ts:** API/manual order placement path. Preserved for backward compatibility; refactor to execution-ledger is recommended when feasible.

## Recommended future cleanup order

1. **Refactor trading.ts** to create/update intents and executed orders via execution-ledger service so the API path shares the same audit trail as the runtime.
2. **Migrate fill-ledger consumers** (debug script, tests) to execution-ledger types and getAppliedFillsForRebuild/getReplayableUnappliedFills where applicable; then deprecate or remove lib/live/fill-ledger.ts.
3. **Optional:** Remove lib/decision/blend.ts and policy.ts once no remaining references exist (currently only policy imports blend; no other callers).
4. **Optional:** If lifecycle-history API should serve ledger data, add an endpoint or mode that returns execution timeline (getIntentTimeline) and document the journal API as legacy trace only.
