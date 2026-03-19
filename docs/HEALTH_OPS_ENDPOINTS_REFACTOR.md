# Health and Ops Endpoints Refactor

Operators can distinguish **connected**, **receiving heartbeat**, **receiving real data**, **reconciled**, and **safe to automate** via a structured operator health payload and updated routes.

## New: `operatorHealth` payload

Runtime health now includes an optional **`operatorHealth`** object with separate sections. Prefer these over legacy `streams.*` booleans, which can appear "green" while data is stale.

### Sections

| Section | Purpose |
|--------|--------|
| **connection** | Socket open/closed only. `market.socketStatus`, `user.socketStatus`, `bothConnected`. |
| **heartbeat** | PING/PONG recently seen. `market.lastHeartbeatAt`, `market.healthy`, `user.*`, `bothHealthy`. |
| **dataFreshness** | Real exchange data (not heartbeat). `market.lastDataEventAt`, `market.dataFlowHealthy`, `user.*`, `bothHealthy`. |
| **reconciliation** | Runtime vs exchange. `lastRunAt`, `lastSuccessAt`, `healthy`, `driftDetected`, `reconcileDurationMs`. |
| **readiness** | Phase and automation. `runtimePhase`, `operationalReadiness`, `automationPermitted`, `safeToAutomate`. |
| **killSwitch** | Global automation. `globalAutomationEnabled`, `tripped`, `reasons`. |
| **executionPolicy** | Platform policy (when available). |

### Key fields (requested names)

- **market.socketStatus** — `open` \| `connecting` \| `reconnecting` \| `closed` \| `unknown`
- **market.lastHeartbeatAt** — ISO string or null
- **market.lastDataEventAt** — ISO string or null
- **market.dataFlowHealthy** — boolean
- **user.socketStatus**, **user.lastHeartbeatAt**, **user.lastDataEventAt**, **user.dataFlowHealthy** — same
- **reconciliation.lastRunAt**, **reconciliation.lastSuccessAt**, **reconciliation.healthy**
- **readiness.runtimePhase** — `starting` \| `rebuilding` \| `reconciling` \| `ready` \| `degraded` \| `stopped`
- **readiness.automationPermitted** — true only when phase is `ready` and kill switch allows
- **readiness.safeToAutomate** — true when operationalReadiness, globalAutomationEnabled, and reconciliation healthy

## Old vs new (summary)

| Old / misleading | New / preferred |
|------------------|-----------------|
| `streams.marketWsConnected` (can be true while data stale) | `operatorHealth.connection.market.socketStatus` + `operatorHealth.dataFreshness.market.dataFlowHealthy` |
| `streams.userWsConnected` | `operatorHealth.connection.user.socketStatus` + `operatorHealth.dataFreshness.user.dataFlowHealthy` |
| `streams.socketOpen` | `operatorHealth.connection.bothConnected` |
| `streams.heartbeatHealthy` | `operatorHealth.heartbeat.bothHealthy`, `operatorHealth.heartbeat.market.lastHeartbeatAt`, `user.*` |
| `streams.dataFlowHealthy` | `operatorHealth.dataFreshness.bothHealthy`, `operatorHealth.dataFreshness.market.lastDataEventAt`, `user.*` |
| `streams.operationalReadiness` | `operatorHealth.readiness.operationalReadiness` + `operatorHealth.readiness.safeToAutomate` |
| (none) | `operatorHealth.reconciliation.lastRunAt`, `lastSuccessAt`, `healthy` |
| (none) | `operatorHealth.readiness.runtimePhase`, `automationPermitted` |
| `globalAutomationEnabled` at root | `operatorHealth.killSwitch.globalAutomationEnabled`, `operatorHealth.killSwitch.tripped`, `reasons` |

Legacy `streams.*` fields are **deprecated** for operator decisions but kept for backward compatibility. Use `operatorHealth` for correct "connected vs heartbeat vs real data vs reconciled vs safe to automate" checks.

## Routes updated

| Route | Change |
|------|--------|
| **GET /api/ops/runtime/health** | Response includes top-level `operatorHealth` (from `runtimeHealth.operatorHealth`). |
| **GET /api/ops/runtime/dashboard** | Dashboard payload includes `operatorHealth`. |
| **GET /api/ops/runtime/snapshot** | Snapshot includes `operatorHealth`. |
| **GET /api/live/stream-health** | When runtime is running, response includes `operatorHealth`; `runtime` still has legacy stream fields. |
| **GET /api/live/ws-status** | Added `streamHealthUrl: "/api/live/stream-health"` for operator clarity. |
| **GET /api/orders/ws-status** | Added `streamHealthUrl`, `opsHealthUrl` for runtime stream health. |
| **GET /api/polymarket/health** | Added `streamHealthUrl` (wallet/credentials only; stream health is separate). |
| **GET /api/polymarket/sync-health** | Added `streamHealthUrl` for runtime stream/reconciliation health. |

## Backward compatibility

- All existing `runtimeHealth` and `streams` fields are unchanged; `operatorHealth` is additive.
- Clients that only read `streams.socketOpen` or `streams.operationalReadiness` continue to work but should migrate to `operatorHealth` for correct semantics.
- No breaking changes to response status codes or error shapes.

## Tests

- **lib/runtime/__tests__/operator-health-tests.ts** — `buildOperatorHealth` shape, `safeToAutomate` when all conditions met, and when reconciliation is stale.
- Run: `npm run test:operator-health`
