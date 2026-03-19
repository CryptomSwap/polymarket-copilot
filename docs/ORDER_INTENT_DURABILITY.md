# Order Intent Durability

## Purpose

Order intents are now persisted in the execution ledger **before** executable order submission. The runtime creates a durable `OrderIntent` with an idempotency key, appends lifecycle events (CREATED, EXECUTION_POLICY_PASSED or EXECUTION_POLICY_BLOCKED, READY_FOR_RECONCILIATION), and passes the ledger intent id through to reconciliation. This makes the order-creation path auditable and replay-friendly.

## Old runtime-only behavior

- The runtime emitted `order.intent.created` with an optional `intentId` (ephemeral or from the bot).
- Guardrails and execution policy ran; on pass, the runtime called `reconcileIntents([intent])` with that `intentId`.
- The execution policy result was journaled (e.g. `EXECUTION_POLICY_PASSED`) but there was **no first-class durable intent record**.
- Intent identity was not guaranteed across restarts; duplicate submissions could create duplicate work.

## New durable intent flow

1. **After guardrails pass** (inside the `order.intent.created` handler), the runtime builds an **idempotency key** from funder, source, recommendationId (if present), assetId, side, orderType, normalized limitPrice, normalized size, and an optional time slot (e.g. 60s).
2. **Create or get intent** via `createIntentWithEvent`: creates an `OrderIntent` in the execution ledger (or returns the existing one if the idempotency key is already used) and appends a **CREATED** event.
3. **Run execution policy** as before.
4. **If policy blocks:**  
   `appendIntentBlockedEvent(ledgerIntent.id, "EXECUTION_POLICY_BLOCKED", payload, "blocked")`.  
   Do **not** call `reconcileIntents`.
5. **If policy passes:**  
   - `persistExecutionPolicyPassed(ledgerIntent.id, policyResult.snapshotJson)` — updates `executionPolicySnapshotJson` on the intent and appends **EXECUTION_POLICY_PASSED**.  
   - `appendOrderIntentEventToLedger(ledgerIntent.id, "READY_FOR_RECONCILIATION", null)`.  
   - Build the runtime `OrderIntent` with **intentId = ledgerIntent.id** and call `reconcileIntents([intent])`.
6. Downstream (paper order manager) receives the ledger intent id as `intentId` and can create/link `ExecutedOrder` and append **ExecutedOrderEvent** (e.g. SUBMITTED) when an order is placed and acked.

## Idempotency-key strategy

- **Components:** `funderAddress`, `source` (e.g. `"runtime_automated"`), `recommendationId` (if present), `assetId`, `side`, `orderType`, normalized `limitPrice` (e.g. 4 decimals), normalized `requestedSize`, and an optional **slot** (e.g. `floor(Date.now() / 60000)` for 60s).
- **Same key** → same intent (create returns existing; no duplicate intent).
- **Different key** → new intent (e.g. different asset, or same rec after the slot advances).
- Key is normalized (trim, collapse whitespace, max length) before use. Empty key is not used; intent is created without idempotency in that case.

## Which runtime paths create intents

- **Stream runtime** (`worker/stream-runtime.ts`): On `order.intent.created`, after guardrails pass, the handler creates/gets the ledger intent, runs execution policy, then either records a block event or persists policy passed and calls `reconcileIntents` with the ledger intent id. This is the only path that currently creates **durable** intents for the runtime.
- **API / manual placement** (`lib/polymarket/trading.ts` or order placement API): May create intents via a different path (e.g. direct Prisma or execution-ledger service); see API docs and audit-dump for exact call sites.

## What is still not fully durable yet

- **Intent creation before guardrails:** The durable intent is created only **after** guardrails pass. A guardrail-blocked intent is not written to the ledger (no CREATED event for that path). Optionally we could create an intent with a BLOCKED or GUARDRAIL_BLOCKED event for audit.
- **Recommendation id on payload:** The `order.intent.created` payload does not yet always carry `recommendationId`; it is optional in the idempotency key.
- **Journal vs ledger:** The runtime journal still records INTENT_CREATED and EXECUTION_POLICY_PASSED. The execution ledger is the **source of truth** for intent lifecycle; journal entries are supplementary and should not conflict (e.g. same intentId is used where applicable).
