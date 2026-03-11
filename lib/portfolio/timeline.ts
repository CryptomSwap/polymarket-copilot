/**
 * Portfolio Timeline v1: build a reverse-chronological feed of events from
 * UserFill, Recommendation, RecommendationLifecycleEvent, CopilotAlert, PortfolioSnapshot.
 * Uses canonical market data (SyncedMarket) where available.
 */

import { prisma } from "@/lib/db";

export type TimelineEventType =
  | "position_opened"
  | "position_increased"
  | "position_reduced"
  | "recommendation_created"
  | "recommendation_lifecycle"
  | "alert_triggered"
  | "portfolio_snapshot";

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  occurredAt: string; // ISO
  title: string;
  message: string;
  marketId?: string | null;
  assetId?: string | null;
  recommendationId?: string | null;
  alertId?: string | null;
  metadata?: Record<string, unknown>;
}

const DEFAULT_LIMIT = 80;
const LIFECYCLE_LABELS: Record<string, string> = {
  SHOWN: "Recommendation shown",
  REVIEWED: "Recommendation reviewed",
  APPROVED: "Recommendation approved",
  REJECTED: "Recommendation rejected",
  PREVIEWED: "Trade previewed",
  INTENT_CREATED: "Order intent created",
  ORDER_PLACED: "Order placed",
  ORDER_CANCELLED: "Order cancelled",
  FILLED: "Order filled",
  SKIPPED: "Skipped",
};

const ALERT_TYPE_LABELS: Record<string, string> = {
  CONCENTRATION_BREACH: "Concentration breach",
  NEW_ADD_OPPORTUNITY: "Add opportunity",
  NEAR_RESOLUTION_REVIEW: "Near resolution",
  HELD_MARKET_SIGNAL_FLIP: "Held market signal flip",
  DATA_HEALTH: "Data health",
};

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resolve assetIds to market titles via SyncedAsset -> SyncedMarket (canonical).
 */
async function getMarketTitlesByAssetId(assetIds: string[]): Promise<Record<string, string>> {
  if (assetIds.length === 0) return {};
  const unique = [...new Set(assetIds)];
  const assets = await prisma.syncedAsset.findMany({
    where: { tokenId: { in: unique } },
    include: { syncedMarket: { select: { id: true, title: true } } },
  });
  const map: Record<string, string> = {};
  for (const a of assets) {
    map[a.tokenId] = a.syncedMarket?.title ?? "Unknown market";
  }
  for (const id of unique) {
    if (!map[id]) map[id] = "Unknown market";
  }
  return map;
}

/**
 * Build timeline events for a funder. Reverse chronological.
 */
