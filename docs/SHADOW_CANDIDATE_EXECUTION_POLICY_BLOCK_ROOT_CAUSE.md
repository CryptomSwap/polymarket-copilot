# Root cause: ShadowCandidates still blocked with namespaced reasons despite zero guardrail counters

## Summary

Runtime counters show `intentsBlockedByGuardrails = 0` and `intentsBlockedByFreshness = 0`, but new ShadowCandidate rows are still created with `wasBlocked: true` and composite namespaced `blockingReasons` (e.g. `freshness:user_data_stale`, `liquidity:market_degraded; not_tradable; execution_quality:not_tradable`). The blocker is a **second gate**: execution policy runs after guardrails and uses **unrelaxed** inputs; it blocks and records ShadowCandidate as blocked. Runtime diagnostics only count the **first gate** (guardrails), so the counters and ShadowCandidate status can disagree.

## Call paths that create or update ShadowCandidate

### 1. Guardrail block path (first gate)

- **Where:** `worker/stream-runtime.ts`, same `order.intent.created` handler, after `guardrails.evaluate(...)`.
- **When:** `!allowed` (guardrail verdict not "allowed").
- **Action:** `recordShadowCandidate({ ..., wasBlocked: true, blockingReasons: result.reasonCodes })`.
- **blockingReasons shape:** Plain guardrail reason codes, e.g. `["market_degraded", "not_tradable", "reconciliation_stale"]` (no prefix).
- **Diagnostics:** `diagnostics.recordIntentBlockedByGuardrails()`, and when freshness-related, `recordIntentBlockedByFreshness()`. So **intentsBlockedByGuardrails** and **intentsBlockedByFreshness** are updated only on this path.

### 2. Execution policy block path (second gate)

- **Where:** Same handler, **after** guardrails allow and after durable intent creation (`createIntentWithEvent`).
- **When:** Guardrails allowed → we create ledger intent → we build `policyInput` and call `evaluateExecutionPolicy(policyInput)` → `!policyResult.allow`.
- **Action:** `recordShadowCandidate({ ..., wasBlocked: true, blockingReasons: policyResult.blockingReasons })`.
- **blockingReasons shape:** **Namespaced** strings from `lib/execution-policy/evaluate.ts`: `"freshness:" + blockReason`, `"liquidity:" + blockReason` (which can include `"execution_quality:" + r`), `"exposure:"`, `"pricing:"`, `"operational:"`, `"recommendation:"`. Example: `["freshness:user_data_stale"]` or `["liquidity:market_degraded; not_tradable; execution_quality:not_tradable"]`.
- **Diagnostics:** **No** update to `intentsBlockedByGuardrails` or `intentsBlockedByFreshness`. Only a log and ledger event. So runtime counters stay 0 while ShadowCandidates are still recorded as blocked.

### 3. Execution policy allow path

- **Where:** Same handler, when `policyResult.allow === true`.
- **Action:** `recordShadowCandidate({ ..., wasBlocked: false, wasSubmitted: true })`.
- **blockingReasons:** Not set (allowed path).

## Where composite namespaced reasons are built

**File:** `lib/execution-policy/evaluate.ts`

- **Freshness:** `checkFreshness()` returns `blockReason` as a joined string (e.g. `"user_data_stale"`, `"market_data_stale; reconciliation_stale"`). The evaluator pushes `"freshness:" + checks.freshness.blockReason` (line 321).
- **Liquidity:** `checkLiquidity()` builds reasons from `marketStale`, `marketDegraded`, `isTradable`, thresholds, and from `input.executionQuality` when `qualityState === "block"` (adds `"execution_quality:" + r` for each r). Returns `blockReason` as joined string. The evaluator pushes `"liquidity:" + checks.liquidity.blockReason` (line 327).
- **Exposure / pricing / operational / recommendation:** Same pattern: `"exposure:" + blockReason`, etc.

So the **source** of namespaced reasons is **only** the execution policy evaluator. Guardrails never produce these prefixes.

## Why ShadowCandidate wasBlocked and counters can differ

| Concept | Source | Meaning |
|--------|--------|--------|
| **intentsBlockedByGuardrails** | Incremented only when the **guardrail** path records a block (first gate). | Count of intents that never passed guardrails. |
| **intentsBlockedByFreshness** | Subset of guardrail blocks where reason codes are freshness-related. | Count of intents blocked by guardrails due to freshness. |
| **ShadowCandidate.wasBlocked** | Set by **either** the guardrail path **or** the execution policy path. | True if the intent was blocked by guardrails **or** by execution policy. |
| **ShadowCandidate.blockingReasons** | Guardrail path: plain codes. Execution policy path: namespaced strings. | Identifies which gate blocked and which checks failed. |

So: **Runtime counters only reflect the first gate.** The second gate (execution policy) can block and set `wasBlocked: true` and namespaced `blockingReasons` without changing those counters. That is why you see counters at 0 but ShadowCandidates still blocked with namespaced reasons.

## Root cause of “all blocked” despite zero counters

1. **Guardrails (first gate)** use **paper-mode relaxed** inputs (e.g. `marketDataFreshForGuardrails`, `reconciliationFreshForGuardrails`, `allowDegradedAndNotTradableForPaper`). So guardrails **allow** and we do **not** increment `intentsBlockedByGuardrails` / `intentsBlockedByFreshness`.
2. We then create the durable intent and run **execution policy (second gate)** with **raw, unrelaxed** inputs: `marketDataFresh`, `userDataFresh`, `reconciliationFresh`, and raw `assetLiveState` (marketStale, marketDegraded, isTradable, etc.), and raw `eqResult` (execution quality).
3. Execution policy **blocks** on those strict checks and produces namespaced reasons (e.g. `freshness:user_data_stale`, `liquidity:market_degraded; not_tradable; execution_quality:not_tradable`).
4. We call `recordShadowCandidate({ wasBlocked: true, blockingReasons: policyResult.blockingReasons })`. No change to runtime guardrail/freshness counters.

