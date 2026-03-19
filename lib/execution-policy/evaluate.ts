/**
 * Execution policy evaluator: single deterministic pre-trade gate.
 * Fail closed when critical data is missing. No hidden weighting; explicit reasons only.
 */

import type {
  ExecutionPolicyInput,
  ExecutionPolicyResult,
  ExecutionPolicyChecks,
  FreshnessCheck,
  ExposureCheck,
  LiquidityCheck,
  PricingCheck,
  OperationalSafetyCheck,
  RecommendationQualityCheck,
} from "./types";

const DEFAULT_PRICE_MIN = 0;
const DEFAULT_PRICE_MAX = 1;
const DEFAULT_DECISION_SNAPSHOT_MAX_AGE_MS = 300_000; // 5 min

function nowIso(): string {
  return new Date().toISOString();
}

function safeNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function checkFreshness(input: ExecutionPolicyInput): FreshnessCheck {
  const f = input.freshness;
  const blockReasons: string[] = [];
  const marketDataFresh = f?.marketDataFresh;
  const userDataFresh = f?.userDataFresh;
  const reconciliationFresh = f?.reconciliationFresh;
  const phase = f?.runtimePhase ?? "unknown";

  if (phase === "rebuilding" || phase === "reconciling" || phase === "starting") {
    blockReasons.push("runtime_not_ready");
  }
  if (marketDataFresh === false) {
    blockReasons.push("market_data_stale");
  }
  if (userDataFresh === false) {
    blockReasons.push("user_data_stale");
  }
  if (reconciliationFresh === false) {
    blockReasons.push("reconciliation_stale");
  }

  let decisionSnapshotFresh: boolean | undefined;
  let decisionSnapshotAgeMs: number | undefined;
  if (f?.decisionSnapshotAt != null && f?.decisionSnapshotMaxAgeMs != null) {
    const ageMs = Date.now() - new Date(f.decisionSnapshotAt).getTime();
    decisionSnapshotAgeMs = ageMs;
    decisionSnapshotFresh = ageMs <= f.decisionSnapshotMaxAgeMs;
    if (!decisionSnapshotFresh) {
      blockReasons.push("decision_snapshot_stale");
    }
  } else if (input.recommendation?.decisionSnapshotAt != null && input.recommendation?.decisionSnapshotMaxAgeMs != null) {
    const ageMs = Date.now() - new Date(input.recommendation.decisionSnapshotAt).getTime();
    decisionSnapshotAgeMs = ageMs;
    decisionSnapshotFresh = ageMs <= input.recommendation.decisionSnapshotMaxAgeMs;
    if (!decisionSnapshotFresh) {
      blockReasons.push("decision_snapshot_stale");
    }
  }

  const pass = blockReasons.length === 0;
  return {
    pass,
    blockReason: pass ? undefined : blockReasons.join("; "),
    marketDataFresh,
    userDataFresh,
    reconciliationFresh,
    decisionSnapshotFresh,
    decisionSnapshotAgeMs,
    runtimePhase: phase,
  };
}

