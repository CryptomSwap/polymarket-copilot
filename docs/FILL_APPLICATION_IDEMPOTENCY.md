# Fill Application Idempotency

This document describes how fill ingestion and position mutation are made deterministic and replay-safe using the persistent execution ledger.

## Old Behavior

- **Fill ingestion:** When `fillLedgerEnabled` was true, only fills that had an `exchangeFillId` (from the user-feed normalizer) were written to the fill ledger via `lib/live/fill-ledger.ts`. Fills without a stable id were not persisted and could be applied from the lifecycle event alone.
- **Position updates:** Handlers for `order.partial_fill` and `order.filled` applied position deltas. When `exchangeFillId` was present, they checked an in-memory/DB “already applied” state and called `markFillAppliedToPosition` after applying. When `exchangeFillId` was missing, they applied in-memory only with no durable dedupe.
- **Risks:** Duplicate delivery (reconnect, reconciliation, replay) could double-apply fills that lacked a stable id. Restart after persisting a fill but before applying left that fill “unapplied” and it was never replayed because `replayUnappliedFills()` was not invoked on startup. The source of truth for “already applied” was split between in-memory state and the legacy fill ledger.

## New Durable-First Behavior

1. **Every incoming fill is persisted first.**  
   For every user-feed event that represents an execution (partial_fill or fill), we:
   - Normalize the payload.
   - Resolve a **unique fill identity** (see below).
   - Persist via the execution-ledger service (`recordFillAndReturnDedupResult`) **before** applying lifecycle or mutating position.
   - If the insert is a duplicate (same `exchangeFillId` or `venueTradeId`), we skip lifecycle and position entirely.

2. **Position mutation is gated by the ledger.**  
   In the stream-runtime fill handlers:
   - We look up the fill in the execution ledger by `(funderAddress, exchangeFillId)`.
   - If there is no row, we log and skip (no in-memory-only apply).
   - If the row is already marked `appliedToRuntimePosition`, we skip.
   - Otherwise we apply the position delta, then call `markFillAppliedSafely` so the row is marked applied exactly once.

3. **Startup recovery.**  
   On boot we:
   - Rebuild the position store from **applied** fills only (`getAppliedFillsForRebuild`).
   - Then run **replay** of **unapplied** fills: `getReplayableUnappliedFills` → for each, apply to position → `markFillAppliedSafely`.
   - So no fill is applied twice, and any fill that was persisted but not applied before a crash is applied once on the next start.

## Unique Identity Strategy for Fills

We derive a single **exchangeFillId** (and optionally **venueTradeId**) used for ledger dedupe and for lookups when applying:

1. **exchangeFillId** (preferred)  
   Use when the upstream payload provides a stable fill/trade id (e.g. Polymarket `id` or `trade_id`). Dedupe is strong.

2. **venueTradeId**  
   If the venue provides a trade id but not as our primary key, we still store it and use it for dedupe where supported. The ledger unique key remains `(funderAddress, exchangeFillId)`; we may also have a unique `venueTradeId`.

3. **Weak fingerprint (fallback)**  
   If neither is available, we build a deterministic fingerprint from `funderAddress`, `exchangeOrderId`, `filledAt`, `size`, `price`, and optionally `side`. This is **weaker**: same logical fill with different encoding or timing could produce a different key. We log `weak_fill_fingerprint_used` when this path is used so operators can monitor.

Code: `lib/execution-ledger/fill-identity.ts` (`resolveFillIdentity`, `buildWeakFillFingerprint`).

## What Is Guaranteed Now

- **Same exchange fill delivered twice:** One row in the ledger; second insert is duplicate; lifecycle/position skipped on duplicate.
- **Same venueTradeId delivered twice:** Same as above when venueTradeId is stored and used for dedupe.
- **Restart after persist, before apply:** Fill remains unapplied; on next boot we rebuild from applied fills, then replay unapplied; this fill is applied once and marked applied.
- **Partial fills in sequence:** Each partial has its own row (and id); each is applied once and marked applied.
- **Reconnect / user-feed replay:** Duplicate events hit the same ledger row; position handler sees `appliedToRuntimePosition` and skips.

So duplicate delivery does not cause duplicate position mutation, and recovery after crash is deterministic.

## What Is Still Imperfect When Upstream Fill IDs Are Missing

- **Weak fingerprint:** If we have no venue-provided id, we use a deterministic fingerprint. Collisions are unlikely but not impossible; conversely, the same fill with slightly different fields (e.g. timestamp precision) could get a different fingerprint and be treated as a second fill. Operators should monitor `weak_fill_fingerprint_used` and prefer feeds that supply stable `id` or `trade_id`.
- **No ledger row:** If for some reason a fill was not persisted (e.g. error before insert, or code path that doesn’t call the execution-ledger), the position handler will not apply it (we skip when there is no ledger row). That is fail-closed: we might miss one apply, but we avoid double-apply.

## Summary

- **Old:** Fills with no stable id could double-apply; restart did not replay unapplied fills; “already applied” was not fully durable.
- **New:** Every fill is persisted first with the best available id (exchangeFillId > venueTradeId > weak fingerprint). Position changes only from durable, unapplied ledger rows, and we mark applied exactly once. Startup replays unapplied fills once. Duplicate delivery never double-mutates position.
