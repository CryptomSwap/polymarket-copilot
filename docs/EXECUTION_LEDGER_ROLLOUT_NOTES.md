# Execution Ledger Rollout Notes

**Scope:** Additive schema and migration only. No runtime behavior change. No removal of existing models.

---

## 1. Additive Migration Strategy

- **New columns** on OrderIntent, ExecutedOrder, FillLedgerEntry are **nullable** (or have defaults). Existing API and runtime code paths do not set them; they continue to work unchanged.
- **New tables:** OrderIntentEvent, ExecutedOrderEvent, CancelRequest, ReplaceRequest. No application code writes to them in this step; they are ready for future wiring.
- **Unique constraints:** `(funderAddress, idempotencyKey)` on OrderIntent allows multiple rows with `idempotencyKey = null` (PostgreSQL treats nulls as distinct in unique). Existing intents have no key and are unchanged. `venueOrderId` and `venueTradeId` are unique nullable; existing rows leave them null.
- **Foreign keys:** FillLedgerEntry.executedOrderId → ExecutedOrder (SET NULL on delete). New event/request tables CASCADE on ExecutedOrder delete. No backfill of existing data required.

---

## 2. Backward Compatibility Assumptions

- **API place flow** (`lib/polymarket/trading.ts`): Still creates OrderIntent and ExecutedOrder with the same fields as before. New fields are optional and default to null. No code change required.
- **Fill ledger** (`lib/live/fill-ledger.ts`): Still uses funderAddress, exchangeFillId, size, price, filledAt, appliedToRuntimePosition, appliedAt, payloadJson. New columns are not read or written by current code.
- **Order lifecycle journal** (`lib/runtime/journal/order-lifecycle-journal.ts`): Unchanged. Still append-only by clientOrderId/exchangeOrderId; no relation to ExecutedOrder or ExecutedOrderEvent in this step.
- **Prisma client:** After migration and `prisma generate`, new relations (e.g. `orderIntent.intentEvents`, `executedOrder.orderEvents`) are available but optional in queries. No breaking changes to existing create/update/find calls.

---

## 3. Current Code Paths Not Yet Migrated

| Path | Current behavior | Future (out of scope for this step) |
|------|-------------------|--------------------------------------|
| Runtime intent creation | Bot emits `order.intent.created`; handler calls `orderManager.reconcileIntents`. No DB write. | Persist intent with idempotencyKey; append OrderIntentEvent. |
| Runtime order lifecycle | In-memory order store + OrderLifecycleJournalEntry append. | Also write ExecutedOrder + ExecutedOrderEvent when paper/live order is created/acked/filled/canceled. |
| Runtime fill application | FillLedgerEntry.recordFill + appliedToRuntimePosition. | Optionally set executedOrderId, orderIntentId, venueTradeId on FillLedgerEntry. |
| Startup rebuild | Exchange open orders + fill ledger only. | Optionally replay OrderIntentEvent/ExecutedOrderEvent or use ExecutedOrder as source of truth. |
| Cancel / replace | Paper adapter and in-memory store only. | Persist CancelRequest / ReplaceRequest when cancel/replace is sent. |

---

## 4. Temporary Duplication or Coexistence

- **Order lifecycle:** Two parallel notions exist and are **not** merged in this step:
  - **OrderLifecycleJournalEntry** (clientOrderId, exchangeOrderId, eventType, occurredAt): used by runtime today; keyed by client/local id.
  - **ExecutedOrder + ExecutedOrderEvent** (venueOrderId, eventType, createdAt): new; keyed by venue and intent. Coexistence is intentional until runtime is rewired to write both or migrate to one.
- **Fill identity:** FillLedgerEntry keeps **exchangeFillId** (legacy) and adds **venueTradeId**. Both can be used for dedupe; existing code uses only exchangeFillId. No data backfill.

---

## 5. Migration Application

- Migration name: `20260314000000_execution_ledger_durable_models`.
- Apply with: `npx prisma migrate deploy` (production) or `npx prisma migrate dev` (development). If the shadow database fails (e.g. due to prior migration history), the migration SQL can be applied manually; it uses `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` where appropriate for idempotency.
- After applying: run `npx prisma generate` to update the client.