function checkExposure(input: ExecutionPolicyInput): ExposureCheck {
  const blockReasons: string[] = [];
  const exp = input.exposure;
  let grossExposureVsLimit: ExposureCheck["grossExposureVsLimit"];
  let perAssetVsLimit: ExposureCheck["perAssetVsLimit"];
  let workingOrdersVsLimit: ExposureCheck["workingOrdersVsLimit"];
  let singleMarketConcentrationVsLimit: ExposureCheck["singleMarketConcentrationVsLimit"];
  let singleThemeConcentrationVsLimit: ExposureCheck["singleThemeConcentrationVsLimit"];

  if (exp?.maxTotalExposure != null && exp?.grossExposure != null) {
    if (exp.grossExposure > exp.maxTotalExposure) {
      blockReasons.push("exposure_total_breach");
    }
    grossExposureVsLimit = { current: exp.grossExposure, limit: exp.maxTotalExposure };
  }
  if (exp?.maxNotionalPerAsset != null && exp?.perAssetNotional != null) {
    if (exp.perAssetNotional > exp.maxNotionalPerAsset) {
      blockReasons.push("exposure_per_asset_breach");
    }
    perAssetVsLimit = {
      current: exp.perAssetNotional,
      limit: exp.maxNotionalPerAsset,
      assetId: input.order.assetId,
    };
  }
  if (exp?.maxWorkingOrders != null && exp?.workingOrderCount != null) {
    if (exp.workingOrderCount >= exp.maxWorkingOrders) {
      blockReasons.push("working_orders_breach");
    }
    workingOrdersVsLimit = { current: exp.workingOrderCount, limit: exp.maxWorkingOrders };
  }
  if (
    exp?.maxSingleMarketConcentrationPct != null &&
    exp?.currentSingleMarketConcentrationPct != null &&
    exp.currentSingleMarketConcentrationPct >= exp.maxSingleMarketConcentrationPct
  ) {
    blockReasons.push("single_market_concentration_breach");
    singleMarketConcentrationVsLimit = {
      current: exp.currentSingleMarketConcentrationPct,
      limit: exp.maxSingleMarketConcentrationPct,
    };
  } else if (exp?.maxSingleMarketConcentrationPct != null && exp?.currentSingleMarketConcentrationPct != null) {
    singleMarketConcentrationVsLimit = {
      current: exp.currentSingleMarketConcentrationPct,
      limit: exp.maxSingleMarketConcentrationPct,
    };
  }
  if (
    exp?.maxSingleThemeConcentrationPct != null &&
    exp?.currentSingleThemeConcentrationPct != null &&
    exp.currentSingleThemeConcentrationPct >= exp.maxSingleThemeConcentrationPct
  ) {
    blockReasons.push("single_theme_concentration_breach");
    singleThemeConcentrationVsLimit = {
      current: exp.currentSingleThemeConcentrationPct,
      limit: exp.maxSingleThemeConcentrationPct,
    };
  } else if (exp?.maxSingleThemeConcentrationPct != null && exp?.currentSingleThemeConcentrationPct != null) {
    singleThemeConcentrationVsLimit = {
      current: exp.currentSingleThemeConcentrationPct,
      limit: exp.maxSingleThemeConcentrationPct,
    };
  }

  const pass = blockReasons.length === 0;
  return {
    pass,
    blockReason: pass ? undefined : blockReasons.join("; "),
    grossExposureVsLimit,
    perAssetVsLimit,
    workingOrdersVsLimit,
    singleMarketConcentrationVsLimit,
    singleThemeConcentrationVsLimit,
  };
}

function checkLiquidity(input: ExecutionPolicyInput): LiquidityCheck {
  const blockReasons: string[] = [];
  const liq = input.liquidity;
  if (liq?.marketStale) blockReasons.push("market_stale");
  if (liq?.marketDegraded) blockReasons.push("market_degraded");
  if (liq?.isTradable === false) blockReasons.push("not_tradable");
  if (
    liq?.minLiquidityQualityScore != null &&
    liq?.liquidityQualityScore != null &&
    liq.liquidityQualityScore < liq.minLiquidityQualityScore
  ) {
    blockReasons.push("liquidity_below_threshold");
  }
  if (
    liq?.minSpreadBps != null &&
    liq?.spreadBps != null &&
    liq.minSpreadBps > 0 &&
    liq.spreadBps < liq.minSpreadBps
  ) {
    blockReasons.push("spread_below_threshold");
  }
  const eq = input.executionQuality;
  let executionQualityBlock = false;
  if (eq?.qualityState === "block" && eq.blockingReasons?.length) {
    for (const r of eq.blockingReasons) {
      blockReasons.push("execution_quality:" + r);
    }
    executionQualityBlock = true;
  }
  const pass = blockReasons.length === 0;
  return {
    pass,
    blockReason: pass ? undefined : blockReasons.join("; "),
    marketStale: liq?.marketStale,
    notTradable: liq?.isTradable === false,
    executionQualityBlock: executionQualityBlock || undefined,
  };
}

