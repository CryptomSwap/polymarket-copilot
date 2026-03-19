# ShadowCandidate All Blocked — Root Cause

**Observed:** Every ShadowCandidate is blocked; none allowed/submitted/evaluated. `intentsBlockedByGuardrails` and `intentsBlockedByFreshness` both equal the number of intents (e.g. 220).

---

## 1. Path from intent to ShadowCandidate

| Step | Location | What happens |
|------|----------|--------------|
| 1 | Strategy | Returns non-NOOP (e.g. UPDATE_QUOTES) → `order.intent.created` emitted. |
| 2 | `worker/stream-runtime.ts` | `wireIntentAndFillHandlers`: subscribes to `order.intent.created`. |
| 3 | Intent handler | Checks `isAutomationAllowed()`, execution policy `isExecutionAllowed("runtime_automated")`; if either blocks, returns early (no ShadowCandidate for mode/policy blocks). |
| 4 | Intent handler | Builds `context`, `proposedAction`, then **freshness** (marketDataFresh, userDataFresh, reconciliationFresh from stream status and diagnostics). |
| 5 | Intent handler | Calls `guardrails.evaluate(context, riskState, proposedAction, { freshness })`. |
| 6 | Guardrails | `lib/runtime/risk/runtime-guardrails.ts`: uses `freshness` to push reason codes (e.g. MARKET_DATA_STALE, USER_DATA_STALE, RECONCILIATION_STALE when the corresponding fresh flags are false). Returns verdict (e.g. "blocked") and reasonCodes. |
| 7 | Intent handler | If `!allowed` (verdict not "allowed" / "cancel_only" for cancel / reduce-only): `diagnostics.recordIntentBlockedByGuardrails()`, then if any reason code is in the freshness list → `diagnostics.recordIntentBlockedByFreshness(freshnessCodes)`, then **recordShadowCandidate({ wasBlocked: true, blockingReasons: result.reasonCodes })**, then return. |
| 8 | If allowed | Intent continues to ledger create, guardrails pass, order manager submit path; later `recordShadowCandidate({ wasBlocked: false, wasSubmitted: true, ... })`. |

So **blocked** is set when the guardrail verdict is not "allowed" (and not the allowed reduce/cancel variants). The **same** intent is counted in both `intentsBlockedByGuardrails` and `intentsBlockedByFreshness` when the guardrail reason codes include any freshness-related code (market_data_stale, user_data_stale, reconciliation_stale, etc.), because we always record guardrail block and additionally record freshness block when those codes appear.

---

## 2. Where blocked is assigned

- **In memory:** The intent handler never calls `recordShadowCandidate` with `wasBlocked: false` for these intents because it returns early when `!allowed`.
- **In DB:** `lib/shadow-telemetry/record.ts` → `prisma.shadowCandidate.create({ data: { ..., wasBlocked: input.wasBlocked, blockingReasons: input.blockingReasons } })`. So `wasBlocked: true` and `blockingReasons` come directly from the intent handler when guardrails block.

There is no separate persistence/mapping bug: the handler passes `wasBlocked: true` and the reason codes from the guardrail result, and the record function persists them as-is.

---

## 3. Blocker: guardrails (driven by freshness)

- **Guardrails** are the direct blocker: `guardrails.evaluate()` returns a verdict other than "allowed", so the handler treats the intent as blocked and records a ShadowCandidate with `wasBlocked: true`.
- **Freshness** is the **cause** of the guardrail block: the handler builds `freshness` from:
  - `marketDataFresh`: market socket open and `lastDataEventAt` within `marketDataDegradedThresholdMs`
  - `userDataFresh`: user socket open and recent user data (or no open orders)
  - `reconciliationFresh`: last runtime reconciliation at most `RECONCILE_FRESHNESS_MS` ago and status "ok"

When any of these are false, the guardrails add the corresponding reason codes (e.g. MARKET_DATA_STALE, USER_DATA_STALE, RECONCILIATION_STALE) and return a blocking verdict. So:

- **intentsBlockedByGuardrails** = number of intents that failed the guardrail check (all of them in your case).
- **intentsBlockedByFreshness** = number of those blocked intents whose reason codes include at least one freshness-related code (same 220, because the guardrail block is due to freshness).

So the blocker is **both in effect**: guardrails block, and the reason they block is freshness. Not a bug in counting or persistence.

---

## 4. Diagnostics added

- **Worker log (per blocked intent):** `"ShadowCandidate blocked (diagnostics)"` with:
  - `guardrailVerdict`, `blockingReasonCodes`
  - `hadFreshnessCodes`, `freshnessReasonCodes` (subset of reason codes that are freshness-related)
  - `freshnessInputSummary`: `marketDataFresh`, `userDataFresh`, `reconciliationFresh`, `lastRuntimeReconciliationAt`, `lastRuntimeReconciliationOk`
  - `executionPolicyAllowed: true` (we only reach guardrails if execution policy already allowed)
- **Shadow pipeline tool:** `npm run check:shadow-pipeline` now includes `blockingReasons` for recent ShadowCandidate rows and a "Blocked vs runtime counters" section that compares ShadowCandidate blocked count to dashboard `intentsBlockedByGuardrails` / `intentsBlockedByFreshness`.

---

## 5. How to verify blocked status vs runtime counters

- Run `npm run check:shadow-pipeline`. Check that:
  - Recent blocked rows show `blockingReasons` (e.g. `["market_data_stale","reconciliation_stale"]`).
  - "Blocked vs runtime counters" shows dashboard intents blocked by guardrails/freshness and ShadowCandidate blocked count; they should align (blocked candidates ≈ intents blocked by guardrails when all blocks are guardrail blocks).
- In worker logs, after an intent is blocked, look for `"ShadowCandidate blocked (diagnostics)"` and confirm `freshnessInputSummary` shows which of `marketDataFresh`, `userDataFresh`, `reconciliationFresh` are false.

---

## 6. What would show allowed/submitted/evaluated becoming reachable

- **Allowed:** Guardrails must return verdict "allowed" (or the allowed cancel/reduce-only cases). That requires the freshness inputs passed to guardrails to be true: `marketDataFresh`, `userDataFresh`, `reconciliationFresh` all true when the intent is evaluated. So:
  - Market and user streams must have recent data (within degraded threshold), and
  - Runtime reconciliation must have run successfully and recently (within `RECONCILE_FRESHNESS_MS`).
- **Submitted:** After guardrails allow, the intent is created in the ledger and the paper order manager can submit; then `recordShadowCandidate({ wasBlocked: false, wasSubmitted: true })` is called.
- **Evaluated:** ShadowCandidate rows get `evaluatedAt` and `outcomeClassification` when the shadow-evaluation job (or API) runs after the required markout window (e.g. 24h).

**Fix applied:** A narrow **paper-mode freshness relaxation** is implemented in the intent handler: when `paperMode` is true, guardrails receive relaxed freshness so that (1) marketDataFresh = market socket open, (2) userDataFresh = user socket open or no open orders, (3) reconciliationFresh = at least one successful reconciliation (no 120s window). See **docs/FRESHNESS_GUARDRAIL_BLOCK_ROOT_CAUSE.md** for formulas, thresholds, what updates each input, and verification. The new diagnostics (worker log + check-shadow-pipeline) show which freshness flags were false and the ages when intents are still blocked.