export async function getPortfolioTimeline(
  funderAddress: string,
  options: { limit?: number; from?: Date; to?: Date } = {}
): Promise<TimelineEvent[]> {
  const funder = funderAddress.toLowerCase().trim();
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 200);
  const from = options.from;
  const to = options.to;

  const events: TimelineEvent[] = [];

  // --- UserFill: position opened / increased / reduced ---
  const matchTimeRange =
    from && to ? { gte: from, lte: to } : from ? { gte: from } : to ? { lte: to } : undefined;
  const fills = await prisma.userFill.findMany({
    where: {
      funderAddress: funder,
      ...(matchTimeRange && { matchTime: matchTimeRange }),
    },
    orderBy: { matchTime: "desc" },
  });

  const fillsWithTime = fills.filter((f) => f.matchTime != null) as Array<{ matchTime: Date } & (typeof fills)[0]>;
  const firstFillByAsset = new Map<string, Date>();
  for (const f of fillsWithTime) {
    const t = f.matchTime.getTime();
    const cur = firstFillByAsset.get(f.assetId);
    if (!cur || t < cur.getTime()) firstFillByAsset.set(f.assetId, f.matchTime);
  }

  const assetIds = [...new Set(fillsWithTime.map((f) => f.assetId))];
  const marketTitles = await getMarketTitlesByAssetId(assetIds);
  const assetsWithMarket = await prisma.syncedAsset.findMany({
    where: { tokenId: { in: assetIds } },
    select: { tokenId: true, syncedMarketId: true },
  });
  const assetToMarketId: Record<string, string> = {};
  for (const a of assetsWithMarket) {
    if (a.syncedMarketId) assetToMarketId[a.tokenId] = a.syncedMarketId;
  }

  for (const f of fillsWithTime) {
    const at = f.matchTime;
    const title = marketTitles[f.assetId] ?? "Unknown market";
    const firstAt = firstFillByAsset.get(f.assetId);
    const isFirst = firstAt && firstAt.getTime() === at.getTime();
    const side = (f.side ?? "").toUpperCase();
    const size = parseNum(f.size);
    const price = parseNum(f.price);

    let type: "position_opened" | "position_increased" | "position_reduced";
    let eventTitle: string;
    let message: string;

    if (isFirst) {
      type = "position_opened";
      eventTitle = "Position opened";
      message = `${title} · ${side} ${size} @ ${(price * 100).toFixed(1)}¢`;
    } else if (side === "BUY" || side === "YES" || side === "NO") {
      type = "position_increased";
      eventTitle = "Position increased";
      message = `${title} · +${size} @ ${(price * 100).toFixed(1)}¢`;
    } else {
      type = "position_reduced";
      eventTitle = "Position reduced";
      message = `${title} · −${size} @ ${(price * 100).toFixed(1)}¢`;
    }

    events.push({
      id: `fill-${f.funderAddress}-${f.tradeId}`,
      type,
      occurredAt: at.toISOString(),
      title: eventTitle,
      message,
      assetId: f.assetId,
      marketId: assetToMarketId[f.assetId] ?? null,
      metadata: { tradeId: f.tradeId, side: f.side, size: f.size, price: f.price },
    });
  }

  // --- Recommendation created ---
  const recs = await prisma.recommendation.findMany({
    where: { marketSignal: { funderAddress: funder } },
    include: { marketSignal: true },
    orderBy: { createdAt: "desc" },
  });

  for (const r of recs) {
    if (from && r.createdAt < from) continue;
    if (to && r.createdAt > to) continue;
    events.push({
      id: `rec-created-${r.id}`,
      type: "recommendation_created",
      occurredAt: r.createdAt.toISOString(),
      title: "New recommendation",
      message: r.marketSignal.marketTitle ?? "Market",
      recommendationId: r.id,
      marketId: r.marketSignal.marketId,
      metadata: { action: r.action, primaryActionType: r.primaryActionType },
    });
  }

  // --- Recommendation lifecycle ---
  const lifecycleEvents = await prisma.recommendationLifecycleEvent.findMany({
    where: { funderAddress: funder },
    include: { recommendation: { include: { marketSignal: true } } },
    orderBy: { createdAt: "desc" },
  });

  for (const e of lifecycleEvents) {
    if (from && e.createdAt < from) continue;
    if (to && e.createdAt > to) continue;
    const label = LIFECYCLE_LABELS[e.eventType] ?? e.eventType;
    events.push({
      id: `lifecycle-${e.id}`,
      type: "recommendation_lifecycle",
      occurredAt: e.createdAt.toISOString(),
      title: label,
      message: e.recommendation?.marketSignal?.marketTitle ?? "Recommendation",
      recommendationId: e.recommendationId,
      marketId: e.recommendation?.marketSignal?.marketId ?? null,
      metadata: { eventType: e.eventType },
    });
  }

  // --- CopilotAlert ---
  const alerts = await prisma.copilotAlert.findMany({
    where: { funderAddress: funder },
    orderBy: { createdAt: "desc" },
  });

  for (const a of alerts) {
    if (from && a.createdAt < from) continue;
    if (to && a.createdAt > to) continue;
    events.push({
      id: `alert-${a.id}`,
      type: "alert_triggered",
      occurredAt: a.createdAt.toISOString(),
      title: ALERT_TYPE_LABELS[a.type] ?? a.type,
      message: a.message,
      alertId: a.id,
      marketId: a.marketId,
      assetId: a.assetId,
      metadata: { severity: a.severity },
    });
  }

  // --- PortfolioSnapshot ---
  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: { funderAddress: funder },
    orderBy: { createdAt: "desc" },
  });

  for (const s of snapshots) {
    if (from && s.createdAt < from) continue;
    if (to && s.createdAt > to) continue;
    const exp = parseNum(s.totalOpenExposure);
    const positions = s.openPositionsCount ?? 0;
    events.push({
      id: `snapshot-${s.id}`,
      type: "portfolio_snapshot",
      occurredAt: s.createdAt.toISOString(),
      title: "Portfolio snapshot",
      message: `${positions} position(s) · ${exp >= 0 ? `$${exp.toFixed(2)}` : "—"} exposure`,
      metadata: {
        openPositionsCount: s.openPositionsCount,
        totalOpenExposure: s.totalOpenExposure,
        unrealizedPnl: s.unrealizedPnl,
      },
    });
  }

  // Sort by occurredAt desc, then take limit
  events.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  return events.slice(0, limit);
}
