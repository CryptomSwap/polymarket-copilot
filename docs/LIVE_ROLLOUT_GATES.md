# Live Rollout Gates

This document defines the **phase definitions** for the live-readiness and rollout gate system, which code gates enforce each phase, what still prevents live trading today, and how operators should interpret readiness.

## Phase Definitions

| Phase | Meaning |
|-------|--------|
| **paper_only** | Default state. Bot operates in paper-only mode; no live order placement. No live request is being made. |
| **not_ready** | A live request or review has been indicated, but one or more mandatory controls are missing (e.g. runtime safety blocked, guards missing, credential or exchange truth not ready, durability/reconciliation incomplete). |
| **shadow_ready** | Architecture is sufficient for **shadow or live-simulation validation only** (e.g. execution ledger, execution policy, and live placement guards are in place), but other mandatory checks still fail. |
| **limited_ready** | All core control-plane gates pass, but e.g. required docs are missing or other soft requirements are not met; **still requires explicit human review** and does not enable live trading. |
| **ready_for_review** | All technical gates pass (including required docs). System is in a state where operators could **review** for a future live rollout. **Does NOT auto-enable live trading.** |

## Which Code Gates Enforce Each Phase

- **paper_only**: Default when `operatorMode === "paper_only"` and `manualLiveEnableRequested` is false. No special gate; evaluator sets `overallState` to `paper_only`.
- **not_ready**: Set when (manual live requested or operator mode ≠ paper_only) and (runtime safety blocked/kill_switch, or live placement guards missing, or credential/exchange truth not ready, or any mandatory durability/policy/risk/decision check fails). Enforced in `lib/live-readiness/evaluate.ts`.
- **shadow_ready**: Set when ledger + execution policy + live placement guards pass but some other mandatory checks fail, and a live request or non–paper_only mode is set. Enforced in the same evaluator.
- **limited_ready** / **ready_for_review**: Set when all mandatory checks pass; `requiredDocsPresent` differentiates limited_ready vs ready_for_review. Enforced in the same evaluator.
- **allowLiveTrading**: Always **false** in the current implementation. Enforced in `evaluate.ts` (no code path sets it to true) and in `assertLiveTradingNotPermittedUnlessReadinessPassed()` in `lib/live-readiness/state.ts`. The paper order manager calls this assert and `assertNoLiveOrderPlacement()` from `lib/runtime/runtime-config.ts` before reconciling intents.

## What Still Prevents Live Trading Now

1. **allowLiveTrading is hard-coded to false** in the live-readiness evaluator; there is no switch or config that sets it to true.
2. **Runtime config** (`lib/runtime/runtime-config.ts`) allows only `ROLLOUT_ALLOWED_MODES`: disabled, observe_only, paper. `RUNTIME_MODE=live` is rejected and clamped to the default (paper).
3. **Paper order manager** calls `assertNoLiveOrderPlacement()` and `assertLiveTradingNotPermittedUnlessReadinessPassed()`; the adapter health check rejects `mode === "live"`.
4. **Live adapter** (Polymarket CLOB) is stubbed and returns “not implemented”; no real order submission path exists.

## How Operators Should Interpret Readiness

- **overallState === "paper_only"**: Normal operation; bot is paper-only. No action required for safety.
- **overallState === "not_ready"**: If you intended to assess live readiness, one or more mandatory controls are missing. Review `blockingReasons` and `failedChecks` (e.g. from GET /api/ops/live-readiness) and address gaps before considering review.
- **overallState === "shadow_ready"**: Some controls are in place for shadow/simulation; not ready for real-money. Continue to close remaining gaps.
- **overallState === "limited_ready"**: Core technical gates pass; soft requirements (e.g. docs) may be missing. Explicit human review still required; no live trading is enabled.
- **overallState === "ready_for_review"**: All technical gates pass. Suitable for operator review for a **future** live rollout. Live trading is still **not** enabled; any future enablement would require a separate, explicit gate (not in this implementation).
- **allowLiveTrading**: Always false. If it were ever true (e.g. in a future codebase), that would indicate a bug or an intentional future gate that does not exist today.

Use GET /api/ops/live-readiness for the current state, and the worker heartbeat metadata when the worker is running for the same data in the heartbeat payload.
