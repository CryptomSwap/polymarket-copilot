/**
 * Live-readiness and rollout gate: explicit, auditable path from paper-only to any future real-money enablement.
 * Fail-closed; allowLiveTrading remains false.
 */

export * from "./types";
export {
  evaluateLiveReadiness,
  buildDefaultLiveReadinessInput,
  buildLiveReadinessInputFromRuntime,
} from "./evaluate";
export {
  updateLiveReadinessState,
  getLiveReadinessState,
  assertLiveTradingNotPermittedUnlessReadinessPassed,
} from "./state";
