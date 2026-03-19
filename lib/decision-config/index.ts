/**
 * Staged decision engine boundary config.
 * Central default for calibration API and future wiring; stage behavior unchanged until callers use it.
 */

export type { DecisionStageThresholds } from "./types";
export {
  defaultDecisionStageThresholds,
  getDecisionStageThresholds,
  setDecisionStageThresholds,
} from "./defaults";
