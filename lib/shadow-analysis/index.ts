/**
 * Shadow threshold calibration and outcome analysis.
 * Descriptive only; no automatic parameter mutation.
 */

export * from "./types";
export { normalizeBlockingReason, normalizeBlockingReasons, REASON_GROUP, type ReasonGroup } from "./reasons";
export { runShadowAnalysis } from "./analyze";
