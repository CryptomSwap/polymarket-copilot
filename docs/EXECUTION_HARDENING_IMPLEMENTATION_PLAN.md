# Execution Hardening Implementation Plan

**Source of truth:** `docs/PRODUCTION_READINESS_EXECUTION_ORDERS_RECONCILIATION_RISK.md`  
**Purpose:** Turn audit findings into a phased, concrete execution checklist. No re-audit.

---

## Phases Overview

| Phase | Focus | Scope |
|-------|--------|--------|
| **Phase 1** | Hard blockers before real money | Stale sweeper, reconciliation repairs, place idempotency, ExecutedOrder uniqueness, manual API/runtime consistency |
| **Phase 2** | Consistency / unification | Cancel API updates ExecutedOrder, reconciliation snapshot upsert, skip flags restriction, OrderIntent/CLOB ordering |
| **Phase 3** | Resilience, invariants, test hardening | Fill double-apply guard, journal/store safeguards, kill-switch persistence, invariant docs, critical tests |

---

## Schema Migration Tasks (Callout)

These tasks require Prisma schema and migrations. Handle before or within the PRs that depend on them.

| # | Task | Schema change | Migration notes |
|---|------|----------------|-----------------|
| M1 | ExecutedOrder uniqueness | Add `@@unique([funderAddress, polymarketOrderId])` to `ExecutedOrder` | Run duplicate check/cleanup before adding constraint; migration may fail if duplicates exist. |
| M2 | Place idempotency storage | Add `idempotencyKey String?` to `OrderIntent`; add `@@unique([funderAddress, idempotencyKey])` where idempotencyKey is not null (or use new table `PlaceIdempotencyResult` with funderAddress + idempotencyKey unique) | Prefer nullable unique partial index if supported; else new table. |
| M3 | OrderReconciliationSnapshot uniqueness | Add `@@unique([funderAddress, polymarketOrderId])` to `OrderReconciliationSnapshot` | Check for existing duplicates; merge or delete before constraint. |

---

## Phase 1: Hard Blockers Before Real Money

### Task 1.1 — Stale sweeper uses sweepAndApply

| Field | Content |
|-------|--------|
| **Title** | Wire periodic stale sweep to sweepAndApply so stale orders are marked canceled and order.stale is emitted |
| **Why it matters** | Today only `sweep()` runs; ghost/stale orders never leave the store and keep affecting workingOrderCount and exposure. |
| **Files to change** | `worker/stream-runtime.ts` |
| **Implementation notes** | Replace `this.deps.staleSweeper.sweep()` with `this.deps.staleSweeper.sweepAndApply()` in the staleSweepInterval callback (~line 499). No config flag required for Phase 1; sweeper already only updates store + lifecycle handler (no adapter.cancelOrder in paper). Document in code comment that for live mode, future work may call adapter.cancelOrder for orders we mark canceled. |
| **Migration/schema impact** | None |
| **Risks/regressions** | sweepAndApply calls lifecycleHandler.applyCancelAck for each stale recommendation; ensure lifecycle handler and store are the same ones used elsewhere so state stays consistent. No exchange call in paper. |
| **Acceptance criteria** | (1) Interval invokes sweepAndApply. (2) Stale orders (pending_submit no ack, working too old) transition to canceled in store. (3) order.stale events are emitted. (4) workingOrderCount decreases after sweep for stale orders. |
| **Tests required** | Integration test: create orders, advance time past stale thresholds, run sweepAndApply, assert store shows canceled and order.stale was emitted; assert adapter.cancelOrder not called when adapter is paper. |

---

### Task 1.2 — Runtime reconciliation applies repairs

