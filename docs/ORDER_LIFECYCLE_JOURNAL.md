# Order Lifecycle Journal – Invariants and Design

## Invariants

1. **Append-only**  
   No update or delete of existing rows. Every transition is a new row. No mutation of prior entries.

2. **Deterministic replay**  
   Replaying the same sequence of entries in `createdAt` order produces the same `RuntimeOrderState`.  
   `rebuildOrderFromJournal(entries)` is pure given the same `entries` order.

3. **Duplicate events do not corrupt state**  
   Replay applies only valid transitions (e.g. ack only when status is `pending_submit`).  
   Duplicate acks, fills, or cancels are idempotent: the first application wins; later duplicates are no-ops.

4. **Ordering**  
   History is ordered by `createdAt` ascending. Per-order replay uses the same ordering for deterministic state.

5. **Hot path**  
   Journal writes go through a single adapter (`appendOrderLifecycleEvent`). Callers (lifecycle handler, order manager, sweeper, rebuild, reconciliation) pass a shared `journalAppend` callback. Writes are fire-and-forget (non-blocking) so the main path is not blocked on DB.

## Event types

- `intent_created` – intent created (no `clientOrderId` yet)
- `local_order_created` – order created in store
- `ack` – exchange ack
- `partial_fill`, `fill` – fill applied
- `cancel_requested` – cancel requested (before ack)
- `canceled`, `rejected` – terminal
- `stale_detected` – sweeper marked stale
- `reconcile_keep`, `reconcile_place`, `reconcile_cancel`, `reconcile_cancel_replace` – reconciler actions
- `rebuild_imported` – order imported from exchange on rebuild
- `repair_recommended`, `repair_applied` – reconciliation repair

## Optional rebuild from journal

Startup rebuild is from **exchange truth** (and fill ledger). Optionally, you can replay the journal for specific orders and upsert into the store via `replayOrderFromJournalIntoStore(funderAddress, clientOrderId, orderStore)`. Use when you need to restore orders that exist only in the journal (e.g. pre-ack or orphaned).

## API

- **appendOrderLifecycleEvent(params)** – append one event (append-only).
- **getOrderLifecycleHistory({ funderAddress, clientOrderId?, exchangeOrderId?, limit? })** – entries in `createdAt` order.
- **rebuildOrderFromJournal(entries)** – pure replay; returns `RuntimeOrderState | null`.
- **getLatestJournalStateForOrder({ funderAddress, clientOrderId?, exchangeOrderId? })** – fetch history and replay.
- **replayOrderFromJournalIntoStore({ funderAddress, clientOrderId?, exchangeOrderId?, orderStore })** – replay and upsert into store.

## Operator / debug

- **GET /api/orders/lifecycle-history?funderAddress=0x...&clientOrderId=...&exchangeOrderId=...&limit=500&state=1**  
  Returns journal entries and optionally `reconstructedState` from replay.
