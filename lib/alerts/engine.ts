/**
 * Alert Engine v1: proactive portfolio and recommendation alerts.
 * Deterministic, threshold-based. Dedupes by (funder, type, dedupeKey).
 * No autonomous trading; alerts only.
 *
 * Feed: getAlertFeed() merges persisted DriftAlerts with computed portfolio-intelligence
 * flags into a single normalized feed (no new DB tables; engine alerts are computed only).
 */

import { prisma } from "@/lib/db";
import { getPortfolioIntelligence } from "@/lib/portfolio/intelligence";
import type { PortfolioIntelligence } from "@/lib/portfolio/intelligence";
import type { CopilotAlertPayload, CopilotAlertSeverity, CopilotAlertType } from "./types";
import type { AlertFeedItem, AlertFeedSeverity, AlertFeedSource } from "./types";

// Reuse PI thresholds so alerts align with intelligence flags
const CONCENTRATION_BREACH_PCT = 35;
const DEDUPE_WINDOW_HOURS = 24;

/**
 * Check if we should skip creating this alert (already exists with same dedupeKey, unread or recent).
 */
async function shouldDedupe(
  funderAddress: string,
  type: CopilotAlertType,
  dedupeKey: string
): Promise<boolean> {
  const windowStart = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 60 * 60 * 1000);
  const existing = await prisma.copilotAlert.findFirst({
    where: {
      funderAddress: funderAddress.toLowerCase(),
      type,
      dedupeKey,
      OR: [{ isRead: false }, { createdAt: { gte: windowStart } }],
    },
  });
  return !!existing;
}

/**
 * Persist one alert if not deduped.
 */
async function createIfNotDeduped(
  funderAddress: string,
  payload: CopilotAlertPayload
): Promise<boolean> {
  const funder = funderAddress.toLowerCase();
  const duped = await shouldDedupe(funder, payload.type as CopilotAlertType, payload.dedupeKey);
  if (duped) return false;
  await prisma.copilotAlert.create({
    data: {
      funderAddress: funder,
      type: payload.type,
      severity: payload.severity,
      title: payload.title,
      message: payload.message,
      marketId: payload.marketId ?? undefined,
      recommendationId: payload.recommendationId ?? undefined,
      assetId: payload.assetId ?? undefined,
      metadata: payload.metadata ? (JSON.parse(JSON.stringify(payload.metadata)) as object) : undefined,
      dedupeKey: payload.dedupeKey,
    },
  });
  return true;
}

export interface GenerateAlertsResult {
  funderAddress: string;
  created: number;
  skippedByDedupe: number;
  errors: string[];
}

/**
 * Generate Alert Engine v1 alerts from portfolio intelligence and recommendations.
 * Idempotent with dedupe; safe to call on every dashboard load or cron.
 */
