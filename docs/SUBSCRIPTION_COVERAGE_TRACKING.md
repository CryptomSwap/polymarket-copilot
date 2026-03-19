# Market Subscription Coverage Tracking

Tracked asset subscriptions are kept aligned with what the runtime thinks it is watching. Subscription coverage is tracked explicitly and fed into degraded reasons and ops health.

## Subscription coverage state (market WebSocket)

The market WebSocket (`lib/polymarket/ws-market.ts`) maintains:

| Field | Meaning |
|-------|--------|
| **desiredTrackedAssetIds** | Asset IDs the runtime wants to watch (from `setTrackedAssetIds` / refresh). |
| **currentlySubscribedAssetIds** | Asset IDs we have sent subscribe/initial for and not yet unsubscribed (only updated when socket is open and send succeeds). |
| **pendingSubscribeIds** | `desired \ currentlySubscribed` — desired but not yet subscribed. |
| **pendingUnsubscribeIds** | `currentlySubscribed \ desired` — subscribed but no longer desired. |
| **lastSubscriptionRefreshAt** | When `setTrackedAssetIds` was last called (ISO string). |
| **lastSuccessfulSubscriptionSyncAt** | When we last sent initial or completed subscribe/unsubscribe and consider ourselves in sync (ISO string). |
| **desiredNotSubscribed** | Same as `pendingSubscribeIds` (desired IDs not in currentlySubscribed). |
| **subscribedButNotDesired** | Same as `pendingUnsubscribeIds`. |
| **inSync** | `desiredNotSubscribed.length === 0 && subscribedButNotDesired.length === 0`. |
| **subscriptionChurnCount** | Number of subscription changes (initial or subscribe/unsubscribe) in the last 5 minutes. |

Updates happen only when the socket is open: `sendInitialSubscription`, `sendSubscribe`, and `sendUnsubscribe` update `subscribedIds` and timestamps only if `ws?.readyState === 1`.

## Detection and surfaced conditions

- **Desired assets not actually subscribed** — `desiredNotSubscribed` (and `pendingSubscribeIds`).
- **Assets subscribed but no longer desired** — `subscribedButNotDesired` (and `pendingUnsubscribeIds`).
- **Repeated subscription churn** — `subscriptionChurnCount >= subscriptionChurnThreshold` (default 8 in 5 min) → degraded reason `subscription_churn`.
- **Reconnect followed by incomplete resubscribe** — When market is open, desired count > 0, `desiredNotSubscribed.length > 0`, and `lastSuccessfulSubscriptionSyncAt` is null or older than `subscriptionSyncStaleMs` (default 2 min) → degraded reason `incomplete_resubscribe`.

## Degraded reasons

- **subscription_mismatch** — Market WS open and `!coverage.inSync`.
- **subscription_churn** — Market WS open and `coverage.subscriptionChurnCount >= subscriptionChurnThreshold`.
- **incomplete_resubscribe** — Market WS open, desired not empty, `desiredNotSubscribed` not empty, and last successful sync is stale or null.

These are computed in `computeDegraded()` in `lib/runtime/runtime-degraded.ts` only when `marketSubscriptionCoverage` is provided and `marketConnection.status === "open"`.

## Integration

- **Runtime health** — `RuntimeHealth.marketSubscriptionCoverage` is set from `getMarketSubscriptionCoverage()` in the worker (when StreamRuntime builds health). Same shape as `MarketSubscriptionCoverageSnapshot` in `lib/runtime/runtime-health.ts`.
- **Ops endpoints** — `marketSubscriptionCoverage` is included in:
  - `GET /api/ops/runtime/health`
  - `GET /api/ops/runtime/dashboard`
  - `GET /api/ops/runtime/snapshot`
  - `GET /api/live/stream-health` (when present in heartbeat metadata)

- **Worker** — `getMarketSubscriptionCoverage()` in `worker/websockets.ts` returns the coverage from the current market WS instance (if it has `getSubscriptionCoverage`). StreamRuntime calls it in `getHealth()` and passes the result to `computeDegraded` and into the health payload.

## Files touched

- **lib/polymarket/ws-market.ts** — `MarketSubscriptionCoverage` type; state (`subscribedIds`, `lastSubscriptionRefreshAt`, `lastSuccessfulSubscriptionSyncAt`, `subscriptionChangeTimestamps`); updates in `sendInitialSubscription`, `sendSubscribe`, `sendUnsubscribe`, `setTrackedAssetIds`; `getSubscriptionCoverage()`; export `getConnectionState` and `getSubscriptionCoverage` in return type.
- **worker/websockets.ts** — `getMarketSubscriptionCoverage()`.
- **lib/runtime/runtime-health.ts** — `MarketSubscriptionCoverageSnapshot`, `RuntimeHealth.marketSubscriptionCoverage`.
- **lib/runtime/runtime-degraded.ts** — `DegradedInputs.marketSubscriptionCoverage`, `subscriptionChurnThreshold`, `subscriptionSyncStaleMs`; reasons `subscription_mismatch`, `subscription_churn`, `incomplete_resubscribe`.
- **worker/stream-runtime.ts** — Get coverage and pass to `computeDegraded` and `createRuntimeHealth`.
- **app/api/ops/runtime/health/route.ts**, **dashboard/route.ts**, **snapshot/route.ts**, **app/api/live/stream-health/route.ts** — Include `marketSubscriptionCoverage`.
- **lib/runtime/__tests__/subscription-coverage-tests.ts** — Tests for coverage shape, refresh, degraded reasons, no false green.

## Tests

Run: `npm run test:subscription-coverage`

- Tracked asset refresh: desired and pending before/after `setTrackedAssetIds`.
- Coverage shape and `lastSubscriptionRefreshAt`.
- Incomplete subscription coverage surfaced (degraded + `subscription_mismatch` + `incomplete_resubscribe`).
- No false green when tracked assets exist but coverage incomplete.
- Subscription churn reason when count ≥ threshold.
- In sync: no subscription reasons.
- Null coverage: no subscription reasons.
- Subscribed but not desired surfaces `subscription_mismatch`.
