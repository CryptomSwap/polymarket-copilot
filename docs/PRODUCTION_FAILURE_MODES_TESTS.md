# Production Failure Modes Tests

Focused runtime tests for real production failure scenarios (not just happy-path lifecycle correctness). All tests are deterministic and require no live network or database.

## Run

From repo root:

```bash
npm run test:production-failure-modes
```

Or:

```bash
npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/production-failure-modes-tests.ts
```

## Scenarios Covered

| # | Scenario | What is tested |
|---|----------|----------------|
| 1 | **Market socket open but no real data** | `computeDegraded` marks runtime degraded when market stream has no `lastDataEventAt`; reason includes `market_data_silence` or `market_data_stale`. |
| 2 | **User socket open but no real data while working orders exist** | Degraded when user stream has no/stale data and `openOrderCount > 0`; reason includes `user_data_silence_with_orders` or `user_data_stale`. |
| 3 | **Reconnect churn causing degraded status** | High `reconnectAttempts` on market (or user) stream triggers degraded with reason `reconnect_churn`. |
| 4 | **Restart rebuild with open orders + prior fills** | `rebuildOrderStoreFromTruth` + `rebuildPositionStoreFromTruth` + `recomputeRiskExposure`: order store and position store correctly reflect exchange open orders and durable fills. |
| 5 | **Durable fill ledger replay after restart** | Replaying a list of unapplied fills via `rebuildPositionStoreFromTruth` applies fills to position store; second replay is idempotent/additive. |
| 6 | **Exchange reconciliation detects missing local order** | `compareRuntimeWithExchange` with exchange order IDs and empty local open orders: `missingLocalOrders` contains the exchange-only order ID. |
| 7 | **Exchange reconciliation detects phantom local order** | Local has working order acked to `ex-phantom`, exchange has no orders: `missingExchangeOrders` and `staleWorkingOrders` contain the phantom order. |
| 8 | **Scheduler overload / backlog** | `computeDegraded` with `schedulerBacklog` above threshold sets degraded and reason `scheduler_backlog_high`. |
| 9 | **Subscription coverage incomplete** | `computeDegraded` with `marketSubscriptionCoverage.inSync === false` and desired assets not subscribed: reason `subscription_mismatch`. |
| 10 | **Health endpoints remain truthful under stale-data** | `createRuntimeHealth` and `buildOperatorHealth` with stale market data: `dataFlowHealthy` false, `operationalReadiness` false, `safeToAutomate` false, degraded reason present. |
| 11 | **Guardrails block automation during rebuild / reconciling** | `guardrails.evaluate` with `freshness.runtimePhase === "rebuilding"` or `"reconciling"` returns verdict `frozen`. |
| 12 | **Kill switch triggered by severe stream silence** | `evaluateStreamWatchdog` with market data older than kill-switch threshold (and user stale with orders): `triggerKillSwitch === true`, `killSwitchReason` set. |

## Helper Utilities

The test file defines small helpers used only within the test module:

- **`openStateWithData()`** – `StreamConnectionState` with `status: "open"` and recent `lastDataEventAt` / `lastHeartbeatAt`.
- **`openStateNoData()`** – Same but `lastDataEventAt` undefined (heartbeat only).

No shared test utilities were added outside the test file; existing runtime modules (`computeDegraded`, `evaluateStreamWatchdog`, `compareRuntimeWithExchange`, rebuild helpers, guardrails, health builders) are used as-is.

## Relationship to Other Tests

- **stream-watchdog-degraded-tests.ts** – Overlaps on watchdog/reconnect/kill-switch; production-failure-modes re-asserts the same behaviors in one place and adds health/guardrail assertions.
- **stream-runtime-rebuild-tests.ts** – Rebuild and position replay (scenarios 4, 5) mirror those tests; production-failure-modes focuses on “restart with open orders + prior fills” and “replay after restart” as named failure-mode scenarios.
- **runtime-reconciliation-tests.ts** – Scenarios 6 and 7 use the same `compareRuntimeWithExchange` API and assert missing-local and phantom-local detection.
- **operator-health-tests.ts** – Scenario 10 uses `buildOperatorHealth` and `createRuntimeHealth` to assert truthful health under stale data.
- **guardrail-freshness-tests.ts** – Scenario 11 uses the same guardrail evaluation with phase-based freshness to assert frozen verdict during rebuild/reconciling.

These production-failure-modes tests are a single entry point that ensures all of the above behaviors hold together for production-style failure conditions.