export async function generateAlerts(funderAddress: string): Promise<GenerateAlertsResult> {
  const funder = funderAddress.trim().toLowerCase();
  const result: GenerateAlertsResult = { funderAddress: funder, created: 0, skippedByDedupe: 0, errors: [] };

  let intelligence: Awaited<ReturnType<typeof getPortfolioIntelligence>>;
  try {
    intelligence = await getPortfolioIntelligence({ funderAddress: funder });
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : "getPortfolioIntelligence failed");
    return result;
  }

  const { summary, buckets } = intelligence;
  const topThemeConcentrationPct = summary.topThemeConcentrationPct ?? 0;
  const nearResolutionCount = summary.nearResolutionPositions ?? 0;
  const staleCount = summary.stalePositions ?? 0;
  const unresolvedCount = summary.unresolvedPositions ?? 0;

  // --- CONCENTRATION_BREACH (theme concentration) ---
  if (summary.totalPositions > 0 && topThemeConcentrationPct >= CONCENTRATION_BREACH_PCT) {
    const severity: CopilotAlertSeverity =
      topThemeConcentrationPct >= 60 ? "critical" : topThemeConcentrationPct >= 45 ? "warning" : "info";
    const payload: CopilotAlertPayload = {
      type: "CONCENTRATION_BREACH",
      severity,
      title: "High theme concentration",
      message: `Top theme concentration is ${topThemeConcentrationPct.toFixed(1)}% of portfolio. Consider trimming exposure.`,
      dedupeKey: `concentration_${Math.round(topThemeConcentrationPct)}`,
      metadata: { topThemeConcentrationPct, theme: buckets.byTheme[0]?.key },
    };
    if (await createIfNotDeduped(funder, payload)) result.created++;
    else result.skippedByDedupe++;
  }

  // --- NEAR_RESOLUTION_REVIEW ---
  if (nearResolutionCount > 0) {
    const severity: CopilotAlertSeverity =
      nearResolutionCount >= 5 ? "warning" : nearResolutionCount >= 2 ? "info" : "info";
    const payload: CopilotAlertPayload = {
      type: "NEAR_RESOLUTION_REVIEW",
      severity,
      title: "Positions nearing resolution",
      message: `${nearResolutionCount} position(s) resolve within 72 hours. Review before resolution.`,
      dedupeKey: `near_resolution_${nearResolutionCount}`,
      metadata: { count: nearResolutionCount },
    };
    if (await createIfNotDeduped(funder, payload)) result.created++;
    else result.skippedByDedupe++;
  }

  // --- DATA_HEALTH ---
  if (staleCount > 0 || unresolvedCount > 0) {
    const severity: CopilotAlertSeverity =
      unresolvedCount >= 3 || staleCount >= 5 ? "warning" : "info";
    const parts: string[] = [];
    if (staleCount > 0) parts.push(`${staleCount} stale`);
    if (unresolvedCount > 0) parts.push(`${unresolvedCount} unresolved`);
    const payload: CopilotAlertPayload = {
      type: "DATA_HEALTH",
      severity,
      title: "Portfolio data health",
      message: `Sync issues: ${parts.join(", ")}. Run portfolio sync and recompute.`,
      dedupeKey: `data_health_${staleCount}_${unresolvedCount}`,
      metadata: { staleCount, unresolvedCount },
    };
    if (await createIfNotDeduped(funder, payload)) result.created++;
    else result.skippedByDedupe++;
  }

  // --- NEW_ADD_OPPORTUNITY and HELD_MARKET_SIGNAL_FLIP: need recommendations + positions ---
  const [addRecs, trimExitRecs, positions] = await Promise.all([
    prisma.recommendation.findMany({
      where: {
        marketSignal: { funderAddress: funder },
        primaryActionType: "add",
        action: { in: ["STRONG_BUY", "BUY_SMALL"] },
      },
      include: { marketSignal: true },
      take: 20,
    }),
    prisma.recommendation.findMany({
      where: {
        marketSignal: { funderAddress: funder },
        action: { in: ["TRIM", "EXIT"] },
      },
      include: { marketSignal: true },
      take: 50,
    }),
    prisma.derivedPosition.findMany({
      where: { funderAddress: funder },
      select: { syncedMarketId: true, marketId: true, assetId: true },
    }),
  ]);

  const heldMarketIds = new Set(
    positions.map((p) => p.syncedMarketId ?? p.marketId).filter(Boolean) as string[]
  );

  // NEW_ADD_OPPORTUNITY: one alert per top add opportunity (cap at 1 for v1 to avoid noise)
  const topAdd = addRecs
    .sort((a, b) => parseFloat(b.priorityScore) - parseFloat(a.priorityScore))
    .slice(0, 1);
  for (const rec of topAdd) {
    const payload: CopilotAlertPayload = {
      type: "NEW_ADD_OPPORTUNITY",
      severity: rec.action === "STRONG_BUY" ? "warning" : "info",
      title: "New add opportunity",
      message: `${rec.marketSignal.marketTitle ?? "Market"} — ${rec.primaryActionType ?? rec.action}. ${rec.rationale ?? ""}`.slice(0, 300),
      recommendationId: rec.id,
      marketId: rec.marketSignal.marketId,
      dedupeKey: `add_${rec.id}`,
      metadata: { action: rec.action, priorityScore: rec.priorityScore },
    };
    if (await createIfNotDeduped(funder, payload)) result.created++;
    else result.skippedByDedupe++;
  }

  // HELD_MARKET_SIGNAL_FLIP: alert when we hold a market and rec says TRIM/EXIT
  for (const rec of trimExitRecs) {
    const marketId = rec.marketSignal.marketId;
    if (!heldMarketIds.has(marketId)) continue;
    const pos = positions.find(
      (p) => (p.syncedMarketId === marketId || p.marketId === marketId)
    );
    const payload: CopilotAlertPayload = {
      type: "HELD_MARKET_SIGNAL_FLIP",
      severity: rec.action === "EXIT" ? "warning" : "info",
      title: "Held position: trim or exit signal",
      message: `You hold a position in "${rec.marketSignal.marketTitle ?? "this market"}". Signal suggests ${rec.action}: ${rec.rationale ?? rec.blockedReason ?? ""}`.slice(0, 300),
      recommendationId: rec.id,
      marketId,
      assetId: pos?.assetId ?? undefined,
      dedupeKey: `flip_${marketId}`,
      metadata: { action: rec.action },
    };
    if (await createIfNotDeduped(funder, payload)) result.created++;
    else result.skippedByDedupe++;
  }

  return result;
}

