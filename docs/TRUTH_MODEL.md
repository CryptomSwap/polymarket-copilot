# Runtime Truth Model

The runtime uses an **exchange-truth authority** model so execution correctness does not rely primarily on websocket continuity.

## Hierarchy of truth (highest to lowest)

1. **Exchange authoritative pull state** – REST snapshots: open orders (canonical `GET /orders`), recent fills (`GET /data/trades`). Timestamped and used for freshness and reconciliation.
2. **Durable local journals / ledgers** – Fill ledger (DB) for replay and rebuild; order state can be rebuilt from exchange + ledger.
3. **Runtime in-memory state** – Order lifecycle store, position store. Updated from WS and from reconciliation/rebuild.
4. **Websocket event flow** – Low-latency transport only; not sole source of truth for execution decisions.

## Concepts

| Concept | Authority | Notes |
|--------|-----------|--------|
| Open orders | Exchange pull snapshot | WS acks/cancels are transport; reconciliation compares snapshot vs runtime. |
| Fills | Exchange pull + fill ledger | Ledger is durable replay source; recent trades pull refreshes freshness. |
| Runtime positions | Derived from fills + ledger | Rebuilt from ledger on startup; reconciled with exchange where applicable. |
| Exposure | Derived from positions + orders | Gated by exchange truth freshness when admitting new orders. |
| Stream freshness | WS `lastDataEventAt` | Transport health only; not sufficient alone for execution correctness. |
| Reconciliation state | Exchange snapshot vs runtime vs ledger | Drift triggers repair recommendations; no blind auto-repair when uncertain. |

## Truth freshness

- **lastExchangeOrdersSnapshotAt** – Time of last successful open-orders pull.
- **lastExchangeFillsSnapshotAt** – Time of last successful recent-fills pull.
- **exchangeTruthHealthy** – Both snapshots are within configured staleness thresholds.
- **exchangeTruthStaleReasonCodes** – `exchange_truth_stale`, `exchange_truth_unavailable`, `exchange_truth_orders_stale`, `exchange_truth_fills_stale`.

## Order admission gating

New automated order admission is **blocked** when:

- Exchange truth is stale beyond threshold (orders or fills snapshot too old).
- Exchange truth unavailable (no credentials or pull failed) while working orders exist.
- Runtime cannot verify current order state safely (e.g. phase rebuilding/reconciling).

No unsafe live execution changes; no blind auto-repair when truth is uncertain (paper-safe).

## Implementation

- **Types and freshness:** `lib/runtime/truth/runtime-truth-model.ts`
- **Authoritative pull:** `lib/runtime/truth/exchange-truth-pull.ts`
- **Health/degraded:** `runtime-health.ts` (truthModelStatus, operatorHealth.truthModel), `runtime-degraded.ts` (exchange_truth_* reasons)
- **Guardrails:** `runtime-guardrails.ts` (EXCHANGE_TRUTH_STALE, EXCHANGE_TRUTH_UNAVAILABLE; block when working orders and truth stale/unavailable)
- **Runtime:** `worker/stream-runtime.ts` (periodic pull on reconcile interval; timestamps and unavailable flag; guardrail freshness input)
