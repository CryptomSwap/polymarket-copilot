/**
 * Runtime policy / freshness threshold config.
 * Central default for calibration API and future wiring; runtime behavior unchanged until callers use it.
 */

export type { RuntimePolicyThresholds } from "./types";
export {
  defaultRuntimePolicyThresholds,
  getRuntimePolicyThresholds,
  setRuntimePolicyThresholds,
} from "./defaults";
