# Durable Fill Ledger Implementation Summary

## Goal

Eliminate restart-related double-apply risk for fills by introducing a **durable fill ledger** as the source of truth for replay safety. The in-memory `appliedPositionFilledSize` logic is preserved; the ledger ensures each exchange fill is applied to the runtime position **exactly once** across process restarts and duplicate deliveries.

---

## 1. Prisma model: `FillLedgerEntry`

**File:** `prisma/schema.prisma`

- **id** (cuid), **funderAddress**, **exchangeFillId** (unique per funder via `@@unique([funderAddress, exchangeFillId])`)
- **clientOrderId**, **exchangeOrderId** (nullable)
- **assetId**, **marketId**, **side**, **size**, **price**, **filledAt**
- **source** (e.g. `user_feed`, `replay`)
- **appliedToRuntimePosition** (boolean, default false)
- **appliedAt** (nullable)
- **payloadJson** (nullable), **createdAt**, **updatedAt**
- Indexes: `funderAddress`, `appliedToRuntimePosition`, `(funderAddress, appliedToRuntimePosition)`

**Migration:** `prisma/migrations/20260311120000_add_fill_ledger_entry/migration.sql`

---

## 2. Fill ledger API (`lib/live/fill-ledger.ts`)

- **recordFill(params)**  
  Inserts a row for `(funderAddress, exchangeFillId)`. If the row already exists, returns `{ recorded: false, id }`; otherwise returns `{ recorded: true, id }`. Used to dedupe before applying lifecycle.

- **markFillAppliedToPosition(by)**  
  Sets `appliedToRuntimePosition = true` and `appliedAt = now` for the entry (by `id` or by `funderAddress` + `exchangeFillId`). Idempotent.

- **isFillAppliedToPosition(funderAddress, exchangeFillId)**  
  Returns whether that fill has already been applied to the runtime position (used in event subscribers to skip re-apply).

- **getUnappliedFills(funderAddress?)**  
  Returns entries with `appliedToRuntimePosition === false`, ordered by `filledAt` ascending, for cold-start replay.

- **ledgerEntryToPositionFill(entry)**  
  Maps an `UnappliedFillEntry` to a shape suitable for `positionUpdater.applyFill()` (same as `NormalizedFillInput`).

---

## 3. Flow: record first, then lifecycle and position

1. **User feed**  
   Normalizer produces `NormalizedUserFeedResult` with **exchangeFillId**:
   - **TRADE:** from `payload.id` or `payload.trade_id`, or synthetic `trade:${exchangeOrderId}:${ts}`.
   - **ORDER UPDATE (partial_fill):** synthetic `order:${exchangeOrderId}:${sizeMatched}:${price}:${at.getTime()}`.

2. **feedUserFeedResultToRuntime** (async)  
   - When `fillLedgerEnabled` and result has a fill lifecycle with `exchangeFillId`:
     - Build `RecordFillParams` from result and order (assetId, marketId, side from order).
     - **await recordFill(params).** If `recorded === false`, return (duplicate; do not apply lifecycle).
     - If `recorded === true`, call **applyLifecycle(..., exchangeFillId)** so the handler can include it in emitted events.
   - Lifecycle handler still updates order store and emits `order.partial_fill` / `order.filled` with **exchangeFillId** in the payload.

3. **StreamRuntime subscribers (order.partial_fill / order.filled)**  
   - If payload has **exchangeFillId**:
     - **await isFillAppliedToPosition(funder, exchangeFillId).** If true, return (no position update).
     - Else: compute delta, **positionUpdater.applyFill(fill)**, **orderStore.setAppliedPositionFilledSize(...)**, **await markFillAppliedToPosition({ funderAddress, exchangeFillId })**.
   - If no exchangeFillId (e.g. paper path): keep previous behavior (apply by delta, no ledger).

4. **Cold-start replay**  
   In **StreamRuntime.start()**, after **startWebsocketsWithRuntime**:
   - **await replayUnappliedFills(funder)**:
     - **getUnappliedFills(funder)** → list of unapplied entries by `filledAt`.
     - For each: **positionUpdater.applyFill(ledgerEntryToPositionFill(entry))**, **markFillAppliedToPosition({ id: entry.id })**.
   - Ensures any fills that were recorded but not applied (e.g. process died after ledger insert, before position update) are applied exactly once on next start.

---

## 4. Invariants and behavior

- **One row per exchange fill**  
  Uniqueness on `(funderAddress, exchangeFillId)`; duplicate user-feed or re-delivery only adds one row and subsequent `recordFill` returns `recorded: false`, so lifecycle is not applied again.