function checkPricing(input: ExecutionPolicyInput): PricingCheck {
  const blockReasons: string[] = [];
  const order = input.order;
  const min = input.priceBand?.min ?? DEFAULT_PRICE_MIN;
  const max = input.priceBand?.max ?? DEFAULT_PRICE_MAX;

  const side = order.side?.toUpperCase();
  if (side !== "BUY" && side !== "SELL") {
    blockReasons.push("invalid_side");
  }
  const size = safeNumber(order.size);
  if (size == null || size <= 0 || !Number.isFinite(size)) {
    blockReasons.push("invalid_size");
  }
  const price = safeNumber(order.limitPrice);
  if (price == null || !Number.isFinite(price)) {
    blockReasons.push("invalid_price");
  } else if (price < min || price > max) {
    blockReasons.push("price_out_of_band");
  }
  if (size != null && (size <= 0 || Number.isNaN(size))) blockReasons.push("zero_or_negative_or_nan");
  if (price != null && (Number.isNaN(price) || price < 0)) blockReasons.push("zero_or_negative_or_nan");

  const pass = blockReasons.length === 0;
  return {
    pass,
    blockReason: pass ? undefined : blockReasons.join("; "),
    invalidSide: blockReasons.includes("invalid_side"),
    invalidSize: blockReasons.includes("invalid_size"),
    invalidPrice: blockReasons.includes("invalid_price"),
    priceOutOfBand: blockReasons.includes("price_out_of_band"),
    zeroOrNegativeOrNaN: blockReasons.includes("zero_or_negative_or_nan"),
  };
}

function checkOperationalSafety(input: ExecutionPolicyInput): OperationalSafetyCheck {
  const blockReasons: string[] = [];
  const op = input.operational;
  if (op?.killSwitchActive) blockReasons.push("kill_switch_active");
  const safetyState = op?.runtimeSafetyState;
  if (safetyState === "kill_switch") blockReasons.push("runtime_safety_kill_switch");
  if (safetyState === "blocked") blockReasons.push("runtime_safety_blocked");
  if (op?.runtimeDegraded) blockReasons.push("runtime_degraded");
  if (op?.reconciliationDrift) blockReasons.push("reconciliation_drift");
  if (op?.exchangeTruthUnavailable) blockReasons.push("exchange_truth_unavailable");
  const frozen = op?.executionFrozenAssetIds;
  const assetId = op?.assetId ?? input.order.assetId;
  if (assetId && frozen) {
    const set = frozen instanceof Set ? frozen : new Set(frozen);
    if (set.has(assetId)) blockReasons.push("execution_frozen_for_asset");
  }
  if (op?.missingCredentials) blockReasons.push("missing_credentials");
  if (op?.missingMarketOrAssetResolution) blockReasons.push("missing_market_or_asset_resolution");

  const pass = blockReasons.length === 0;
  return {
    pass,
    blockReason: pass ? undefined : blockReasons.join("; "),
    killSwitchActive: op?.killSwitchActive,
    runtimeDegraded: op?.runtimeDegraded,
    reconciliationDrift: op?.reconciliationDrift,
    executionFrozenForAsset: blockReasons.includes("execution_frozen_for_asset"),
    missingCredentials: op?.missingCredentials,
    missingMarketOrAssetResolution: op?.missingMarketOrAssetResolution,
  };
}

