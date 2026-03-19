# Bot Scheduler and Event Pipeline Overload Protection

Protections added so the bot scheduler and event pipeline do not collapse under flood or backlog.

## Protections

### 1. Max queue size

- **Config:** `SchedulerOverloadConfig.maxQueueSize` (default **500**).
- Pending evaluations are stored per assetId (coalesced). When the number of queued assetIds reaches `maxQueueSize`, new **low** and **normal** enqueues are **rejected** and counted as dropped.
- **High** and **priority** enqueues are **always accepted** so lifecycle-critical paths (order fills, position changes, risk/kill switch) are never blocked by strategy scheduler overload.

### 2. Overload threshold

- **Config:** `SchedulerOverloadConfig.overloadThreshold` (default **100**).
- When `queue.size + inFlight.size >= overloadThreshold`, the scheduler is considered **overloaded**.
- Used for:
  - **Degraded:** `computeDegraded()` already uses `schedulerBacklog >= schedulerBacklogThreshold` (default 100) to add reason `scheduler_backlog_high`.
  - **Diagnostics:** Each time load crosses above the threshold, `recordSchedulerOverload()` is called (overload period count).

### 3. Event coalescing metrics

- **Coalesced:** Enqueues where the assetId was already in the queue (merge by assetId). Counted in `schedulerCoalescedEvents` (diagnostics) and `scheduler.getCoalescedCount()`.
- **Dropped:** Enqueues rejected because the queue was at `maxQueueSize` and priority was low/normal. Counted in `schedulerDroppedEvents` and `scheduler.getDroppedCount()`.

### 4. Optional pause of new evaluations when overloaded

- When at `maxQueueSize`, **only** low/normal enqueues are dropped; high/priority are still queued.
- So “pause” is **selective**: strategy (normal) work can be shed; lifecycle (high/priority) continues.

### 5. Lifecycle-critical paths not blocked

- Events that use **high** or **priority** (e.g. `order.partial_fill`, `order.filled`, `order.stale`, `position.changed`, `market.stale`, `market.recovered`, `risk.limit_hit`, `risk.kill_switch_changed`) always call `enqueue(assetId, "high")` or `enqueueBatch(ids, "priority")`.
- At cap, only **low** and **normal** are dropped; high/priority are never dropped.

## Diagnostics

| Metric | Meaning |
|--------|--------|
| **schedulerQueueHighWaterMark** | Max queue size observed since start. |
| **schedulerDroppedEvents** | Enqueues rejected (queue full, low/normal). |
| **schedulerCoalescedEvents** | Enqueues that merged with existing assetId. |
| **schedulerLastEvaluationLatencyMs** | Last evaluation duration (ms). |
| **schedulerOverloadPeriodCount** | Number of times load crossed above overloadThreshold. |

Exposed in:

- `RuntimeDiagnosticsSnapshot` (and thus health/dashboard when runtime is running).
- Dashboard API: `diagnostics.schedulerQueueHighWaterMark`, `schedulerDroppedEvents`, `schedulerCoalescedEvents`, `schedulerLastEvaluationLatencyMs`, `schedulerOverloadPeriodCount`.

## Health / degraded logic

- **Degraded reason:** `scheduler_backlog_high` when `schedulerBacklog >= schedulerBacklogThreshold` (default **100**), as in `computeDegraded()` in `lib/runtime/runtime-degraded.ts`.
- Health continues to use `counts.schedulerBacklog` from `botRuntime.getSchedulerBacklog()` (current queue size).

## Config

**Default** (`DEFAULT_SCHEDULER_OVERLOAD_CONFIG` in `lib/runtime/bot-runtime/bot-scheduler.ts`):

- `maxQueueSize`: 500  
- `overloadThreshold`: 100  
- `dropLowPriorityWhenFull`: true  

StreamRuntime wires this and a `schedulerDiagnostics` callback into `DefaultBotRuntime` so scheduler metrics are recorded on the runtime diagnostics collector.

## Files touched

- **lib/runtime/bot-runtime/bot-scheduler.ts** — `SchedulerOverloadConfig`, `SchedulerDiagnosticsCallback`, max queue, drop low/normal at cap, high-water mark, coalesced/dropped/overload/latency tracking.
- **lib/runtime/bot-runtime/bot-runtime.ts** — Pass `overloadConfig` and `schedulerDiagnostics` into the scheduler.
- **lib/runtime/telemetry/runtime-diagnostics.ts** — `recordSchedulerCoalesced`, `recordSchedulerDropped`, `recordSchedulerEvaluationLatency`, `recordSchedulerOverload`, `recordSchedulerHighWaterMark`; snapshot fields for all of the above.
- **worker/stream-runtime.ts** — Wire `DEFAULT_SCHEDULER_OVERLOAD_CONFIG` and diagnostics callback when creating `DefaultBotRuntime`.
- **app/api/ops/runtime/dashboard/route.ts** — Include new scheduler diagnostics in dashboard payload.
- **lib/runtime/__tests__/scheduler-overload-protection-tests.ts** — Tests for burst, backlog threshold, lifecycle never dropped, degraded when backlog high, recovery after drain, overload period and latency.

## Tests

Run: `npm run test:scheduler-overload`

- Burst of market events: high-water mark and coalesced count.
- Scheduler backlog threshold: drop low/normal when full.
- Lifecycle-critical (high/priority) never dropped when at cap.
- Runtime degraded when scheduler backlog ≥ threshold.
- Recovery after backlog drains.
- Overload period count and `isOverloaded`.
- Evaluation latency recorded.
- Default config values.