- **Position apply guarded by ledger**  
  Subscribers only apply to position when the ledger says the fill is not yet applied; after apply they call **markFillAppliedToPosition**, so the same fill id is never applied twice even across restarts.

- **In-memory state unchanged**  
  `appliedPositionFilledSize` on the order and the position store remain the same as before; the ledger does not replace them but ensures that the *events* that drive updates are applied at most once.

- **Lifecycle-driven position updates only**  
  Position is still updated only from `order.partial_fill` / `order.filled` subscribers (no direct position mutation from raw user WS parsing).

- **Fail-safe**  
  If `recordFill` or `markFillAppliedToPosition` fails, we log and skip or avoid double-apply by checking `isFillAppliedToPosition` before applying.

---

## 5. Files changed

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Added model `FillLedgerEntry`. |
| `prisma/migrations/20260311120000_add_fill_ledger_entry/migration.sql` | Migration for `FillLedgerEntry`. |
| `lib/live/fill-ledger.ts` | **New.** recordFill, markFillAppliedToPosition, isFillAppliedToPosition, getUnappliedFills, ledgerEntryToPositionFill. |
| `lib/live/user-feed-normalizer.ts` | Added **exchangeFillId** to result (TRADE and ORDER UPDATE partial_fill). |
| `lib/live/user-feed-to-runtime.ts` | Async; **recordFill** before lifecycle when fill + exchangeFillId; **fillLedgerEnabled**; pass **exchangeFillId** into applyLifecycle. |
| `lib/runtime/order-manager/order-manager.ts` | **OrderPartialFillInput** / **OrderFullFillInput**: optional **exchangeFillId**. |
| `lib/runtime/events/runtime-events.ts` | **OrderPartialFillPayload** / **OrderFilledPayload**: optional **exchangeFillId**. |
| `lib/runtime/order-manager/order-lifecycle-handler.ts` | Pass **exchangeFillId** into emitted fill payloads. |
| `worker/websockets.ts` | **void feedUserFeedResultToRuntime(...).catch(...)**, **fillLedgerEnabled: true**. |
| `worker/stream-runtime.ts` | Subscribers: when **exchangeFillId** present, **isFillAppliedToPosition** → apply → **markFillAppliedToPosition**; **replayUnappliedFills** after start. |
| `lib/runtime/__tests__/fill-position-idempotency-tests.ts` | **await feedUserFeedResultToRuntime**, **fillLedgerEnabled: false**, **exchangeFillId: null**, telemetry shape. |
| `lib/runtime/__tests__/lifecycle-exposure-hardening-tests.ts` | **await feedUserFeedResultToRuntime**, **fillLedgerEnabled: false**, **exchangeFillId: null**. |
| `lib/live/__tests__/fill-ledger-tests.ts` | **New.** Duplicate same process, isApplied/markApplied, getUnappliedFills, ledgerEntryToPositionFill (no DB), double-count prevention (with DB). |
| `package.json` | Script **test:fill-ledger**. |
| `docs/FILL_LEDGER_IMPLEMENTATION.md` | **New.** This summary. |

---

## 6. Tests

- **Duplicate fill same process:** `recordFill` twice with same `exchangeFillId` → second returns `recorded: false`.
- **isFillAppliedToPosition / markFillAppliedToPosition:** before mark → false, after mark → true.
- **getUnappliedFills:** returns only unapplied, ordered by `filledAt`; after marking, those entries no longer appear.
- **ledgerEntryToPositionFill:** maps to position fill shape; apply to position store → position updated (no DB required).
- **Durable ledger prevents double-count:** apply once, mark applied; second apply skipped via `isFillAppliedToPosition`; position unchanged.

Fill-ledger tests that use Prisma are skipped with a message when the `FillLedgerEntry` table does not exist or DB is unavailable. Run **npx prisma migrate deploy** (or **migrate dev**) to apply the migration and run full fill-ledger tests.

**Scripts:**  
- `npm run test:fill-ledger`  
- `npm run test:runtime-degraded` (unchanged)  
- `npm run test:stream-watchdog` (unchanged)

---

## 7. Summary

- **Durable fill ledger** stores each exchange fill by `(funderAddress, exchangeFillId)` and tracks `appliedToRuntimePosition`.
- **Record first:** user-feed path records the fill; if duplicate, lifecycle and position are skipped.
- **Apply once:** event subscribers check the ledger before applying to position and mark applied after.
- **Cold-start replay:** unapplied ledger entries are applied to the position store once on startup.
- **Existing behavior preserved:** in-memory order/position logic and lifecycle-driven position updates unchanged; no direct position mutation from raw WS parsing.
