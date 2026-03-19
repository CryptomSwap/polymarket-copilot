# Guardrail Freshness Decision Policy

## Goal

Final order admission depends on **freshness truth** (market data, user stream, reconciliation, runtime phase), not just nominal connectivity. New entries are blocked when data is not trustworthy; reduce-only and cancel-only behavior can be expressed cleanly.

## Verdicts

| Verdict | Meaning |
|--------|--------|
| **allowed** | No blocking conditions; action may proceed. |
| **blocked** | Hard block (kill switch, exchange unhealthy, market/position degraded, etc.). |
| **requires_reduction** | New entry (PLACE_ENTRY, UPDATE_QUOTES) blocked; reduce/cancel (CANCEL_ORDERS, REDUCE_RISK, PLACE_EXIT) allowed. |
| **cancel_only** | Only CANCEL_ORDERS allowed (reserved for future use). |
| **frozen** | Runtime rebuilding/reconciling or exchange truth unverified; no orders allowed. |

## Reason Codes (Freshness / Phase)

- **market_data_stale** – Market stream has no recent real data (only heartbeat).
- **user_data_stale** – User stream stale and there are working orders (block new orders).
- **reconciliation_stale** – Runtime vs exchange reconciliation not recently successful.
- **runtime_rebuilding** – Runtime in rebuild phase (order/position stores being rebuilt).
- **runtime_reconciling** – Runtime in reconciling phase (not yet ready).
- **watchdog_kill_switch** – Kill switch tripped by stream watchdog (e.g. severe silence).
- **exchange_truth_unverified** – Exchange truth not verified (rebuilding/reconciling/starting).

## Decision Logic

1. **Frozen**  
   If any of: `runtime_rebuilding`, `runtime_reconciling`, `exchange_truth_unverified` → verdict **frozen**. No orders allowed.

2. **Hard block**  
   If kill switch (global/asset), exchange unhealthy, market/position degraded, etc. → verdict **blocked**.

3. **Freshness block (new entry only)**  
   If only freshness/phase codes (`market_data_stale`, `user_data_stale`, `reconciliation_stale`) and proposed action is **new entry** (PLACE_ENTRY, UPDATE_QUOTES) → verdict **requires_reduction**. Reduce/cancel actions do not get these codes for new-entry checks, so they can remain allowed.

4. **Reduce-only**  
   When verdict is **requires_reduction**, the **caller** allows the action only if it is CANCEL_ORDERS, REDUCE_RISK, or PLACE_EXIT; PLACE_ENTRY and UPDATE_QUOTES are blocked.

5. **Cancel-only**  
   When verdict is **cancel_only**, the caller allows only CANCEL_ORDERS (future use).

## Inputs (GuardrailFreshnessInput)

- **runtimePhase** – `starting` | `rebuilding` | `reconciling` | `ready` | `degraded` | `stopped`.
- **marketDataFresh** – True if market stream has recent real data (not just heartbeat).
- **userDataFresh** – True if user stream has recent real data.
- **reconciliationFresh** – True if runtime vs exchange reconciliation recently succeeded.
- **watchdogKillSwitch** – True if kill switch was tripped by watchdog.
- **openOrderCount** – Used to add `user_data_stale` only when there are working orders (block new orders when user stream is stale and orders exist).

## Diagnostics

- **intentsBlockedByFreshness** – Count of intents blocked due to freshness/phase reason codes.
- **freshnessBlockReasonCounts** – Per-reason counts (e.g. `market_data_stale`, `user_data_stale`).

## Files

- **lib/runtime/risk/runtime-guardrails.ts** – Verdicts, reason codes, `GuardrailFreshnessInput`, evaluate logic.
- **worker/stream-runtime.ts** – Builds freshness from stream state and reconciliation, passes to guardrails; allows reduce when verdict is `requires_reduction`.
- **lib/runtime/telemetry/runtime-diagnostics.ts** – `recordIntentBlockedByFreshness(reasonCodes)` and snapshot fields.
