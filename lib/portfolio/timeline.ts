/**
 * Portfolio Timeline: deterministic, read-only merge of portfolio-related events
 * into a single chronological feed. No new tables; uses existing persistence only.
 *
 * Sources: DriftAlert, BehaviorFlag, RecommendationLifecycleEvent, RecommendationExecutionOutcome,
 * OrderReconciliationSnapshot, PostTradeJournalEntry, CopilotAlert.
 */

import { prisma } from "@/lib/db";

/** Source identifier for filtering. */
export type TimelineSourceFilter =
  | "all"
  | "drift"
  | "behavior"
  | "recommendation"
  | "execution"
  | "reconciliation"
  | "journal"
  | "copilot";

/** Normalized timeline item for API/UI. One per persisted row; deterministic title/message from stored fields. */
export interface TimelineItem {
  id: string;
  eventType: string;
  source: Exclude<TimelineSourceFilter, "all">;
  title: string;
  message: string;
  severity: string | null;
  entityRefs: {
    recommendationId?: string | null;
    marketId?: string | null;
    assetId?: string | null;
    orderId?: string | null;
    alertId?: string | null;
    journalEntryId?: string | null;
  };
  createdAt: string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

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

const COPILOT_ALERT_TYPE_LABELS: Record<string, string> = {
  CONCENTRATION_BREACH: "Concentration breach",
  NEW_ADD_OPPORTUNITY: "Add opportunity",
  NEAR_RESOLUTION_REVIEW: "Near resolution",
  HELD_MARKET_SIGNAL_FLIP: "Held market signal flip",
  DATA_HEALTH: "Data health",
};

function inRange(createdAt: Date, since?: Date): boolean {
  if (!since) return true;
  return createdAt >= since;
}

/**
 * Fetch and map DriftAlert rows to timeline items.
 */
async function getDriftItems(funder: string, since?: Date): Promise<TimelineItem[]> {
  const rows = await prisma.driftAlert.findMany({
    where: { funderAddress: funder, ...(since && { createdAt: { gte: since } }) },
    orderBy: { createdAt: "desc" },
    take: MAX_LIMIT,
  });
  return rows.map((r) => ({
    id: `drift-${r.id}`,
    eventType: "drift_alert",
    source: "drift" as const,
    title: r.alertType.replace(/_/g, " "),
    message: r.message,
    severity: r.severity,
    entityRefs: {
      marketId: r.marketId ?? null,
      assetId: r.assetId ?? null,
      alertId: r.id,
    },
    createdAt: r.createdAt.toISOString(),
    metadata: { polymarketOrderId: r.polymarketOrderId, resolved: r.resolved },
  }));
}

/**
 * Fetch and map BehaviorFlag rows to timeline items.
 */
async function getBehaviorItems(funder: string, since?: Date): Promise<TimelineItem[]> {
  const rows = await prisma.behaviorFlag.findMany({
    where: { funderAddress: funder, ...(since && { createdAt: { gte: since } }) },
    orderBy: { createdAt: "desc" },
    take: MAX_LIMIT,
  });
  return rows.map((r) => ({
    id: `behavior-${r.id}`,
    eventType: "behavior_flag",
    source: "behavior" as const,
    title: r.type.replace(/_/g, " "),
    message: r.description,
    severity: r.severity,
    entityRefs: {},
    createdAt: r.createdAt.toISOString(),
    metadata: (() => {
      const o: Record<string, unknown> = {};
      if (r.marketTitle) o.marketTitle = r.marketTitle;
      if (r.sourceScope) o.sourceScope = r.sourceScope;
      return Object.keys(o).length ? o : undefined;
    })(),
  }));
}

/**
 * Fetch RecommendationLifecycleEvent and recommendation-created; map to timeline items.
 */
async function getRecommendationItems(funder: string, since?: Date): Promise<TimelineItem[]> {
  const items: TimelineItem[] = [];

  const lifecycle = await prisma.recommendationLifecycleEvent.findMany({
    where: { funderAddress: funder, ...(since && { createdAt: { gte: since } }) },
    include: { recommendation: { include: { marketSignal: true } } },
    orderBy: { createdAt: "desc" },
    take: MAX_LIMIT,
  });
  for (const e of lifecycle) {
    const label = LIFECYCLE_LABELS[e.eventType] ?? e.eventType;
    items.push({
      id: `lifecycle-${e.id}`,
      eventType: "lifecycle_event",
      source: "recommendation",
      title: label,
      message: e.recommendation?.marketSignal?.marketTitle ?? "Recommendation",
      severity: null,
      entityRefs: {
        recommendationId: e.recommendationId,
        marketId: e.recommendation?.marketSignal?.marketId ?? null,
      },
      createdAt: e.createdAt.toISOString(),
      metadata: { eventType: e.eventType },
    });
  }

  const recs = await prisma.recommendation.findMany({
    where: { marketSignal: { funderAddress: funder } },
    include: { marketSignal: true },
    orderBy: { createdAt: "desc" },
    take: MAX_LIMIT,
  });
  for (const r of recs) {
    if (!inRange(r.createdAt, since)) continue;
    items.push({
      id: `rec-created-${r.id}`,
      eventType: "recommendation_created",
      source: "recommendation",
      title: "New recommendation",
      message: r.marketSignal.marketTitle ?? "Market",
      severity: null,
      entityRefs: { recommendationId: r.id, marketId: r.marketSignal.marketId },
      createdAt: r.createdAt.toISOString(),
      metadata: { action: r.action, primaryActionType: r.primaryActionType },
    });
  }

  return items;
}

/**
 * Fetch RecommendationExecutionOutcome; map to timeline items.
 */
async function getExecutionItems(funder: string, since?: Date): Promise<TimelineItem[]> {
  const rows = await prisma.recommendationExecutionOutcome.findMany({
    where: { funderAddress: funder, ...(since && { createdAt: { gte: since } }) },
    include: { recommendation: { include: { marketSignal: true } } },
    orderBy: { createdAt: "desc" },
    take: MAX_LIMIT,
  });
  return rows.map((r) => ({
    id: `execution-${r.id}`,
    eventType: "execution_outcome",
    source: "execution",
    title: r.actedOn ? "Order acted on" : "Execution outcome",
    message: r.recommendation?.marketSignal?.marketTitle ?? "Recommendation",
    severity: null,
    entityRefs: {
      recommendationId: r.recommendationId,
      marketId: r.recommendation?.marketSignal?.marketId ?? null,
    },
    createdAt: r.createdAt.toISOString(),
    metadata: {
      actedOn: r.actedOn,
      overridden: r.overridden,
      suggestedSize: r.suggestedSize,
      actualSize: r.actualSize,
      fillStatus: r.fillStatus,
    },
  }));
}

/**
 * Fetch OrderReconciliationSnapshot; map to timeline items.
 */
async function getReconciliationItems(funder: string, since?: Date): Promise<TimelineItem[]> {
  const rows = await prisma.orderReconciliationSnapshot.findMany({
    where: { funderAddress: funder, ...(since && { createdAt: { gte: since } }) },
    orderBy: { createdAt: "desc" },
    take: MAX_LIMIT,
  });
  return rows.map((r) => ({
    id: `reconciliation-${r.id}`,
    eventType: "reconciliation_snapshot",
    source: "reconciliation",
    title: r.mismatch ? "Order mismatch" : "Order reconciliation",
    message: r.filledSize != null ? `Filled ${r.filledSize}` : r.localStatus,
    severity: r.mismatch ? "warning" : null,
    entityRefs: { orderId: r.polymarketOrderId },
    createdAt: r.createdAt.toISOString(),
    metadata: {
      localStatus: r.localStatus,
      remoteStatus: r.remoteStatus,
      filledSize: r.filledSize,
      remainingSize: r.remainingSize,
      mismatch: r.mismatch,
    },
  }));
}

/**
 * Fetch PostTradeJournalEntry; map to timeline items.
 */
async function getJournalItems(funder: string, since?: Date): Promise<TimelineItem[]> {
  const rows = await prisma.postTradeJournalEntry.findMany({
    where: { funderAddress: funder, ...(since && { createdAt: { gte: since } }) },
    orderBy: { createdAt: "desc" },
    take: MAX_LIMIT,
  });
  return rows.map((r) => ({
    id: `journal-${r.id}`,
    eventType: "journal_entry",
    source: "journal",
    title: `Journal (${r.tag})`,
    message: r.note,
    severity: null,
    entityRefs: {
      recommendationId: r.recommendationId ?? null,
      journalEntryId: r.id,
    },
    createdAt: r.createdAt.toISOString(),
    metadata: { tag: r.tag, marketId: r.marketId, assetId: r.assetId },
  }));
}

/**
 * Fetch CopilotAlert; map to timeline items.
 */
async function getCopilotItems(funder: string, since?: Date): Promise<TimelineItem[]> {
  const rows = await prisma.copilotAlert.findMany({
    where: { funderAddress: funder, ...(since && { createdAt: { gte: since } }) },
    orderBy: { createdAt: "desc" },
    take: MAX_LIMIT,
  });
  return rows.map((r) => ({
    id: `copilot-${r.id}`,
    eventType: "copilot_alert",
    source: "copilot",
    title: COPILOT_ALERT_TYPE_LABELS[r.type] ?? r.type.replace(/_/g, " "),
    message: r.message,
    severity: r.severity,
    entityRefs: {
      recommendationId: r.recommendationId ?? null,
      marketId: r.marketId ?? null,
      assetId: r.assetId ?? null,
      alertId: r.id,
    },
    createdAt: r.createdAt.toISOString(),
    metadata: (r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
      ? (r.metadata as Record<string, unknown>)
      : undefined),
  }));
}

/**
 * Build merged timeline for a funder. Newest-first; deterministic; read-only.
 */
export async function getPortfolioTimeline(
  funderAddress: string,
  options: {
    limit?: number;
    since?: Date;
    source?: TimelineSourceFilter;
  } = {}
): Promise<TimelineItem[]> {
  const funder = funderAddress.toLowerCase().trim();
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const since = options.since;
  const sourceFilter = options.source ?? "all";

  const fetchers: Array<() => Promise<TimelineItem[]>> = [];

  if (sourceFilter === "all" || sourceFilter === "drift") fetchers.push(() => getDriftItems(funder, since));
  if (sourceFilter === "all" || sourceFilter === "behavior") fetchers.push(() => getBehaviorItems(funder, since));
  if (sourceFilter === "all" || sourceFilter === "recommendation") fetchers.push(() => getRecommendationItems(funder, since));
  if (sourceFilter === "all" || sourceFilter === "execution") fetchers.push(() => getExecutionItems(funder, since));
  if (sourceFilter === "all" || sourceFilter === "reconciliation") fetchers.push(() => getReconciliationItems(funder, since));
  if (sourceFilter === "all" || sourceFilter === "journal") fetchers.push(() => getJournalItems(funder, since));
  if (sourceFilter === "all" || sourceFilter === "copilot") fetchers.push(() => getCopilotItems(funder, since));

  const results = await Promise.all(fetchers.map((f) => f()));
  const merged = results.flat();
  merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return merged.slice(0, limit);
}
