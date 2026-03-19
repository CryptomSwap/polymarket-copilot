# Root cause: intents blocked by reconciliation_stale in paper mode

## Summary

After paper-mode freshness and market-health relaxations, intents are still blocked by guardrails with `blockingReasonCodes: ["reconciliation_stale"]`. The guardrail uses `reconciliationFresh`, which is derived from `lastRuntimeReconciliationAt` and `lastRuntimeReconciliationStatus === "ok"`. In paper mode, reconciliation often never reports success (e.g. no credentials, L2 fetch fails, or interval skipped), so `lastRuntimeReconciliationOk` stays false and every intent is blocked.

## Runtime reconciliation flow (end to end)

### Scheduler / interval

- **Where:** `worker/stream-runtime.ts`, inside `start()` after deps are created.
- **What:** `this.reconcileInterval = setInterval(() => { ... }, RUNTIME_RECONCILE_INTERVAL_MS)` with `RUNTIME_RECONCILE_INTERVAL_MS = 60_000` (60s).
- **Each tick:** Async callback runs; resolves `funderAddr` (funder || options.funderAddress || getFunderForRecompute()); if `!deps || !funderAddr` it returns without calling reconciliation or updating diagnostics. Otherwise it calls `runRuntimeReconciliation({...})`.

### runRuntimeReconciliation()

- **Where:** `lib/runtime/reconciliation/runtime-reconciliation.ts`.
- **Success path:** Fetches credentials via `getStoredCredentials()`; if none, returns `{ success: false, error: "No stored credentials" }`. Otherwise calls `fetchOpenOrdersL2(l2Creds)`; on success, compares exchange orders with `orderStore`, builds result, returns `{ success: true, ... }`.
- **Failure paths:** (1) No stored credentials → `success: false`, `error: "No stored credentials"`. (2) Any thrown error (e.g. L2 API failure) → caught, returns `{ success: false, error: message }`.

### recordRuntimeReconciliationRun() / recordRuntimeReconciliationFailure()

- **Where:** `lib/runtime/telemetry/runtime-diagnostics.ts`.
- **Run:** `recordRuntimeReconciliationRun()` sets `lastRuntimeReconciliationAt = new Date()`, `lastRuntimeReconciliationStatus = "ok"`.
- **Failure:** `recordRuntimeReconciliationFailure()` sets `lastRuntimeReconciliationAt = new Date()`, `lastRuntimeReconciliationStatus = "failure"`.

### Diagnostics fields

- **lastRuntimeReconciliationAt:** Set by both Run and Failure. Remains null only if the reconcile interval never invokes `runRuntimeReconciliation` (e.g. early return when `!deps || !funderAddr`).
- **lastRuntimeReconciliationStatus:** `"ok"` only after a successful run and a call to `recordRuntimeReconciliationRun()`; otherwise `"failure"` (after failure) or null (if no run/failure ever recorded).

### Why lastRuntimeReconciliationOk remains false in paper mode

1. **Reconciliation not running:** Interval returns early when `!funderAddr` (e.g. funder not set and `getFunderForRecompute()` returns null/empty). Then neither Run nor Failure is called, so `lastRuntimeReconciliationStatus` stays null and `lastRuntimeReconciliationAt` stays null.
2. **Reconciliation running but failing:** Credentials missing or L2 fetch fails → `runRuntimeReconciliation` returns `success: false` → worker calls `recordRuntimeReconciliationFailure()` → `lastRuntimeReconciliationStatus = "failure"` → `lastRuntimeReconciliationOk` is false.
3. **Success not recorded:** Only `result.success === true` triggers `recordRuntimeReconciliationRun()`. So any failure (no creds, throw, or L2 error) means success is never recorded.
4. **Exchange-truth dependency:** Reconciliation requires credentials and a successful L2 open-orders fetch. In paper mode, credentials may be missing or L2 may be unavailable/invalid, so reconciliation is not appropriate as a hard gate for shadow-only intent collection.

## Diagnostics added

