# Live Readiness Checklist

This document lists the **mandatory technical and operator/process requirements** that must be satisfied before the bot could move from paper-only to any form of live or shadow validation. It does **not** enable live trading; it defines the explicit, auditable path and current status.

## Mandatory Technical Controls

| Check | Description | Status (current) |
|-------|-------------|------------------|
| **runtimeSafetyState** | Runtime safety state machine is in normal or degraded (not blocked/kill_switch). | ✅ Evaluated from worker |
| **executionLedgerReady** | Execution ledger is implemented and used for order intent and executed order persistence. | ✅ Implemented |
| **fillReplayRecoveryReady** | Fill replay and startup recovery are implemented and durable. | ✅ Implemented |
| **orderIntentDurabilityReady** | Order intent lifecycle is durably persisted (creation, policy, events). | ✅ Implemented |
| **cancelReplaceDurabilityReady** | Cancel/replace requests and lifecycle are durably persisted. | ✅ Implemented |
| **reconciliationAlignmentReady** | Reconciliation updates and aligns with durable ledger state. | ✅ Implemented |
| **executionPolicyReady** | Execution policy gate is in place and blocks unsafe orders. | ✅ Implemented |
| **executionQualityReady** | Execution quality (spread, depth, slippage) guardrails are in place. | ✅ Implemented |
| **portfolioRiskReady** | Portfolio risk engine is integrated and used. | ✅ Implemented |
| **decisionEngineReady** | Staged decision engine is the active path (no legacy blend). | ✅ Implemented |
| **exchangeCredentialValidationReady** | Exchange credential validation is available and used. | ✅ Implemented |
| **exchangeTruthHealthy** | Exchange truth (orders/fills) is healthy and recent (from streams/reconciliation). | ✅ Evaluated from runtime health |
| **livePlacementGuardsPresent** | Live placement guards (e.g. `assertNoLiveOrderPlacement`, adapter mode check) are present. | ✅ Implemented |
| **requiredDocsPresent** | Required docs/runbooks exist (this checklist, rollout gates). | ✅ After this deliverable |

## Operator / Process Requirements

- **Operator mode** remains **paper_only** unless explicitly changed for review purposes; no automatic live enablement.
- **Manual live enable request** is only a signal for “evaluate for review”; it does **not** enable live trading.
- **Environment**: Use appropriate env (e.g. staging) for any shadow or limited-review testing; production live would require additional process sign-off.
- **Runbooks**: Operators should use LIVE_ROLLOUT_GATES.md and this checklist when assessing readiness.

## What Is Complete vs Incomplete Today

- **Complete**: All mandatory technical controls above are implemented. The live-readiness evaluator runs in the worker and exposes state via GET /api/ops/live-readiness. `allowLiveTrading` is always `false`; no code path enables live order placement.
- **Incomplete for live**: No explicit “go live” gate or credential/risk sign-off process; no production live adapter; no UI to request “ready_for_review” or to display readiness in a dedicated ops dashboard (API only).

## Exact Items Required Before Limited Live Review

Before moving to **limited_ready** or **ready_for_review** in the evaluator (still without enabling live trading):

1. All mandatory technical checks must pass (see table above).
2. **requiredDocsPresent** must be true (this checklist and LIVE_ROLLOUT_GATES.md exist and are referenced).
3. **Runtime safety** must not be blocked or kill_switch.
4. **Exchange truth** and **credential validation** must be healthy/ready when the worker is running.
5. **Manual live enable requested** or operator mode set to a non–paper_only value only for the purpose of viewing “ready_for_review” or “limited_ready”; no code path may set `allowLiveTrading` to true.

No additional items are required for **paper_only** operation; the default is paper-only and fail-closed.
