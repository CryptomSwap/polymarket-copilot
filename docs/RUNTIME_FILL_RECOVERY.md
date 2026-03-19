# Runtime Fill Recovery

This document describes how the streaming runtime recovers fill state on startup and how failures are handled and surfaced.

## Startup Replay Flow

1. **Rebuild order store**  
   From exchange open orders (existing behavior).

2. **Rebuild position store from applied fills only**  
   - We no longer load “all” fills for the funder. We load only fills that are already marked **applied** in the execution ledger: `getAppliedFillsForRebuild(funder)`.
   - These are applied in order by `filledAt` to an empty position store.  
   - So the in-memory position state matches the set of fills that were successfully applied in a previous run.

3. **Replay unapplied fills**  
   - We call `getReplayableUnappliedFills(funder)` to get durable fills with `appliedToRuntimePosition = false`.
   - For each fill we:
     - Log `replaying_unapplied_fill` (ledgerId, exchangeFillId, assetId, filledAt).
     - Apply the fill to the position store via the position updater.
     - Call `markFillAppliedSafely({ id: entry.id })`.
     - If the mark succeeds, log `fill_marked_applied`; if it fails, log `replay_fill_mark_failed`.
   - After processing all, log `startup_replay_unapplied_fills_done` with count and funder.

4. **Then**  
   Risk exposure is recomputed, and the runtime continues with normal wiring (event bus, WebSockets, etc.).

So: **position = applied fills (rebuilt) + unapplied fills (replayed and marked applied).** No fill is applied twice.

## Failure Handling

- **Replay of one fill throws:**  
  We catch per-fill, log `replay_failed` with `ledgerId` and error, and continue with the next fill. The failed fill remains unapplied and will be retried on the next restart (or can be inspected/fixed by operators).

- **Mark applied fails after we already applied:**  
  We log `replay_fill_mark_failed` (or in the live path `fill_mark_applied_failed_after_mutation`). The position was updated but the ledger was not. On the next restart we will try to replay this fill again; the apply is idempotent (we apply the same delta again). To avoid double-apply we rely on idempotent position semantics or on marking applied on the next run. In the current design we do not “roll back” the position; we fail closed and log loudly.

- **getReplayableUnappliedFills throws:**  
  The whole “Fill ledger replay failed” is logged and the startup continues. Unapplied fills are not replayed this run; they remain in the DB for the next start or for manual inspection.

## Operator Visibility / Logging

Structured log events:

| Event | Meaning |
|-------|--------|
| `startup_rebuild_fetch_ledger_fills_begin` | About to load applied fills for rebuild. |
| `startup_rebuild_fetch_ledger_fills_success` | Loaded applied fills; `appliedFillCount` is set. |
| `startup_replay_unapplied_fills_begin` | About to replay unapplied fills. |
| `replaying_unapplied_fill` | Applying one unapplied fill (ledgerId, exchangeFillId, assetId, filledAt). |
| `fill_marked_applied` | Successfully marked a replayed fill as applied. |
| `replay_fill_mark_failed` | Mark applied failed for a replayed fill. |
| `replay_failed` | One replayed fill threw (ledgerId, error). |
| `startup_replay_unapplied_fills_done` | Replay loop finished; includes count. |
| `startup_replay_unapplied_fills_success` | Replay phase completed. |
| `Fill ledger replay failed` | getReplayableUnappliedFills or top-level replay threw. |

Use these to confirm that unapplied fills are replayed and to spot failed marks or per-fill errors.

## Known Limits

- **No transactional “apply + mark”:** We apply to the position store then mark in the DB. If we crash between the two, the fill stays unapplied and will be replayed again. Position updates should be idempotent (e.g. same delta applied twice doubles position) unless the position store or updater explicitly supports idempotent apply by fill id. Currently we rely on “replay only unapplied” so each fill is replayed at most once per boot; if mark fails we may replay the same fill again on next boot (see above).
- **Weak fingerprint fills:** Fills that used a weak fingerprint for identity are still replayed like any other unapplied fill, but their identity is less reliable (see FILL_APPLICATION_IDEMPOTENCY.md).
- **Order of replay:** Unapplied fills are replayed in `filledAt` order. Out-of-order delivery from the venue could in theory leave gaps; in practice we persist on receipt and replay in time order.