- **Runtime reconciliation tick:** Logged every interval with `hasDeps`, `hasFunderAddress`.
- **Runtime reconciliation skipped:** When `!deps || !funderAddr`, with `reason: "no_deps" | "no_funder_address"`.
- **Runtime reconciliation success:** When `result.success` and after `recordRuntimeReconciliationRun()`, with `recordedRun: true`, `reconcileDurationMs`, `driftDetected`.
- **Runtime reconciliation failed:** When `!result.success`, with `error`, `recordedFailure: true`, `lastRuntimeReconciliationStatusAfter: "failure"`.
- **Runtime reconciliation threw:** In catch, with `error`, `recordedFailure: true`, `lastRuntimeReconciliationStatusAfter: "failure"`.

Use these to see whether the interval runs, whether it is skipped, and whether each run succeeds or fails (and why).

## Minimal safe fix (paper mode only)

**Relax reconciliation freshness for guardrails when in paper mode and there are no open orders.**

- **Rationale:** Reconciliation is used to keep exchange order state in sync with the runtime. When there are no open/working orders, there is nothing to sync; requiring a successful reconciliation run is unnecessary for allowing shadow-only intents.
- **Change:** In the `order.intent.created` handler, when building `reconciliationFreshForGuardrails` for paper mode, use:
  - `(!!lastRecAt && lastRecOk) || openOrders.length === 0`
  - So: in paper mode, reconciliation is considered fresh if we have had at least one successful run **or** there are zero open orders.
- **Live mode:** Unchanged; `reconciliationFresh` still uses the strict time-based and status checks. No change to guardrail logic for non–paper mode.

## Files changed

- **`worker/stream-runtime.ts`**
  - Reconcile interval: log "Runtime reconciliation tick" (hasDeps, hasFunderAddress); on skip log "Runtime reconciliation skipped" with reason; on success log "Runtime reconciliation success" with recordedRun, reconcileDurationMs, driftDetected; on failure log "Runtime reconciliation failed" with error and recordedFailure; in catch log "Runtime reconciliation threw" with error and recordedFailure.
  - Intent handler: set `reconciliationFreshForGuardrails = paperMode ? ((!!lastRecAt && lastRecOk) || openOrders.length === 0) : reconciliationFresh` so that in paper mode with no open orders we treat reconciliation as fresh.

## How to verify

1. Run worker in paper mode: `npm run worker`.
2. In logs, confirm:
   - Every ~60s: "Runtime reconciliation tick" with `hasDeps: true`, `hasFunderAddress: true` (or false if funder missing).
   - If skipped: "Runtime reconciliation skipped" with reason.
   - If run: either "Runtime reconciliation success" (then `lastRuntimeReconciliationStatus` becomes "ok") or "Runtime reconciliation failed" / "Runtime reconciliation threw" with error.
3. With the fix, in paper mode with **no open orders**, intents should no longer be blocked by `reconciliation_stale` (guardrails receive `reconciliationFresh: true`).
4. Run `npm run check:shadow-pipeline` (or equivalent): expect `allowed` / `submitted` / `evaluated` to increase when there are no open orders in paper mode.

**Exact verification command:**

```bash
npm run worker
```

Then inspect logs for the reconciliation messages above. If reconciliation is skipped (no funder), ensure funder is set or that paper mode is still allowed with no open orders (the new relaxation covers that). If reconciliation runs but fails (e.g. "No stored credentials"), the relaxation ensures that with zero open orders, intents are not blocked by `reconciliation_stale`.

## Evidence that allowed/submitted ShadowCandidates become reachable

- **Before:** All intents blocked by `reconciliation_stale` when `lastRuntimeReconciliationOk` was false (reconciliation never succeeded or never ran). `reconciliationFreshForGuardrails` was false whenever there was no successful reconciliation.
- **After:** In paper mode, when `openOrders.length === 0`, `reconciliationFreshForGuardrails` is true regardless of reconciliation success. Guardrails no longer add `RECONCILIATION_STALE` for those intents, so they can be allowed and submitted as ShadowCandidates. Live mode and the case with open orders in paper mode still require a successful reconciliation (or existing strict logic) as before.
