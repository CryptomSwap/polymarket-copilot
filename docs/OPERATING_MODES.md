# Operational Runtime Modes

Explicit operating modes beyond simple paper/observe-only: telemetry_only, frozen, cancel_only, reduce_only, paper_full, disabled. Mapped onto execution policy and guardrails; mode transitions are visible in health endpoints.

## Mode semantics

| Mode | Behavior |
|------|----------|
| **disabled** | No automation; no bot evaluations or order flow. |
| **telemetry_only** | Evaluate + observe; no intents admitted. Bot runs and emits telemetry only; no order intents, no reconciliation. |
| **frozen** | No new action; no cancel unless explicitly requested (e.g. manual). No intents admitted on the automated path. |
| **cancel_only** | Only cancel permitted. Automated path may submit CANCEL_ORDERS only. |
| **reduce_only** | Only risk-reducing actions permitted: cancel, reduce, exit. Automated path may submit CANCEL_ORDERS, REDUCE_RISK, PLACE_EXIT; no PLACE_ENTRY or UPDATE_QUOTES. |
| **paper_full** | Full paper pipeline: intents, reconciliation, paper adapter. New entry and reduce actions allowed subject to guardrails. |

## Mapping from config and guardrails

- **Runtime mode (config):**
  - `disabled` → operating mode **disabled** (source: config).
  - `observe_only` → **telemetry_only** (source: config).
  - `paper` / `live_stub` → base **paper_full**; then phase and guardrails can override.

- **Runtime phase:**
  - When phase is not `ready` (e.g. `starting`, `rebuilding`, `reconciling`, `degraded`, `stopped`) → **frozen** (source: phase). No intents admitted until ready.

- **Guardrail verdict** (when phase is `ready` and config allows automation):
  - `frozen` → **frozen** (source: guardrail).
  - `cancel_only` → **cancel_only** (source: guardrail). Used when only kill-switch codes are present so cancel remains allowed.
  - `requires_reduction` → **reduce_only** (source: guardrail).
  - `allowed` or `blocked` → **paper_full** (source: config or guardrail). Per-intent blocking still applies when verdict is `blocked`.

Execution policy (e.g. `isExecutionAllowed("runtime_automated")`) is unchanged: it is driven by runtime mode (disabled / observe_only / paper). Guardrails then further restrict what each intent can do (frozen, cancel_only, requires_reduction, blocked).

## Health endpoints

- **operatingMode**: Effective mode (`telemetry_only` | `frozen` | `cancel_only` | `reduce_only` | `paper_full` | `disabled`).
- **operatingModeSource**: Why this mode is in effect: `config`, `phase`, or `guardrail`.

Exposed in:

- `RuntimeHealth.operatingMode`, `RuntimeHealth.operatingModeSource`
- GET /api/ops/runtime/health
- GET /api/ops/runtime/dashboard
- GET /api/ops/runtime/snapshot

Mode transitions are therefore explicit and visible: as phase or guardrail verdict changes, the next health response shows the new operating mode and source.

## Implementation

- **lib/runtime/operating-mode.ts** — `OperatingMode` type, `getEffectiveOperatingMode()`, helpers `isNoIntentAdmitted`, `isCancelOnly`, `isReduceOnly`, `isPaperFull`.
- **lib/runtime/risk/runtime-guardrails.ts** — When the only reason codes are kill-switch (global, watchdog, asset), verdict is **cancel_only** so that cancel remains permitted.
- **worker/stream-runtime.ts** — Stores `lastGuardrailVerdict` after each intent evaluation; in `getHealth()` computes effective operating mode from config, phase, and last verdict; adds `operatingMode` and `operatingModeSource` to health.
- **lib/runtime/runtime-health.ts** — `RuntimeHealth` includes optional `operatingMode` and `operatingModeSource`.

Intent handler behavior is unchanged: it already allows intents only when verdict is `allowed`, or `cancel_only` + CANCEL_ORDERS, or `requires_reduction` + reduce actions. Frozen and blocked intents are not admitted.

## Safe rollout

Rollout behavior is unchanged: `ROLLOUT_ALLOWED_MODES` and execution policy still limit effective runtime mode to disabled, observe_only, paper. Live and manual execution remain off; operating mode only refines how paper/observe are reported and how guardrail verdicts (e.g. kill-switch → cancel_only) map to a named mode.

## Tests

Run: `npm run test:operating-mode`

- Config disabled → disabled; observe_only → telemetry_only; phase not ready → frozen; guardrail frozen/cancel_only/requires_reduction → frozen/cancel_only/reduce_only; paper + allowed/blocked → paper_full.
- Policy: disabled/observe_only → runtime_automated not allowed; paper → allowed.
- Helpers: isNoIntentAdmitted, isCancelOnly, isReduceOnly, isPaperFull.
- Safe rollout: live not in allowedModes, automated allowed in paper.
