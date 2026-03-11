/**
 * Runtime risk state: live, in-memory view of limits, health gating, and automation controls.
 * Used by guardrails to block or reduce actions before order submission.
 * No DB on the hot path; not wired to admin controls yet.
 */

// ---------- Health and gating ----------

export type ExchangeConnectivityHealth = "healthy" | "degraded" | "unhealthy";

export type MarketStateHealthGate = "ok" | "degraded" | "stale" | "unknown";

/** Snapshot of market/position health for risk gating (supplied by caller). */
export interface RuntimeHealthGatingSnapshot {
  /** Per-asset: is market state acceptable for trading. */
  marketStateByAsset?: Map<string, MarketStateHealthGate>;
  /** Global: is exchange/WS sync healthy. */
  exchangeHealth?: ExchangeConnectivityHealth;
}

// ---------- Limits (configurable; defaults in guardrails) ----------

export interface RuntimeRiskLimits {
  /** Max notional exposure per market as a fraction of portfolio value (0–1). */
  perMarketNotionalLimitPct: number;
  /** Max notional exposure per theme as a fraction of portfolio value (0–1). */
  perThemeNotionalLimitPct: number;
  /** Global max gross exposure multiple. */
  maxGrossExposureMultiple: number;
  /** Max net shares (long or short) per asset. */
  maxInventoryPerAsset: number;
  /** Max notional per asset (abs(netShares * mark)). */
  maxNotionalPerAsset: number;
  /** Max total gross exposure (sum of position notionals). */
  maxTotalExposure: number;
  /** Max concurrent working orders (across all assets). */
  maxConcurrentWorkingOrders: number;
  /** Min spread in bps to allow quoting (wider = skip). */
  minQuoteSpreadBps: number;
  /** Min liquidity quality score (0–1) to allow trading. */
  minLiquidityQualityScore: number;
}

export const DEFAULT_RUNTIME_RISK_LIMITS: RuntimeRiskLimits = {
  perMarketNotionalLimitPct: 0.2,
  perThemeNotionalLimitPct: 0.25,
  maxGrossExposureMultiple: 2,
  maxInventoryPerAsset: 10_000,
  maxNotionalPerAsset: 50_000,
  maxTotalExposure: 100_000,
  maxConcurrentWorkingOrders: 20,
  minQuoteSpreadBps: 5,
  minLiquidityQualityScore: 0.3,
};

// ---------- Runtime risk state ----------

export interface RuntimeRiskState {
  limits: RuntimeRiskLimits;
  /** Global automation allowed (overridden by kill switch when false). */
  globalAutomationEnabled: boolean;
  /** Asset IDs that are halted (no new orders). */
  haltedAssetIds: string[];
  /** Exchange/WS connectivity. */
  exchangeHealth: ExchangeConnectivityHealth;
  /** If true, market state health gates must pass to allow orders. */
  marketStateHealthGatingEnabled: boolean;
  /** When true, only reduce/exit allowed; no new entries. */
  degradedSafeMode: boolean;
  /** Current gross exposure across all positions. */
  grossExposure: number;
  /** Current net exposure. */
  netExposure: number;
  /** Current count of working orders. */
  workingOrderCount: number;
  /** True if any hard limit is breached. */
  hardLimitBreached: boolean;
  /** Human-readable reasons for breaches or warnings. */
  reasons: string[];
  evaluatedAt: Date;
}

export interface RuntimeRiskEngine {
  getState(): RuntimeRiskState;
  updateState(next: RuntimeRiskState): void;
  /** Update only exposure/counts (e.g. from position store snapshot). */
  updateExposure(grossExposure: number, netExposure: number, workingOrderCount: number): void;
}

function cloneState(s: RuntimeRiskState): RuntimeRiskState {
  return {
    ...s,
    haltedAssetIds: [...s.haltedAssetIds],
    reasons: [...s.reasons],
    evaluatedAt: new Date(s.evaluatedAt.getTime()),
  };
}

export function createDefaultRuntimeRiskState(
  overrides?: Partial<RuntimeRiskState>
): RuntimeRiskState {
  const now = new Date();
  const base: RuntimeRiskState = {
    limits: { ...DEFAULT_RUNTIME_RISK_LIMITS },
    globalAutomationEnabled: true,
    haltedAssetIds: [],
    exchangeHealth: "healthy",
    marketStateHealthGatingEnabled: true,
    degradedSafeMode: false,
    grossExposure: 0,
    netExposure: 0,
    workingOrderCount: 0,
    hardLimitBreached: false,
    reasons: [],
    evaluatedAt: now,
  };
  const merged = { ...base, ...overrides };
  if (overrides?.limits) {
    merged.limits = { ...DEFAULT_RUNTIME_RISK_LIMITS, ...overrides.limits };
  }
  return merged;
}

/**
 * In-memory risk engine. State is updated by callers (e.g. kill switch sets
 * globalAutomationEnabled/haltedAssetIds; position/order views update exposure/counts).
 */
export class InMemoryRuntimeRiskEngine implements RuntimeRiskEngine {
  private state: RuntimeRiskState;

  constructor(initialState?: Partial<RuntimeRiskState>) {
    this.state = createDefaultRuntimeRiskState(initialState);
  }

  getState(): RuntimeRiskState {
    return cloneState(this.state);
  }

  updateState(next: RuntimeRiskState): void {
    this.state = cloneState(next);
  }

  updateExposure(grossExposure: number, netExposure: number, workingOrderCount: number): void {
    this.state = {
      ...this.state,
      grossExposure,
      netExposure,
      workingOrderCount,
      evaluatedAt: new Date(),
    };
  }
}
