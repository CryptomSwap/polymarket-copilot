# StreamRuntime startup rebuild fix

## Observed error

```
TypeError: Cannot read properties of undefined (reading 'catch')
at lib/runtime/startup/stream-runtime-rebuild.ts:94:8
inside rebuildOrderStoreFromTruth(...)
```

## Root cause

In `rebuildOrderStoreFromTruth`, when `journalAppend` is provided the code did:

```ts
void journalAppend({ ... }).catch(() => {});
```

The type of `journalAppend` is `(params: AppendOrderLifecycleEventParams) => void | Promise<void>`. When the implementation returns **void** (synchronous), the result of `journalAppend(...)` is `undefined`. Calling `.catch(() => {})` on that value throws: `undefined` has no `.catch` property.

So any caller that passes a **synchronous** journal callback (returning `void`) triggered the crash. The worker passes a journal function that may be sync in some code paths; when rebuild ran after exchange orders were loaded, it called that callback and crashed.

## Exact code fix

**File:** `lib/runtime/startup/stream-runtime-rebuild.ts`

**Before:** Call `journalAppend(...)` and chain `.catch()` on its return value.

**After:** Store the return value and only attach `.catch` to a Promise:

```ts
if (journalAppend) {
  const result = journalAppend({
    funderAddress: funder,
    clientOrderId,
    exchangeOrderId: ex.id,
    assetId: ex.asset_id,
    marketId: ex.market,
    side: ex.side,
    eventType: ORDER_LIFECYCLE_EVENT_TYPES.REBUILD_IMPORTED,
    payloadJson: JSON.stringify({ ... }),
    occurredAt: now,
  });
  void Promise.resolve(result).catch(() => {});
}
```

`Promise.resolve(x)` returns a Promise that resolves with `x`; if `x` is already a Promise, it is adopted. So both `void` and `Promise<void>` are handled: we never call `.catch` on undefined.

## Why this blocked ShadowCandidate creation

1. **StreamRuntime** must complete its startup rebuild (exchange orders → order store, ledger fills → position store, then risk recompute) before it marks itself **ready** and starts the normal flow.
2. The crash happened **inside** `rebuildOrderStoreFromTruth`, so the rebuild never finished and the runtime never reached the “ready” state.
3. While not ready, the runtime does not run intent generation or the pipeline that records **ShadowCandidate** rows. So `/api/live/stream-health` showed `operationalReadiness=false`, and ShadowCandidate total stayed 0.

Fixing the `.catch` on undefined allows the rebuild to complete, the runtime to become operational, and the rest of the pipeline (including shadow telemetry) to run.

## How to verify the fix locally

1. **Unit test (regression):**
   ```bash
   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/stream-runtime-rebuild-tests.ts
   ```
   The test “rebuildOrderStoreFromTruth: journalAppend returning void must not throw” calls `rebuildOrderStoreFromTruth` with a synchronous `journalAppend` that returns `void` and asserts it does not throw and that the journal is invoked.

2. **Runtime startup:** Start the worker (and app if needed) so StreamRuntime runs. After “startup_rebuild_exchange_orders_success”, the rebuild should complete without crashing. Then:
   - `/api/live/stream-health`: `operationalReadiness` should become `true` when the runtime is ready.
   - `/api/live/ws-status`: `marketFeed.connected` should reflect the real connection state.
   - Shadow telemetry: once the bot is making decisions, `npm run check:shadow-pipeline` should eventually show ShadowCandidate rows (if the rest of the pipeline is wired and active).

## Constraints

- No live trading logic was changed.
- Fix is minimal: only how we handle `journalAppend`’s return value so we never call `.catch` on undefined.
