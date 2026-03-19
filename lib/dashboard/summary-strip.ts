/**
 * Dashboard summary strip: aggregate current portfolio state from existing services.
 * Read-only; no new tables. Uses portfolio intelligence, open orders, and alert feed.
 */

import { prisma } from "@/lib/db";
import { getPortfolioIntelligence } from "@/lib/portfolio/intelligence";
import { getLiveOfficialOpenOrders } from "@/lib/portfolio/live-open-orders-service";
import { getAlertFeed, type DriftAlertRowForFeed } from "@/lib/alerts/engine";

/** Compact payload for dashboard summary strip UI. */
export interface SummaryStripPayload {
  openPositionsCount: number;
  openOrdersCount: number;
  topThemeConcentrationPct: number | null;
  topMarketConcentrationPct: number | null;
  unresolvedPositionsCount: number;
  activeAlertsCount: number;
  hasHighSeverityAlert: boolean;
  /** Portfolio positions data. */
  portfolioAsOf: string | null;
  portfolioFreshnessMs: number | null;
  portfolioFreshnessState: string | null;
  /** Orders data (may differ from portfolio timestamp). */
  ordersAsOf: string | null;
  ordersFreshnessMs: number | null;
  ordersFreshnessState: string | null;
  /** Source labels for mixed-time transparency. */
  portfolioSourceOfTruth: string | null;
  orderSourceOfTruth: string | null;
}

/**
 * Build summary strip from existing intelligence, open orders, and alert feed.
 * Deterministic; no new persistence.
 */
export async function getDashboardSummaryStrip(
  funderAddress: string
): Promise<SummaryStripPayload> {
  const funder = funderAddress?.trim()?.toLowerCase() ?? "";

  const [intelligence, liveOrders, driftRows] = await Promise.all([
    getPortfolioIntelligence({ funderAddress: funder }).catch(() => null),
    getLiveOfficialOpenOrders(funder),
    prisma.driftAlert.findMany({
      where: { funderAddress: funder, resolved: false },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  const driftAlerts: DriftAlertRowForFeed[] = driftRows.map((a) => ({
    id: a.id,
    alertType: a.alertType,
    severity: a.severity,
    message: a.message,
    polymarketOrderId: a.polymarketOrderId ?? null,
    assetId: a.assetId ?? null,
    marketId: a.marketId ?? null,
    resolved: a.resolved,
    createdAt: a.createdAt,
  }));

  const alerts = getAlertFeed({
    funderAddress: funder,
    driftAlerts,
    intelligence: intelligence ?? undefined,
    source: "all",
    limit: 200,
  });

  const openOrdersCount = liveOrders.metadata.success ? liveOrders.orders.length : 0;

  const summary = intelligence?.summary;
  const diagnostics = intelligence?.diagnostics;

  return {
    openPositionsCount: summary?.totalPositions ?? 0,
    openOrdersCount,
    topThemeConcentrationPct: summary?.topThemeConcentrationPct ?? null,
    topMarketConcentrationPct: summary?.topMarketConcentrationPct ?? null,
    unresolvedPositionsCount: summary?.unresolvedPositions ?? 0,
    activeAlertsCount: alerts.length,
    hasHighSeverityAlert: alerts.some((a) => a.severity === "critical"),
    portfolioAsOf: diagnostics?.asOf ?? null,
    portfolioFreshnessMs: diagnostics?.freshnessMs ?? null,
    portfolioFreshnessState: diagnostics?.freshnessState ?? null,
    ordersAsOf: diagnostics?.ordersAsOf ?? null,
    ordersFreshnessMs: diagnostics?.ordersFreshnessMs ?? null,
    ordersFreshnessState: diagnostics?.ordersFreshnessState ?? null,
    portfolioSourceOfTruth: diagnostics?.sourceOfTruth ?? null,
    orderSourceOfTruth: diagnostics?.orderSourceOfTruth ?? null,
  };
}
