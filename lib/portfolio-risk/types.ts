/**
 * Portfolio risk engine: structured input and snapshot types.
 * Deterministic, explainable, conservative. No black-box scoring.
 */

/** Single position for risk input. All numeric exposure in a consistent unit (e.g. USD notional). */
export interface PortfolioRiskPositionInput {
  assetId: string;
  marketId: string;
  marketTitle?: string | null;
  category?: string | null;
  theme?: string | null;
  outcome?: string | null;
  side?: string | null;
  /** Position size (shares/units). */
  size: number;
  /** Market value / exposure notional (abs for gross). */
  marketValue: number;
  /** Max payout if known (binary: size; else optional). */
  maxPayout?: number | null;
  /** Resolution/end date if available. */
  endDate?: Date | string | null;
  /** When true, treat as illiquid for illiquid exposure estimate. */
  illiquid?: boolean;
  /** Spread or liquidity score when available; used for warnings only. */
  liquidityContext?: string | number | null;
}

/** Working order for at-risk exposure. */
export interface PortfolioRiskWorkingOrderInput {
  assetId: string;
  marketId: string;
  side?: string | null;
  size: number;
  price: number;
  /** Optional theme for concentration. */
  theme?: string | null;
}

export interface PortfolioRiskInput {
  funderAddress: string;
  positions: PortfolioRiskPositionInput[];
  workingOrders?: PortfolioRiskWorkingOrderInput[];
  /** Max total gross exposure (limit). */
  maxTotalExposure?: number;
  /** Max single-market concentration as fraction of total (0–1). */
  maxSingleMarketConcentrationPct?: number;
  /** Max single-theme concentration as fraction of total (0–1). */
  maxSingleThemeConcentrationPct?: number;
  /** Hours to resolution below which position is "near resolution". */
  nearResolutionHoursThreshold?: number;
  /** Optional: cluster key heuristic (e.g. "theme" | "theme_category"). */
  correlationHeuristics?: "theme" | "theme_category" | "market" | null;
}

// --- Snapshot output structures ---

export interface MarketConcentrationRow {
  marketId: string;
  marketTitle?: string | null;
  exposure: number;
  concentrationPct: number;
  positionCount: number;
}

export interface ThemeConcentrationRow {
  theme: string;
  exposure: number;
  concentrationPct: number;
  positionCount: number;
}

export interface ClusterConcentrationRow {
  clusterKey: string;
  exposure: number;
  concentrationPct: number;
  positionCount: number;
  /** e.g. "theme" | "theme_category". */
  heuristic: string;
}

export interface ConcentrationFlag {
  code: string;
  message: string;
  /** e.g. "market" | "theme" | "cluster". */
  scope: string;
  identifier?: string;
  value?: number;
  threshold?: number;
}

export interface RiskFlag {
  code: string;
  message: string;
  severity: "info" | "warn" | "block";
  value?: number;
}

/** Full portfolio risk snapshot. All numbers deterministic from input. */
export interface PortfolioRiskSnapshot {
  grossExposure: number;
  /** Net exposure (signed). When not meaningfully derivable, 0 or conservative proxy. */
  netExposure: number;
  totalOpenExposure: number;
  totalWorkingOrderExposure: number;
  /** Combined "at risk" (open + working) for display. */
  totalAtRiskExposure: number;
  maxSingleMarketExposure: number;
  maxSingleMarketConcentrationPct: number;
  maxSingleThemeExposure: number;
  maxSingleThemeConcentrationPct: number;
  /** By market, ordered by exposure desc. */
  marketConcentrations: MarketConcentrationRow[];
  /** By theme, ordered by exposure desc. */
  themeConcentrations: ThemeConcentrationRow[];
  /** Event-cluster heuristic exposure (e.g. same theme/category). */
  eventClusterExposure: number;
  /** Top clusters. */
  clusterConcentrations: ClusterConcentrationRow[];
  /** Conservative correlated exposure estimate (heuristic, not covariance). */
  correlatedExposureEstimate: number;
  /** Worst-case loss estimate (conservative: e.g. sum of max loss per position where derivable). */
  worstCaseLossEstimate: number;
  /** Exposure in positions within near-resolution window. */
  nearResolutionExposure: number;
  /** Estimate of exposure in illiquid positions (when liquidity context available). */
  illiquidExposureEstimate: number;
  /** When true, liquidity context was missing so illiquid estimate is not available. */
  liquidityContextMissing: boolean;
  concentrationFlags: ConcentrationFlag[];
  riskFlags: RiskFlag[];
  warnings: string[];
  computedAt: string;
  /** Safe for persistence/API (no secrets). */
  snapshotJson: string;
}
