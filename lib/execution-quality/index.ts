/**
 * Execution quality (market microstructure) guardrails: spread, depth, quote freshness, slippage estimate.
 * Conservative; missing data blocks or warns. Feeds execution policy and decision/operator surfaces.
 */

export * from "./types";
export { evaluateExecutionQuality } from "./evaluate";
export {
  getExecutionQualityThresholds,
  setExecutionQualityThresholds,
  defaultExecutionQualityThresholds,
  type ExecutionQualityThresholds,
} from "./config";