// --- Alert feed (merge drift + engine; computed only for engine) ---

/** Drift alert row as returned from DB / api/live/alerts. */
export interface DriftAlertRowForFeed {
  id: string;
  alertType: string;
  severity: string;
  message: string;
  polymarketOrderId?: string | null;
  assetId?: string | null;
  marketId?: string | null;
  resolved?: boolean;
  createdAt: Date | string;
}

export interface GetAlertFeedParams {
  funderAddress: string;
  /** Unresolved (or filtered) drift alerts. When not provided and source includes drift, caller must fetch. */
  driftAlerts?: DriftAlertRowForFeed[] | null;
  /** Portfolio intelligence (flags + diagnostics.asOf). When not provided and source includes engine, caller must fetch. */
  intelligence?: PortfolioIntelligence | null;
  source?: "all" | "drift" | "engine";
  limit?: number;
}

const FLAG_SEVERITY_TO_FEED: Record<string, AlertFeedSeverity> = {
  low: "info",
  medium: "warning",
  high: "critical",
};

const ENGINE_FLAG_TITLE: Record<string, string> = {
  HIGH_CONCENTRATION: "High concentration",
  NEAR_RESOLUTION_CLUSTER: "Positions nearing resolution",
  STALE_SYNC_CLUSTER: "Stale sync",
  UNRESOLVED_CATALOG_POSITIONS: "Unresolved catalog positions",
  LARGE_LOSS: "Large unrealized loss",
  LARGE_GAIN: "Large unrealized gain",
};

function mapDriftSeverity(s: string): AlertFeedSeverity {
  const lower = (s ?? "").toLowerCase();
  if (lower === "critical") return "critical";
  if (lower === "warning") return "warning";
  return "info";
}

/**
 * Build normalized alert feed from drift alerts + portfolio intelligence flags.
 * One alert per drift item; one alert per intelligence flag (cluster-style flags = one summary alert).
 * No persistence for engine items; drift items reference driftAlertId for resolve API.
 */
export function getAlertFeed(params: GetAlertFeedParams): AlertFeedItem[] {
  const {
    funderAddress: _funder,
    driftAlerts = [],
    intelligence,
    source = "all",
    limit = 50,
  } = params;

  const items: AlertFeedItem[] = [];

  if (source === "drift" || source === "all") {
    const list = Array.isArray(driftAlerts) ? driftAlerts : [];
    for (const a of list) {
      const createdAt =
        typeof a.createdAt === "string" ? a.createdAt : a.createdAt?.toISOString?.() ?? new Date().toISOString();
      items.push({
        id: a.id,
        type: a.alertType,
        severity: mapDriftSeverity(a.severity),
        title: a.alertType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Sync issue",
        message: a.message ?? "",
        source: "drift" as AlertFeedSource,
        driftAlertId: a.id,
        entityRefs: {
          assetId: a.assetId ?? null,
          marketId: a.marketId ?? null,
          polymarketOrderId: a.polymarketOrderId ?? null,
        },
        createdAt,
      });
    }
  }

  if ((source === "engine" || source === "all") && intelligence?.flags?.length) {
    const asOf = intelligence.diagnostics?.asOf ?? new Date().toISOString();
    intelligence.flags.forEach((flag, idx) => {
      const feedSeverity: AlertFeedSeverity =
        FLAG_SEVERITY_TO_FEED[flag.severity] ?? "info";
      const title = ENGINE_FLAG_TITLE[flag.code] ?? flag.code.replace(/_/g, " ");
      items.push({
        id: `engine_${flag.code}_${idx}`,
        type: flag.code,
        severity: feedSeverity,
        title,
        message: flag.message ?? "",
        source: "engine" as AlertFeedSource,
        entityRefs: undefined,
        createdAt: asOf,
        asOf,
      });
    });
  }

  items.sort((a, b) => {
    const tA = new Date(a.createdAt).getTime();
    const tB = new Date(b.createdAt).getTime();
    return tB - tA;
  });

  return items.slice(0, Math.max(0, limit));
}