function checkRecommendationQuality(input: ExecutionPolicyInput): RecommendationQualityCheck {
  const blockReasons: string[] = [];
  const rec = input.recommendation;
  if (rec?.blocked) {
    blockReasons.push("recommendation_blocked");
  }
  if (rec?.blockedReason != null && String(rec.blockedReason).trim().length > 0) {
    blockReasons.push("blocked_reason:" + String(rec.blockedReason).slice(0, 64));
  }
  if (rec?.executable === false) {
    blockReasons.push("not_in_executable_state");
  }
  if (rec?.decisionSnapshotAt != null && rec?.decisionSnapshotMaxAgeMs != null) {
    const ageMs = Date.now() - new Date(rec.decisionSnapshotAt).getTime();
    if (ageMs > rec.decisionSnapshotMaxAgeMs) {
      blockReasons.push("stale_decision_snapshot");
    }
  }
  const pass = blockReasons.length === 0;
  return {
    pass,
    blockReason: pass ? undefined : blockReasons.join("; "),
    recommendationBlocked: rec?.blocked,
    blockedReason: rec?.blockedReason ?? undefined,
    staleDecisionSnapshot: blockReasons.includes("stale_decision_snapshot"),
    notInExecutableState: rec?.executable === false,
  };
}

/**
 * Evaluate execution policy for a single order path.
 * Deterministic, conservative: missing critical data blocks; explicit reasons only.
 */
export function evaluateExecutionPolicy(input: ExecutionPolicyInput): ExecutionPolicyResult {
  const evaluatedAt = nowIso();
  const checks: ExecutionPolicyChecks = {
    freshness: checkFreshness(input),
    exposure: checkExposure(input),
    liquidity: checkLiquidity(input),
    pricing: checkPricing(input),
    operationalSafety: checkOperationalSafety(input),
    recommendationQuality: checkRecommendationQuality(input),
  };

  const blockingReasons: string[] = [];
  const warnings: string[] = [];
  if (input.executionQuality?.warnings?.length) {
    warnings.push(...input.executionQuality.warnings);
  }

  if (!checks.freshness.pass && checks.freshness.blockReason) {
    blockingReasons.push("freshness:" + checks.freshness.blockReason);
  }
  if (!checks.exposure.pass && checks.exposure.blockReason) {
    blockingReasons.push("exposure:" + checks.exposure.blockReason);
  }
  if (!checks.liquidity.pass && checks.liquidity.blockReason) {
    blockingReasons.push("liquidity:" + checks.liquidity.blockReason);
  }
  if (!checks.pricing.pass && checks.pricing.blockReason) {
    blockingReasons.push("pricing:" + checks.pricing.blockReason);
  }
  if (!checks.operationalSafety.pass && checks.operationalSafety.blockReason) {
    blockingReasons.push("operational:" + checks.operationalSafety.blockReason);
  }
  if (!checks.recommendationQuality.pass && checks.recommendationQuality.blockReason) {
    blockingReasons.push("recommendation:" + checks.recommendationQuality.blockReason);
  }

  const allow = blockingReasons.length === 0;
  let policyState: "allow" | "warn" | "block" = allow ? "allow" : "block";
  if (allow && warnings.length > 0) {
    policyState = "warn";
  }

  const snapshot = {
    evaluatedAt,
    policyState,
    allow,
    blockingReasons,
    warnings,
    checks: {
      freshness: { pass: checks.freshness.pass, blockReason: checks.freshness.blockReason },
      exposure: { pass: checks.exposure.pass, blockReason: checks.exposure.blockReason },
      liquidity: { pass: checks.liquidity.pass, blockReason: checks.liquidity.blockReason },
      pricing: { pass: checks.pricing.pass, blockReason: checks.pricing.blockReason },
      operationalSafety: { pass: checks.operationalSafety.pass, blockReason: checks.operationalSafety.blockReason },
      recommendationQuality: { pass: checks.recommendationQuality.pass, blockReason: checks.recommendationQuality.blockReason },
    },
    order: {
      assetId: input.order.assetId,
      marketId: input.order.marketId,
      side: input.order.side,
      size: input.order.size,
      limitPrice: input.order.limitPrice,
    },
  };

  return {
    allow,
    policyState,
    blockingReasons,
    warnings,
    evaluatedAt,
    checks,
    snapshotJson: JSON.stringify(snapshot),
  };
}