So the blocker is the **execution policy** path, not the guardrail path. The semantics are: **counters = first gate only; ShadowCandidate = either gate.**

## Fix (paper mode): align execution policy with guardrails

In **paper mode**, build the execution policy input from the **same relaxed inputs** used for guardrails so the second gate does not re-block:

1. **Freshness:** Use `marketDataFreshForGuardrails`, `userDataFreshForGuardrails`, `reconciliationFreshForGuardrails` for `policyInput.freshness` (instead of raw `marketDataFresh`, etc.).
2. **Liquidity:** Use a passing market-health view: `marketStale: false`, `marketDegraded: false`, `isTradable: true` (other fields unchanged), so execution policy does not block on market_degraded / not_tradable in paper mode.
3. **Execution quality:** When `eqResult.qualityState === "block"`, pass `qualityState: "good"`, `blockingReasons: []` so execution policy does not add `execution_quality:*` in paper mode.
4. **Operational reconciliation_drift:** Use the same logic as freshness: in paper mode pass `reconciliationDrift: !reconciliationFreshForGuardrails` (so when we consider reconciliation “fresh” for guardrails we also consider “no drift” for execution policy). Raw `reconciliationDrift: !reconciliationFresh` is still used in live mode.

Live mode is unchanged: execution policy still receives raw inputs.

### Where operational:reconciliation_drift comes from

- **File:** `lib/execution-policy/evaluate.ts`, `checkOperationalSafety()` (line 246): `if (op?.reconciliationDrift) blockReasons.push("reconciliation_drift")`. The evaluator then pushes `"operational:" + checks.operationalSafety.blockReason` (line 332).
- **Input:** `policyInput.operational.reconciliationDrift` was previously set to `!reconciliationFresh` (raw). When runtime reconciliation has never succeeded or is stale, `reconciliationFresh` is false, so `reconciliationDrift` is true and execution policy blocks with `operational:reconciliation_drift`.
- **Paper-mode fix:** Set `operational.reconciliationDrift = paperMode ? !reconciliationFreshForGuardrails : !reconciliationFresh`. So in paper mode we use the same “reconciliation OK” notion as guardrails (e.g. no open orders ⇒ no drift). Shadow collection does not require exchange order sync, so this relaxation is safe for paper.

## Diagnostics added

When execution policy blocks (and we record a blocked ShadowCandidate from that path), we log:

- **"ShadowCandidate blocked by execution policy (diagnostics)"** with:
  - `source: "execution_policy"`
  - `runtimeGuardrailsAllowed: true`
  - `policyBlockingReasons`
  - `policyState`
  - `paperMode`
  - `paperModeRelaxationAppliedToPolicyInput`
  - `operationalReconciliationDriftRaw` (raw `!reconciliationFresh`)
  - `operationalReconciliationDriftForPolicy` (value passed to policy, relaxed in paper mode when applicable)
  - `operationalReconciliationDriftRelaxedForPaper` (true when paper mode and raw ≠ forPolicy)
  - `assetId`, `intentId`

So you can see that the block came from the **execution policy** path, that guardrails had already allowed, and how reconciliation drift was set (and whether it was relaxed for paper).

## Files changed

- **`worker/stream-runtime.ts`**
  - Build `policyFreshness` from relaxed values when `paperMode` (same as guardrails).
  - Build `policyLiquidity` with passing market-health in paper mode (`marketStale: false`, `marketDegraded: false`, `isTradable: true`).
  - Build `policyExecutionQuality` in paper mode: when `eqResult.qualityState === "block"` pass `qualityState: "good"`, `blockingReasons: []`.
  - Build `operational.reconciliationDrift` as `paperMode ? !reconciliationFreshForGuardrails : !reconciliationFresh` so paper mode uses the same “reconciliation OK” notion as guardrails (e.g. no open orders ⇒ no drift).
  - When execution policy blocks, log **"ShadowCandidate blocked by execution policy (diagnostics)"** with the fields above, including `operationalReconciliationDriftRaw`, `operationalReconciliationDriftForPolicy`, `operationalReconciliationDriftRelaxedForPaper`.

## How to verify

```bash
npm run worker
```

- Run until intents are emitted and guardrails allow (counters stay 0).
- With the fix, execution policy in paper mode should now **allow** (same relaxed inputs as guardrails), so you should see:
  - `recordShadowCandidate({ wasBlocked: false, wasSubmitted: true })` and flow into `orderManager.reconcileIntents([intent])`.
- If execution policy still blocks (e.g. exposure/pricing/operational), logs will show **"ShadowCandidate blocked by execution policy (diagnostics)"** with `source: "execution_policy"` and `runtimeGuardrailsAllowed: true`.

```bash
npm run check:shadow-pipeline
```

- Expect non-zero **allowed** / **submitted** / **evaluated** and new ShadowCandidate rows with `wasBlocked: false` when the only previous blocker was execution policy (freshness/liquidity/execution_quality) and paper-mode alignment is applied.

## Evidence that allowed/submitted ShadowCandidates are reachable

- **Before:** Guardrails allowed (counters 0), then execution policy blocked with raw inputs and recorded ShadowCandidate with `wasBlocked: true` and namespaced reasons. No rows with `wasBlocked: false` from this path.
- **After:** In paper mode, execution policy receives the same relaxed freshness and passing liquidity/execution-quality as the guardrails. It allows, so we record `wasBlocked: false`, `wasSubmitted: true` and call `reconcileIntents`. Allowed/submitted ShadowCandidates and pipeline counts increase.