| Field | Content |
|-------|--------|
| **Title** | Enable applyRepairs in periodic runtime reconciliation so ghost working orders are marked canceled when absent on exchange |
| **Why it matters** | Exchange is source of truth; local working orders not on exchange reserve exposure and skew risk until restart. |
| **Files to change** | `worker/stream-runtime.ts` |
| **Implementation notes** | In the reconcileInterval callback, call `runRuntimeReconciliation({ ..., applyRepairs: true })` instead of `applyRepairs: false`. Add a short log when repairs are applied (e.g. repairedOrders.length) so operators can see it. Optionally add a feature flag (env) to turn repairs off for a rollout window; default to true. |
| **Migration/schema impact** | None |
| **Risks/regressions** | If exchange snapshot is temporarily empty or wrong, we could mark valid orders canceled. Mitigation: reconciliation already runs every 60s and uses authoritative fetchOpenOrdersL2; ensure credentials and endpoint are correct. Watch for spike in repair_applied journal events. |
| **Acceptance criteria** | (1) When exchange has fewer open orders than local working orders, runRuntimeReconciliation with applyRepairs: true marks the correct local orders canceled. (2) repairedOrders is populated and journaled. (3) workingOrderCount drops for repaired orders. |
| **Tests required** | Test: mock exchange returning subset of local order ids; run runRuntimeReconciliation with applyRepairs: true; assert staleWorkingOrders are updated to canceled in store and repair events journaled. |

---

### Task 1.3 — ExecutedOrder uniqueness on (funderAddress, polymarketOrderId)

| Field | Content |
|-------|--------|
| **Title** | Add unique constraint so one exchange order id maps to at most one ExecutedOrder row |
| **Why it matters** | Prevents duplicate rows from bugs or retries; keeps reconciliation and analytics consistent. |
| **Files to change** | `prisma/schema.prisma`; migration script or one-off to remove duplicates if any. |
| **Implementation notes** | Add `@@unique([funderAddress, polymarketOrderId])` to model ExecutedOrder. Before deploying: query for duplicate (funderAddress, polymarketOrderId), decide merge/delete strategy, run cleanup. In code, ensure placeLimitOrder never creates a second ExecutedOrder for the same polymarketOrderId (idempotency in 1.4 will help). |
| **Migration/schema impact** | **Schema migration (M1).** New unique constraint; migration fails if duplicates exist. |
| **Risks/regressions** | Any code path that creates ExecutedOrder must respect uniqueness (e.g. upsert or check-before-create). placeLimitOrder is the only creator today; after 1.4 idempotency we avoid duplicate creation. |
| **Acceptance criteria** | (1) Schema has @@unique([funderAddress, polymarketOrderId]). (2) Migration runs successfully (after cleanup). (3) Attempt to create second ExecutedOrder with same (funderAddress, polymarketOrderId) fails or is upserted. |
| **Tests required** | Unit test: create ExecutedOrder, second create with same funder+polymarketOrderId throws or is no-op; test that place flow still creates one row on success. |

---

### Task 1.4 — Place API idempotency

