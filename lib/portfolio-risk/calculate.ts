/**
 * Portfolio risk calculator: deterministic metrics from positions and orders.
 * Conservative, explainable. No fake precision or black-box scoring.
 */

import type {
  PortfolioRiskInput,
  PortfolioRiskSnapshot,
  PortfolioRiskPositionInput,
  PortfolioRiskWorkingOrderInput,
  MarketConcentrationRow,
  ThemeConcentrationRow,
  ClusterConcentrationRow,
  ConcentrationFlag,
  RiskFlag,
} from "./types";

const DEFAULT_NEAR_RESOLUTION_HOURS = 72;

function nowIso(): string {
  return new Date().toISOString();
}

function safeNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function parseEndDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const d = new Date(v as string);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Compute deterministic portfolio risk snapshot. Same input => same output.
 */
export function calculatePortfolioRisk(input: PortfolioRiskInput): PortfolioRiskSnapshot {
  const positions = input.positions ?? [];
  const workingOrders = input.workingOrders ?? [];
  const nearResolutionHours = input.nearResolutionHoursThreshold ?? DEFAULT_NEAR_RESOLUTION_HOURS;
  const maxMarketPct = input.maxSingleMarketConcentrationPct ?? 1;
  const maxThemePct = input.maxSingleThemeConcentrationPct ?? 1;

  const warnings: string[] = [];
  const concentrationFlags: ConcentrationFlag[] = [];
  const riskFlags: RiskFlag[] = [];

  // --- Gross / net / open exposure ---
  let grossExposure = 0;
  let netExposure = 0;
  for (const p of positions) {
    const exp = safeNum(p.marketValue);
    grossExposure += Math.abs(exp);
    const side = (p.side ?? "").toUpperCase();
    netExposure += side === "SHORT" ? -exp : exp;
  }
  const totalOpenExposure = grossExposure;

  let totalWorkingOrderExposure = 0;
  for (const o of workingOrders) {
    totalWorkingOrderExposure += safeNum(o.size) * safeNum(o.price);
  }

  const totalAtRiskExposure = totalOpenExposure + totalWorkingOrderExposure;

  // --- By market ---
  const byMarket = new Map<string, { exposure: number; count: number; title?: string }>();
  for (const p of positions) {
    const mid = p.marketId || "unknown";
    const exp = safeNum(p.marketValue);
    const cur = byMarket.get(mid) ?? { exposure: 0, count: 0, title: p.marketTitle ?? undefined };
    byMarket.set(mid, {
      exposure: cur.exposure + Math.abs(exp),
      count: cur.count + 1,
      title: cur.title ?? p.marketTitle ?? undefined,
    });
  }
  const marketRows: MarketConcentrationRow[] = Array.from(byMarket.entries())
    .map(([marketId, v]) => ({
      marketId,
      marketTitle: v.title,
      exposure: v.exposure,
      concentrationPct: totalOpenExposure > 0 ? (v.exposure / totalOpenExposure) * 100 : 0,
      positionCount: v.count,
    }))
    .sort((a, b) => b.exposure - a.exposure);
  const maxSingleMarketExposure = marketRows[0]?.exposure ?? 0;
  const maxSingleMarketConcentrationPct = marketRows[0]?.concentrationPct ?? 0;
  if (totalOpenExposure > 0 && maxSingleMarketConcentrationPct >= maxMarketPct * 100) {
    concentrationFlags.push({
      code: "market_concentration_breach",
      message: `Single market concentration ${maxSingleMarketConcentrationPct.toFixed(1)}% exceeds limit ${(maxMarketPct * 100).toFixed(0)}%`,
      scope: "market",
      identifier: marketRows[0]?.marketId,
      value: maxSingleMarketConcentrationPct,
      threshold: maxMarketPct * 100,
    });
  }

  // --- By theme ---
  const byTheme = new Map<string, { exposure: number; count: number }>();
  for (const p of positions) {
    const theme = (p.theme ?? "Other").trim() || "Other";
    const exp = safeNum(p.marketValue);
    const cur = byTheme.get(theme) ?? { exposure: 0, count: 0 };
    byTheme.set(theme, { exposure: cur.exposure + Math.abs(exp), count: cur.count + 1 });
  }
  const themeRows: ThemeConcentrationRow[] = Array.from(byTheme.entries())
    .map(([theme, v]) => ({
      theme,
      exposure: v.exposure,
      concentrationPct: totalOpenExposure > 0 ? (v.exposure / totalOpenExposure) * 100 : 0,
      positionCount: v.count,
    }))
    .sort((a, b) => b.exposure - a.exposure);
  const maxSingleThemeExposure = themeRows[0]?.exposure ?? 0;
  const maxSingleThemeConcentrationPct = themeRows[0]?.concentrationPct ?? 0;
  if (totalOpenExposure > 0 && maxSingleThemeConcentrationPct >= maxThemePct * 100) {
    concentrationFlags.push({
      code: "theme_concentration_breach",
      message: `Single theme concentration ${maxSingleThemeConcentrationPct.toFixed(1)}% exceeds limit ${(maxThemePct * 100).toFixed(0)}%`,
      scope: "theme",
      identifier: themeRows[0]?.theme,
      value: maxSingleThemeConcentrationPct,
      threshold: maxThemePct * 100,
    });
  }

  // --- Event cluster (conservative heuristic: by theme, or theme+category) ---
  const clusterKey = input.correlationHeuristics ?? "theme";
  const byCluster = new Map<string, { exposure: number; count: number }>();
  for (const p of positions) {
    const theme = (p.theme ?? "Other").trim() || "Other";
    const category = (p.category ?? "").trim() || "Uncategorized";
    const key = clusterKey === "theme_category" ? `${theme}::${category}` : theme;
    const exp = safeNum(p.marketValue);
    const cur = byCluster.get(key) ?? { exposure: 0, count: 0 };
    byCluster.set(key, { exposure: cur.exposure + Math.abs(exp), count: cur.count + 1 });
  }
  const clusterRows: ClusterConcentrationRow[] = Array.from(byCluster.entries())
    .map(([key, v]) => ({
      clusterKey: key,
      exposure: v.exposure,
      concentrationPct: totalOpenExposure > 0 ? (v.exposure / totalOpenExposure) * 100 : 0,
      positionCount: v.count,
      heuristic: clusterKey,
    }))
    .sort((a, b) => b.exposure - a.exposure);
  const eventClusterExposure = clusterRows[0]?.exposure ?? 0;

  // --- Correlated exposure estimate (conservative: top 2 clusters when concentrated) ---
  const top2 = clusterRows.slice(0, 2);
  const correlatedExposureEstimate =
    top2.length >= 2 && top2[0].concentrationPct >= 30
      ? top2[0].exposure + top2[1].exposure
      : totalOpenExposure;

  // --- Worst-case loss (conservative: assume positions can go to zero; sum exposure at risk) ---
  let worstCaseLossEstimate = 0;
  for (const p of positions) {
    worstCaseLossEstimate += Math.abs(safeNum(p.marketValue));
  }

  // --- Near-resolution exposure ---
  const now = Date.now();
  const resolutionThresholdMs = nearResolutionHours * 60 * 60 * 1000;
  let nearResolutionExposure = 0;
  for (const p of positions) {
    const end = parseEndDate(p.endDate);
    if (end && end.getTime() - now <= resolutionThresholdMs && end.getTime() > now) {
      nearResolutionExposure += Math.abs(safeNum(p.marketValue));
    }
  }
  if (nearResolutionExposure > 0 && totalOpenExposure > 0) {
    const pct = (nearResolutionExposure / totalOpenExposure) * 100;
    if (pct >= 20) {
      riskFlags.push({
        code: "near_resolution_concentration",
        message: `${pct.toFixed(0)}% of exposure in markets resolving within ${nearResolutionHours}h`,
        severity: "warn",
        value: nearResolutionExposure,
      });
    }
  }

  // --- Illiquid exposure ---
  let illiquidExposureEstimate = 0;
  let liquidityContextMissing = true;
  for (const p of positions) {
    if (p.illiquid === true) {
      illiquidExposureEstimate += Math.abs(safeNum(p.marketValue));
    }
    if (p.liquidityContext != null) liquidityContextMissing = false;
  }
  if (liquidityContextMissing && positions.length > 0) {
    warnings.push("Liquidity context missing; illiquid exposure estimate not available.");
  }

  // --- Total exposure vs limit ---
  const maxTotal = input.maxTotalExposure;
  if (maxTotal != null && totalAtRiskExposure > maxTotal) {
    riskFlags.push({
      code: "total_exposure_breach",
      message: `Total at-risk exposure ${totalAtRiskExposure.toFixed(0)} exceeds limit ${maxTotal}`,
      severity: "block",
      value: totalAtRiskExposure,
    });
  }

  const computedAt = nowIso();
  const snapshot: PortfolioRiskSnapshot = {
    grossExposure,
    netExposure,
    totalOpenExposure,
    totalWorkingOrderExposure,
    totalAtRiskExposure,
    maxSingleMarketExposure,
    maxSingleMarketConcentrationPct,
    maxSingleThemeExposure,
    maxSingleThemeConcentrationPct,
    marketConcentrations: marketRows,
    themeConcentrations: themeRows,
    eventClusterExposure,
    clusterConcentrations: clusterRows,
    correlatedExposureEstimate,
    worstCaseLossEstimate,
    nearResolutionExposure,
    illiquidExposureEstimate,
    liquidityContextMissing,
    concentrationFlags,
    riskFlags,
    warnings,
    computedAt,
    snapshotJson: "",
  };
  snapshot.snapshotJson = JSON.stringify({
    ...snapshot,
    marketConcentrations: snapshot.marketConcentrations.slice(0, 20),
    themeConcentrations: snapshot.themeConcentrations.slice(0, 20),
    clusterConcentrations: snapshot.clusterConcentrations.slice(0, 10),
  });
  return snapshot;
}
