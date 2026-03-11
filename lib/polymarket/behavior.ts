/**
 * Behavior / risk flags from positions and orders. Heuristic-based.
 * TODO: Recommendation engine will plug in here with stricter rules and suggested actions.
 */

import type { DerivedPositionRow } from "./portfolio";

export type BehaviorFlagType =
  | "CORRELATED_STACKING"
  | "OVERCONCENTRATION"
  | "OVERTRADING"
  | "CHASING"
  | "LOW_QUALITY_LONGSHOT";

export type FlagSeverity = "low" | "medium" | "high";

export interface BehaviorFlagRow {
  funderAddress: string;
  type: BehaviorFlagType;
  severity: FlagSeverity;
  marketTitle: string | null;
  description: string;
  metadata: Record<string, unknown> | null;
}

const CONCENTRATION_PCT_THRESHOLD = 40;
const OVERTRADING_FILLS_24H = 20;
const SIMILAR_MARKETS_STACK = 4;
const LONGSHOT_PRICE_MAX = 0.15;
const CHASING_ENTRY_AFTER_PUMP_PCT = 30;

/**
 * Generate behavior flags from derived positions and optional fill count.
 */
export function computeBehaviorFlags(
  funderAddress: string,
  positions: DerivedPositionRow[],
  opts?: { recentFillsCount24h?: number }
): BehaviorFlagRow[] {
  const flags: BehaviorFlagRow[] = [];
  const totalExposure = positions.reduce((s, p) => s + parseFloat(p.marketValue || "0"), 0);

  if (totalExposure <= 0) return flags;

  const byTheme = new Map<string, DerivedPositionRow[]>();
  for (const p of positions) {
    const theme = p.theme ?? "Other";
    if (!byTheme.has(theme)) byTheme.set(theme, []);
    byTheme.get(theme)!.push(p);
  }

  for (const [theme, posList] of Array.from(byTheme.entries())) {
    const themeExposure = posList.reduce((s, p) => s + parseFloat(p.marketValue || "0"), 0);
    const pct = (themeExposure / totalExposure) * 100;
    if (pct >= CONCENTRATION_PCT_THRESHOLD) {
      flags.push({
        funderAddress,
        type: "OVERCONCENTRATION",
        severity: pct >= 70 ? "high" : pct >= 55 ? "medium" : "low",
        marketTitle: null,
        description: `${theme}: ${pct.toFixed(1)}% of portfolio exposure.`,
        metadata: { theme, pct, positionsCount: posList.length },
      });
    }
    if (posList.length >= SIMILAR_MARKETS_STACK) {
      flags.push({
        funderAddress,
        type: "CORRELATED_STACKING",
        severity: posList.length >= 8 ? "high" : "medium",
        marketTitle: null,
        description: `${posList.length} positions in theme "${theme}".`,
        metadata: { theme, count: posList.length },
      });
    }
  }

  if (opts?.recentFillsCount24h !== undefined && opts.recentFillsCount24h >= OVERTRADING_FILLS_24H) {
    flags.push({
      funderAddress,
      type: "OVERTRADING",
      severity: opts.recentFillsCount24h >= 50 ? "high" : "medium",
      marketTitle: null,
      description: `${opts.recentFillsCount24h} fills in last 24h.`,
      metadata: { recentFillsCount24h: opts.recentFillsCount24h },
    });
  }

  for (const p of positions) {
    const lastPrice = parseFloat(p.lastPrice || "0");
    const avgEntry = parseFloat(p.avgEntry || "0");
    if (lastPrice > 0 && lastPrice <= LONGSHOT_PRICE_MAX) {
      flags.push({
        funderAddress,
        type: "LOW_QUALITY_LONGSHOT",
        severity: lastPrice <= 0.05 ? "high" : "low",
        marketTitle: p.marketTitle,
        description: `Low-price position (${(lastPrice * 100).toFixed(1)}¢): ${p.marketTitle.slice(0, 50)}...`,
        metadata: { assetId: p.assetId, lastPrice },
      });
    }
    if (avgEntry > 0 && lastPrice > avgEntry * (1 + CHASING_ENTRY_AFTER_PUMP_PCT / 100)) {
      flags.push({
        funderAddress,
        type: "CHASING",
        severity: "medium",
        marketTitle: p.marketTitle,
        description: `Entry ~${(avgEntry * 100).toFixed(1)}¢, last ~${(lastPrice * 100).toFixed(1)}¢ (possible chase).`,
        metadata: { assetId: p.assetId, avgEntry, lastPrice },
      });
    }
  }

  return flags;
}
