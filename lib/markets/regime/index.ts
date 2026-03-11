/**
 * Market regime scanner: features, classifier, signals. Deterministic, explainable.
 */

export {
  computeMarketRegimeFeatures,
  type MarketRegimeFeatures,
  type MarketRegimeFeaturesInput,
} from "./features";
export { classifyRegime, type RegimeLabel, type RegimeResult } from "./classifier";
export { getRegimeSignals, type RegimeSignals } from "./signals";
export { runRegimeScan, persistRegimeSnapshot } from "./scan";