| Field | Content |
|-------|--------|
| **Title** | Add idempotency key to place API so duplicate requests create at most one order and one ExecutedOrder |
| **Why it matters** | Double-clicks and retries must not create multiple orders; one logical request → one exchange order. |
| **Files to change** | `app/api/orders/place/route.ts`; `lib/polymarket/trading.ts`; `prisma/schema.prisma` (or new table). |
| **Implementation notes** | (1) Accept optional `idempotencyKey` in request body (or header Idempotency-Key). (2) If key provided: before creating OrderIntent, look up by (funderAddress, idempotencyKey). If found and order was placed (OrderIntent.status === 'placed' and ExecutedOrder exists), return 200 with existing orderIntentId/polymarketOrderId/executedOrderId (or 409 Conflict with same body per RFC). If found and failed, optionally allow retry (same key → same outcome). (3) If key not provided, behavior unchanged. (4) Store idempotencyKey on OrderIntent (nullable). Require unique (funderAddress, idempotencyKey) where idempotencyKey is not null—use partial unique index or new table. |
| **Migration/schema impact** | **Schema migration (M2).** Add `idempotencyKey String?` to OrderIntent; add unique constraint (e.g. @@unique([funderAddress, idempotencyKey]) with Prisma; if DB does not support partial unique, use a separate table PlaceIdempotencyResult(funderAddress, idempotencyKey, orderIntentId, polymarketOrderId, executedOrderId) and unique on (funderAddress, idempotencyKey). |
| **Risks/regressions** | Retries with same key must return same result without calling CLOB again. Ensure first request’s response is stored (e.g. in OrderIntent or PlaceIdempotencyResult) so second request can return it. |
| **Acceptance criteria** | (1) Two POST /api/orders/place with same idempotencyKey result in one OrderIntent, one ExecutedOrder, one CLOB order. (2) Second request returns 200 with same orderIntentId/polymarketOrderId/executedOrderId (or 409 with same body). (3) Without idempotencyKey, behavior unchanged. |
| **Tests required** | Test: two place requests with same idempotencyKey → one order, second response matches first. Test: same key after first failed → consistent behavior (retry or reject). Test: no key → two requests create two orders. |

---

### Task 1.5 — Manual API / runtime store consistency

| Field | Content |
|-------|--------|
| **Title** | When manual place/cancel is allowed by execution policy, sync outcomes into runtime order store so exposure and working count are accurate |
| **Why it matters** | Today manual orders are not in the runtime store; guardrails and exposure see an incomplete picture until restart. |
| **Files to change** | `lib/polymarket/trading.ts`; `app/api/orders/place/route.ts`; `app/api/orders/cancel/route.ts`; mechanism to reach runtime order store (see notes). |
| **Implementation notes** | Runtime runs in worker; API runs in Next.js. Options: (A) Pass an optional callback or “runtime sync” service into trading that the API route sets when worker is in same process (e.g. in dev or when API and worker are co-located). (B) Publish to a durable channel (e.g. DB table or queue) that the worker polls and applies to orderStore. (C) Document that manual orders are out-of-band and add a separate exposure read that includes ExecutedOrder open count when manual is enabled. Recommended minimum for Phase 1: Implement (A) or (B) so that on successful placeLimitOrder we create/ack an order in the runtime store (clientOrderId could be orderIntentId or a new id), and on successful cancelOrderByPolymarketId we apply cancel to the runtime order that has that exchangeOrderId. Worker must be able to apply these updates to its orderStore—e.g. via a shared interface (inject orderStore updater into API path) or via a small “pending manual order events” table the worker drains. Start with (A) if API and worker share process; else (B) with a single table ManualOrderEvent(funderAddress, eventType: place_acked | canceled, orderIntentId?, polymarketOrderId, payloadJson, createdAt) and worker polling or server-sent drain. |
| **Migration/schema impact** | If (B): new table and migration. If (A): none. |
| **Risks/regressions** | Do not run manual path when execution policy disallows manual (current state); so this task only activates when liveOrManualExecutionAllowed is true. Ensure duplicate application of same event is idempotent (e.g. by polymarketOrderId). |
| **Acceptance criteria** | (1) When manual execution is allowed and place succeeds, runtime order store gains a working order for that exchange order (or equivalent). (2) When manual execution is allowed and cancel succeeds, runtime store marks that order canceled. (3) workingOrderCount and exposure reflect manual orders. (4) When manual execution is disabled, no change in behavior. |
| **Tests required** | Test: with sync enabled and policy allowing manual, place order → runtime store has order; cancel → store shows canceled. Test: with policy disallowing manual, no sync calls. |

---

## Phase 2: Consistency / Unification Fixes

### Task 2.1 — Cancel API updates ExecutedOrder

| Field | Content |
|-------|--------|
| **Title** | Update ExecutedOrder.status (and optionally OrderIntent) when cancelOrderByPolymarketId succeeds |
| **Why it matters** | ExecutedOrder and UserOrder currently diverge on cancel; DB reconciliation and reporting are inconsistent. |
| **Files to change** | `lib/polymarket/trading.ts` |
| **Implementation notes** | After successful client.cancelOrder, find ExecutedOrder by funderAddress + polymarketOrderId; if found, update status to "cancelled". Optionally update linked OrderIntent.status to "cancelled" or "failed". Keep existing UserOrder update. |
| **Migration/schema impact** | None |
| **Risks/regressions** | None expected; additive update. |
| **Acceptance criteria** | After cancelOrderByPolymarketId success, ExecutedOrder.status is "cancelled" and UserOrder.status is "cancelled". |
| **Tests required** | Test: cancel by polymarket order id → ExecutedOrder and UserOrder both show cancelled. |

---

### Task 2.2 — OrderReconciliationSnapshot upsert and uniqueness

| Field | Content |
|-------|--------|
| **Title** | Use upsert with unique (funderAddress, polymarketOrderId) so one row per order and no duplicate rows |
| **Why it matters** | findFirst then update/create is racy; duplicate snapshots can appear. |
| **Files to change** | `prisma/schema.prisma`; `lib/polymarket/reconcile.ts` |
| **Implementation notes** | Add @@unique([funderAddress, polymarketOrderId]) to OrderReconciliationSnapshot (M3). In reconcileOrders, use prisma.orderReconciliationSnapshot.upsert with where (funderAddress, polymarketOrderId) and create/update data. Handle migration: remove or merge duplicates before adding constraint. |
| **Migration/schema impact** | **Schema migration (M3).** |
| **Risks/regressions** | Existing code that creates snapshots must use upsert or single writer. |
| **Acceptance criteria** | At most one snapshot row per (funderAddress, polymarketOrderId); concurrent reconcile runs do not create duplicates. |
| **Tests required** | Test: two reconcile runs for same order result in one snapshot row (last write wins or deterministic merge). |

---

### Task 2.3 — Restrict or audit skipBlockedCheck / skipPreflightCheck

| Field | Content |
|-------|--------|
| **Title** | Restrict place API skip flags to operator-only or remove for production; log and audit every use |
| **Why it matters** | Unrestricted skip allows bypassing concentration/safety and preflight. |
| **Files to change** | `app/api/orders/place/route.ts` |
| **Implementation notes** | Option A: Remove skipBlockedCheck and skipPreflightCheck from body schema for production. Option B: Require an operator secret or role (e.g. header or server-side role check); when skip is used, log to audit table or structured log (funder, orderIntentId, skipFlags, timestamp). Prefer A for production; B if overrides are required with audit. |
| **Migration/schema impact** | None (or new audit log table if B). |
| **Risks/regressions** | Clients that currently send skip flags will break if removed; communicate and version if needed. |
| **Acceptance criteria** | (1) Production build does not accept skip flags, or (2) skip only works with operator auth and every use is logged. |
| **Tests required** | Test: without operator auth, skip flags are ignored or request rejected. Test: with operator auth, use is logged. |

---

### Task 2.4 — OrderIntent creation after CLOB outcome (optional ordering)

| Field | Content |
|-------|--------|
| **Title** | Create OrderIntent only after CLOB success, or clearly separate pending/placed/failed in one place |
| **Why it matters** | Reduces orphan intents and clarifies state when CLOB fails or times out. |
| **Files to change** | `lib/polymarket/trading.ts` |
| **Implementation notes** | Option A: Call CLOB first; on success create OrderIntent (status placed) + ExecutedOrder; on failure create OrderIntent (status failed). Option B: Keep current order but add a single “place outcome” update path so intent is created once and updated to placed/failed after CLOB. Ensures one intent per logical place and clear terminal state. |
| **Migration/schema impact** | None |
| **Risks/regressions** | If CLOB succeeds but we fail before persisting, we have an order on exchange with no OrderIntent/ExecutedOrder; add retry or reconciliation that can attach to existing exchange order. |
| **Acceptance criteria** | No OrderIntent with status placed without corresponding ExecutedOrder; failed intents are explicitly failed. |
| **Tests required** | Test: CLOB success → one OrderIntent placed, one ExecutedOrder. Test: CLOB failure → OrderIntent failed, no ExecutedOrder. |

---

## Phase 3: Resilience, Invariants, and Test Hardening

### Task 3.1 — Fill double-apply guard

| Field | Content |
|-------|--------|
| **Title** | Ensure position update path always uses fill ledger for dedupe when exchangeFillId present; add test for same-fill replay |
| **Why it matters** | Prevents double-apply to position when the same fill is delivered twice (e.g. reconnect replay). |
| **Files to change** | `worker/stream-runtime.ts` (order.partial_fill / order.filled handlers); tests. |
| **Implementation notes** | Audit all paths that call positionUpdater.applyFill: (1) When exchangeFillId is present, always go through recordFill → apply → markFillAppliedToPosition and skip apply if !recorded. (2) When exchangeFillId is absent (e.g. paper), consider a synthetic id (e.g. clientOrderId + fillSeq or event id) and a small in-memory “applied fill ids” set with TTL to dedupe. Add a test that delivers the same fill event twice and asserts position updated once. |
| **Migration/schema impact** | None |
| **Risks/regressions** | Paper path without exchangeFillId could change behavior if we add synthetic dedupe; scope to same process/session. |
| **Acceptance criteria** | Same (funderAddress, exchangeFillId) applied twice results in one position update; test passes. |
| **Tests required** | Fill ledger dedupe test; concurrent or replay same-fill test. |

---

### Task 3.2 — Order store create reject duplicate clientOrderId

| Field | Content |
|-------|--------|
| **Title** | Reject or return existing when create() is called with an existing clientOrderId |
| **Why it matters** | Prevents accidental overwrite of an existing order. |
| **Files to change** | `lib/runtime/order-manager/order-lifecycle-store.ts` |
| **Implementation notes** | In create(), if byClientId.has(params.clientOrderId), either throw (e.g. "Order already exists") or return existing clone. Prefer throw for fail-fast. |
| **Migration/schema impact** | None |
| **Risks/regressions** | Any caller that assumed create overwrites would break; current callers generate new clientOrderIds so no expected break. |
| **Acceptance criteria** | create() with existing clientOrderId throws or returns existing; new clientOrderId creates as today. |
| **Tests required** | Test: create twice with same clientOrderId → second throws or returns same. |

---

### Task 3.3 — Invariant documentation

| Field | Content |
|-------|--------|
| **Title** | Add explicit invariant documentation (order store, fill ledger, position store, exposure, reconciliation, execution policy, kill switch) |
| **Why it matters** | So future changes and reviews can check against a single source of truth. |
| **Files to change** | New doc or section in `docs/PRODUCTION_READINESS_EXECUTION_ORDERS_RECONCILIATION_RISK.md` or `docs/EXECUTION_INVARIANTS.md` |
| **Implementation notes** | Copy Section F from the audit into a dedicated EXECUTION_INVARIANTS.md (or append to audit doc). Add one-line references in code (e.g. order-lifecycle-store.ts: “Invariant: filledSize <= size. See docs/EXECUTION_INVARIANTS.md.”). |
| **Migration/schema impact** | None |
| **Risks/regressions** | None |
| **Acceptance criteria** | All invariants from audit Section F are documented and referenced where enforced. |
| **Tests required** | None (docs). |

---

### Task 3.4 — Critical tests checklist

| Field | Content |
|-------|--------|
| **Title** | Add or extend tests for: stale sweeper sweepAndApply, reconciliation applyRepairs, fill ledger dedupe, place idempotency, cancel updates ExecutedOrder, exposure/working count |
| **Why it matters** | Prevents regressions on production-critical paths. |
| **Files to change** | `lib/runtime/order-manager/__tests__` (or equivalent); `lib/runtime/reconciliation/__tests__`; `lib/live/__tests__`; `lib/polymarket/__tests__` or API route tests; `lib/runtime/__tests__` for exposure. |
| **Implementation notes** | Implement tests listed in audit Section E and in each task above. Prefer integration tests where behavior crosses modules. |
| **Migration/schema impact** | None |
| **Risks/regressions** | None |
| **Acceptance criteria** | All tests from audit E and from Phase 1/2 task “Tests required” exist and pass. |
| **Tests required** | See audit E and per-task sections. |

---

## A. Ordered Implementation Plan (Smallest Safe Order)

Execution order that keeps the system in a better state after each step and minimizes dependency clashes:

| Order | Task | Phase | Deps | Rationale |
|-------|------|--------|------|-----------|
| 1 | **1.1** Stale sweeper sweepAndApply | 1 | None | No schema; single call-site change; immediately reduces ghost order impact. |
| 2 | **1.2** Runtime reconciliation applyRepairs | 1 | None | No schema; single flag; clears ghost working orders every 60s. |
| 3 | **1.3** ExecutedOrder uniqueness (M1) | 1 | None | Schema + cleanup; must be in place before idempotency so we never create duplicate rows. |
| 4 | **1.4** Place API idempotency (M2) | 1 | 1.3 | Depends on M1 so that idempotent return of “existing” order does not conflict with unique constraint. |
| 5 | **1.5** Manual API / runtime store consistency | 1 | None (policy still disallows manual) | Can be implemented and tested behind policy; activates when manual is enabled. |
| 6 | **2.1** Cancel API updates ExecutedOrder | 2 | None | Simple consistency fix; no schema. |
| 7 | **2.2** OrderReconciliationSnapshot upsert (M3) | 2 | None | Schema + reconcile.ts; removes race. |
| 8 | **2.3** Restrict skip flags | 2 | None | Route-only; low risk. |
| 9 | **2.4** OrderIntent/CLOB ordering | 2 | 1.4 | Optional; improves clarity after idempotency exists. |
| 10 | **3.1** Fill double-apply guard | 3 | None | Reduces race risk. |
| 11 | **3.2** Order store create reject duplicate | 3 | None | Small guard. |
| 12 | **3.3** Invariant documentation | 3 | None | Docs only. |
| 13 | **3.4** Critical tests | 3 | All above | Validate all paths. |

---

## B. Recommended First PR

**Scope:** Phase 1 behavior fixes that require no schema change and unblock the rest.

**Includes:**
- **Task 1.1** — Stale sweeper uses sweepAndApply (worker/stream-runtime.ts).
- **Task 1.2** — Runtime reconciliation applyRepairs: true (worker/stream-runtime.ts).

**Out of scope for this PR:** Schema changes, place API, manual API sync.

**Why first:** Low risk; two call-site changes; immediately improves correctness of working order set and exposure. Easy to review and roll back.

**Acceptance:** Stale orders are marked canceled and order.stale emitted; ghost working orders are repaired every 60s; existing tests pass; new tests for 1.1 and 1.2 (see task tables).

---

## C. Recommended Second PR

**Scope:** Schema migrations (M1, M2) and place idempotency; ExecutedOrder consistency.

**Includes:**
- **Task 1.3** — ExecutedOrder @@unique([funderAddress, polymarketOrderId]) (prisma schema + migration + duplicate cleanup).
- **Task 1.4** — Place API idempotency (schema M2: OrderIntent.idempotencyKey or new table; route + trading.ts).
- **Task 2.1** — Cancel API updates ExecutedOrder (trading.ts).

**Why second:** M1 must land before or with idempotency so we never insert a second ExecutedOrder for the same exchange order. M2 enables idempotency storage. Cancel update is a small add-on that uses the same ExecutedOrder model.

**Pre-requisites:** First PR merged. No duplicate (funderAddress, polymarketOrderId) in ExecutedOrder (cleanup in migration or separate script).

**Acceptance:** Unique constraint on ExecutedOrder; place with same idempotencyKey returns existing result and does not create second order; cancel updates ExecutedOrder.status; tests for 1.3, 1.4, 2.1 pass.

---

## D. Final Validation Checklist Before Real-Money Enablement

Before enabling real money (live orders), complete and verify:

**Phase 1 (all done):**
- [ ] Stale sweeper runs sweepAndApply on the interval; stale orders become canceled and order.stale is emitted.
- [ ] Runtime reconciliation runs with applyRepairs: true; ghost working orders are marked canceled.
- [ ] ExecutedOrder has @@unique(funderAddress, polymarketOrderId); migration applied; no duplicates.
- [ ] Place API supports idempotency key; duplicate key returns existing result and does not create a second order.
- [ ] Manual API/runtime store sync implemented and tested (or documented as out-of-band and exposure strategy defined).

**Phase 2 (recommended):**
- [ ] Cancel API updates ExecutedOrder.status (and optionally OrderIntent).
- [ ] OrderReconciliationSnapshot has unique (funderAddress, polymarketOrderId) and reconcile uses upsert.
- [ ] skipBlockedCheck / skipPreflightCheck restricted or audited.

**Phase 3 (recommended):**
- [ ] Fill double-apply guarded (ledger + optional synthetic dedupe for paper).
- [ ] Order store create rejects duplicate clientOrderId.
- [ ] Invariants documented (EXECUTION_INVARIANTS.md or equivalent).
- [ ] Critical tests (audit Section E + per-task) implemented and passing.

**Cross-cutting:**
- [ ] No code path creates ExecutedOrder without respecting (funderAddress, polymarketOrderId) uniqueness.
- [ ] Execution policy and kill switch behavior documented and verified (no live orders when policy disallows).
- [ ] Runbooks for: duplicate ExecutedOrder cleanup (if ever), reconciliation repair rollback (set applyRepairs false), idempotency key TTL or cleanup if stored indefinitely.

---

*End of implementation plan.*
