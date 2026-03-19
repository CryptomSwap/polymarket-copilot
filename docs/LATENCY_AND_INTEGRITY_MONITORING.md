# Latency and Data-Integrity Monitoring

The runtime tracks stream-to-engine latency, internal processing latency, and data-integrity indicators so operators can detect not only stale streams but degraded data quality and slow processing.

## Observability

### Latency metrics (rolling window)

- **marketStreamToEngine** – Market message receive timestamp → engine apply complete (ms).
- **userStreamToEngine** – User message receive → lifecycle apply complete (ms).
- **marketNormalization** – Time to normalize a market WS message (ms).
- **userNormalization** – Time to normalize a user WS message (ms).
- **marketEngineApply** – Time to apply normalized market updates to the engine (ms).
- **lifecycleApply** – Time to apply a user lifecycle event (ack/fill/cancel) (ms).
- **botEvaluation** – Bot/scheduler evaluation latency (ms).
- **guardrailEvaluation** – Guardrail evaluation latency (ms).
- **reconcileDuration** – Intent reconciliation run duration (ms).
- **rebuildDuration** – Startup rebuild duration (ms).
- **heartbeatLatency** – Heartbeat round-trip when available (ms).

Each series keeps a rolling sample (default 100). The snapshot exposes **lastMs**, **p50Ms**, **p95Ms**, **maxRecentMs**, and **sampleCount** for operator dashboards.

### Data-integrity counters

- **malformedMarketPayloads** – Market WS messages that failed to normalize or were empty/unknown type.
- **malformedUserPayloads** – User WS messages that failed to normalize.
- **outOfOrderFills** – Out-of-order fill events (when recorded).
- **unmatchedExchangeOrderIds** – User-feed lifecycle events with no matching local order.
- **duplicateLifecycleEvents** – Duplicate fill/lifecycle skipped (e.g. fill ledger duplicate).
- **droppedSchedulerEvents** – Scheduler enqueues rejected (queue full).
- **coalescedSchedulerEvents** – Scheduler enqueues merged with existing asset.
- **subscriptionMismatchDurationMs** – Cumulative time subscription was out of sync (optional).
- **streamSilencePeriods** – Number of times stream silence was detected (e.g. by watchdog).

## Degraded reasons

When thresholds are exceeded, the monitor returns reasons that are merged into runtime degraded:

- **market_processing_latency_high** – Market stream-to-engine max recent ≥ threshold (default 5s).
- **user_processing_latency_high** – User stream-to-engine max recent ≥ threshold (default 5s).
- **reconcile_latency_high** – Reconcile duration max recent ≥ threshold (default 30s).
- **malformed_payload_rate_high** – Malformed (market + user) count in rate window ≥ threshold (default 10 in 60s).
- **out_of_order_event_rate_high** – Out-of-order fill count in rate window ≥ threshold (default 5 in 60s).

## Integration

- **Worker websockets** – On market message: record receive time → normalize → apply → record market stream-to-engine, normalization, and engine-apply latencies; on empty/throw, record malformed market. On user message: same pattern; on unmatched or duplicate lifecycle, call integrity callbacks that update the monitor.
- **Stream runtime** – Creates `RuntimeLatencyMonitor`, passes it to `startWebsocketsWithRuntime`, records rebuild duration, reconcile duration, bot evaluation (via scheduler diagnostics), and guardrail evaluation; records stream silence when watchdog reasons include "silence"; syncs scheduler dropped/coalesced to monitor.
- **Health** – `getHealth()` includes `latencyAndIntegrity` (full snapshot) and passes `latencyDegradedReasons` into `computeDegraded()`.
- **Dashboard** – `GET /api/ops/runtime/dashboard` exposes `latencyAndIntegrity` from runtime health when the worker reports it.

## Implementation notes

- **Lightweight** – Fixed-size rolling arrays, no external metrics backend. All recording is non-blocking.
- **Config** – Thresholds and rolling size are configurable via `RuntimeLatencyMonitorConfig`.
- **Reset** – `reset()` clears all series and counters (e.g. for tests).
