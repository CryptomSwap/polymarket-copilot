# Market runtime readiness fix

## Observed state

After the stream runtime startup rebuild fix:

- `/api/live/stream-health`: `socketOpen = false`, `dataFlowHealthy = false`, `operationalReadiness = false`
- `marketSubscriptionCoverage.desiredTrackedAssetIds = []`, `currentlySubscribedAssetIds = []`, `inSync = false`
- `/api/live/ws-status`: `marketFeed.connected = false`, `userFeed.connected = true`
- `trackedAssetCount = 300` (from DB)
- ShadowCandidate total remains 0

So the DB said we had 300 tracked assets, but the market WebSocket and subscription coverage showed no desired IDs and the market feed never became connected.

## Why trackedAssetCount could be 300 while desiredTrackedAssetIds stayed empty

Two separate sources were out of sync:

1. **`trackedAssetCount`** in the stream-health response comes from **`stream_sync_state`** (DB). That row is updated when:
   - The worker calls `updateStreamSyncState({ trackedAssetCount: assetIds.length })` at startup and on each **refresh** (every 90s).
   - So 300 could be from a previous run or from a refresh that saw 300 assets.

2. **`desiredTrackedAssetIds`** comes from the **market WebSocket** object in the worker (`marketWs.getSubscriptionCoverage()`). That list is set when:
   - The worker creates the market WS with `createMarketWs(assetIds)` and when it calls `marketWs.setTrackedAssetIds(assetIds)` on refresh.

So we had two ways to get “empty” even though the DB said 300:

- **Startup:** `getTrackedAssetIds({ funderAddress: funder })` returned `[]` (e.g. funder missing or DB not ready), so we never created the market WS or we created it with `[]`. Then `desiredTrackedAssetIds` stayed empty while `stream_sync_state.trackedAssetCount` could still be 300 from an earlier run.
- **Refresh:** Every 90s we call `getTrackedAssetIds()`, then `marketWs.setTrackedAssetIds(assetIds)`. If one refresh returned `[]` (transient DB/query issue), we overwrote the previous non-empty list with `[]`, so the market WS and engine had no desired IDs and the feed stopped being useful.

In both cases the **market state store** and **market WS** in the worker no longer had the same list as the DB’s count, so `socketOpen` / `marketFeed.connected` and subscription coverage stayed false or empty.

## Why marketFeed.connected / socketOpen stayed false

- The market WebSocket is only created when `assetIds.length > 0` at startup. If startup got `[]`, we never created it → no connection → `marketFeed.connected = false`, `socketOpen = false`.
- If we did create it but a later refresh set `setTrackedAssetIds([])`, we didn’t close the WS, but `desiredTrackedAssetIds` became `[]`, so coverage looked empty and the runtime didn’t consider the market feed meaningfully active.

So the root cause was the **disconnect between** (a) the DB’s `stream_sync_state.trackedAssetCount` and (b) the worker’s in-memory list used for the market WS and subscription coverage.

## Exact fix

### 1. Startup: fallback when DB says we have assets but first fetch is empty

**File:** `worker/websockets.ts` (`startWebsocketsWithRuntime`)

- After `getTrackedAssetIds({ funderAddress: funder })`, if the result is **empty**, read **`getStreamSyncState()`**.
- If `syncState.trackedAssetCount > 0`, retry **`getTrackedAssetIds({ funderAddress: undefined })`** (no funder filter) and use that list for:
  - `updateStreamSyncState({ trackedAssetCount })`
  - `marketStateEngine.setTrackedAssetIds(assetIds)`
  - `createMarketWs(assetIds)` when `assetIds.length > 0`

So if the DB already says we have a non-zero count, we don’t leave the market WS uncreated or with an empty list just because the first funder-scoped call returned `[]`.

**Helper:** `shouldRetryTrackedAssetsWithNoFunder(assetIds, syncStateTrackedCount)` in `lib/live/streaming-sync.ts` returns true when `assetIds.length === 0` and `(syncStateTrackedCount ?? 0) > 0`. The worker uses this to decide whether to retry with `funderAddress: undefined`.

### 2. Refresh: do not overwrite with empty

**File:** `worker/websockets.ts` (`refreshTrackedAssetsAndSubscriptions`)

- When **`marketWs`** already exists, only call **`marketWs.setTrackedAssetIds(assetIds)`** and **`marketStateEngine.setTrackedAssetIds(assetIds)`** when **`assetIds.length > 0`**.
- If the refresh returns `[]`, we still update **`stream_sync_state.trackedAssetCount`** to 0 (so the DB reflects the current query), but we **do not** replace the in-memory desired list with `[]`. So a transient empty result doesn’t clear the market WS subscription list.

No other logic was changed; only how we populate and update the list used for the market WS and engine.

## How to verify the fix locally

1. **Run the regression test**
   ```bash
   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/market-runtime-readiness-tests.ts
   ```
   This checks `shouldRetryTrackedAssetsWithNoFunder` (retry when empty + non-zero count; no retry otherwise).

2. **Run the worker with StreamRuntime**
   - Set `USE_STREAM_RUNTIME=true` and start the worker.
   - After startup (and after the first heartbeat, e.g. within ~30s), call `/api/live/stream-health`.
   - When the DB has a non-zero `stream_sync_state.trackedAssetCount` and the worker has credentials/funder, you should see:
     - `marketSubscriptionCoverage.desiredTrackedAssetIds` non-empty when there are tracked assets,
     - and once the market WS connects, `socketOpen = true`, `marketFeed.connected = true` (and in time `dataFlowHealthy` / `operationalReadiness` can become true when the rest of the readiness conditions are met).

3. **ShadowCandidate generation**
   - Once the runtime is operational (market feed connected, readiness true), the pipeline that creates ShadowCandidates can run.
   - Run `npm run check:shadow-pipeline` periodically; after the runtime is healthy and making decisions, ShadowCandidate total should start to increase if the rest of the pipeline is wired and active.

## Constraints

- No live trading logic was changed.
- Fix is limited to how we load and refresh the tracked asset list for the market WebSocket and market state engine, and to the startup fallback when the DB says we have assets but the first fetch is empty.
