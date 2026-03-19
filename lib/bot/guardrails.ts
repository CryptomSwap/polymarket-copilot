/**
 * Bot guardrails v1: deterministic checks before any execution.
 * Suggest-only / dry-run; never places orders. Used by dry-run API and future bot.
 *
 * Bot-readiness: getGuardrailsReadiness() returns a preflight summary (ready/caution/blocked)
 * from existing persisted/live signals only. No mutation; no new tables.
 */

import { prisma } from "@/lib/db";
import { getPortfolioIntelligence } from "@/lib/portfolio/intelligence";
import { buildOrderPreview } from "@/lib/polymarket/order-preview";
import { getAlertFeed, type DriftAlertRowForFeed } from "@/lib/alerts/engine";
import type { BotCandidate, BotGuardrailConfig, GuardrailResult } from "./types";

// --- Bot-readiness (preflight summary) ---

export type GuardrailCheckStatus = "pass" | "warn" | "fail";

export interface GuardrailCheck {
  key: string;
  status: GuardrailCheckStatus;
  title: string;
  message: string;
  blocking: boolean;
  metadata?: Record<string, unknown>;
}

export type GuardrailsReadinessStatus = "ready" | "caution" | "blocked";

/** Key portfolio risk fields for guardrails/API (from portfolio risk engine). */
export interface GuardrailsPortfolioRiskSummary {
  totalOpenExposure: number;
  totalWorkingOrderExposure: number;
  maxSingleMarketConcentrationPct: number;
  maxSingleThemeConcentrationPct: number;
  worstCaseLossEstimate: number;
  nearResolutionExposure: number;
  concentrationFlags: { code: string; message: string; scope: string }[];
  riskFlags: { code: string; message: string; severity: string }[];
  warnings: string[];
  computedAt: string;
}

export interface GuardrailsReadinessPayload {
  ready: boolean;
  status: GuardrailsReadinessStatus;
  checks: GuardrailCheck[];
  asOf: string;
  notes?: string | null;
  /** Portfolio risk snapshot summary when available (from portfolio intelligence). */
  portfolioRisk?: GuardrailsPortfolioRiskSummary | null;
}

const CONCENTRATION_CAUTION_PCT = 35;
const CONCENTRATION_BLOCK_PCT = 55;
const FRESHNESS_CAUTION_MS = 5 * 60 * 1000; // 5 min

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Check guardrails for one candidate. Returns allowed/reason/failures. No side effects.
 */
export async function checkGuardrails(
  funderAddress: string,
  candidate: BotCandidate,
  config: BotGuardrailConfig
): Promise<GuardrailResult> {
  const funder = funderAddress.toLowerCase().trim();
  const failures: string[] = [];

  // --- 1. Never trade unresolved catalog markets ---
  const market = await prisma.syncedMarket.findUnique({
    where: { id: candidate.marketId },
  });
  if (!market) {
    failures.push("Market not in catalog (unresolved).");
    return { allowed: false, reason: "Unresolved catalog market.", failures };
  }
  const asset = await prisma.syncedAsset.findFirst({
    where: { syncedMarketId: candidate.marketId, tokenId: candidate.assetId },
  });
  if (!asset) {
    failures.push("Asset not in catalog for market.");
    return { allowed: false, reason: "Unresolved catalog asset.", failures };
  }

  // --- 2. Never trade on stale sync; never trade when catalog has unresolved positions ---
  if (config.blockStaleSync || config.blockUnresolvedCatalog) {
    let intelligence: Awaited<ReturnType<typeof getPortfolioIntelligence>>;
    try {
      intelligence = await getPortfolioIntelligence({ funderAddress: funder });
    } catch {
      failures.push("Portfolio intelligence unavailable (stale or error).");
      return { allowed: false, reason: "Cannot verify sync state.", failures };
    }
    if (config.blockStaleSync && (intelligence.summary.stalePositions ?? 0) > 0) {
      failures.push(`Portfolio has ${intelligence.summary.stalePositions} stale position(s). Run sync.`);
    }
    if (config.blockUnresolvedCatalog && (intelligence.summary.unresolvedPositions ?? 0) > 0) {
      failures.push(`Portfolio has ${intelligence.summary.unresolvedPositions} unresolved position(s).`);
    }
    if (failures.length > 0) {
      return { allowed: false, reason: failures[failures.length - 1], failures };
    }
  }

  // --- 3 & 4. Per-market and per-theme cap (via order preview) ---
  const preview = await buildOrderPreview({
    funderAddress: funder,
    marketId: candidate.marketId,
    assetId: candidate.assetId,
    outcome: candidate.outcome,
    side: candidate.side,
    limitPrice: candidate.limitPrice,
    size: candidate.size,
    recommendationId: candidate.recommendationId,
  });
  if (!preview.valid) {
    failures.push(...(preview.validationErrors ?? ["Preview invalid."]));
    return { allowed: false, reason: failures[failures.length - 1] ?? "Preview invalid.", failures };
  }
  if (preview.riskPreview) {
    const { postTopPct, postThemePct } = preview.riskPreview.concentrationImpact;
    if (postTopPct >= config.perMarketCapPct) {
      failures.push(`Post-trade top concentration would be ${postTopPct.toFixed(0)}% (cap ${config.perMarketCapPct}%).`);
    }
    if (postThemePct >= config.perThemeCapPct) {
      failures.push(`Post-trade theme concentration would be ${postThemePct.toFixed(0)}% (cap ${config.perThemeCapPct}%).`);
    }
    if (preview.riskPreview.blocked) {
      failures.push("Order preview blocked by concentration/safety rules.");
    }
  }

  // --- 5. Never add near resolution unless explicitly allowed ---
  if (
    candidate.side === "BUY" &&
    (candidate.primaryActionType === "add" || candidate.primaryActionType === null)
  ) {
    const endDate = market.endDate ?? null;
    if (endDate) {
      const hoursToResolution = (new Date(endDate).getTime() - Date.now()) / (60 * 60 * 1000);
      if (hoursToResolution <= config.nearResolutionBlockHours && !config.allowNearResolutionAdd) {
        failures.push(`Market resolves in ${Math.round(hoursToResolution)}h (block under ${config.nearResolutionBlockHours}h).`);
      }
    }
  }

  // --- 6. Never duplicate strongly overlapping thesis (theme overlap) ---
  if (candidate.side === "BUY" && candidate.primaryActionType === "add") {
    try {
      const intelligence = await getPortfolioIntelligence({ funderAddress: funder });
      const theme = candidate.marketTheme ?? "Other";
      const bucket = intelligence.buckets.byTheme.find((b) => b.key === theme);
      const themePct = bucket?.pct ?? 0;
      if (themePct >= config.duplicateThesisThemeCapPct) {
        failures.push(`Theme "${theme}" already at ${themePct.toFixed(0)}% (duplicate-thesis cap ${config.duplicateThesisThemeCapPct}%).`);
      }
    } catch {
      // Non-fatal: overlap check best-effort
    }
  }

  if (failures.length > 0) {
    return {
      allowed: false,
      reason: failures[failures.length - 1],
      failures,
    };
  }

  return {
    allowed: true,
    reason: "All guardrails passed.",
    failures: [],
  };
}

// --- Bot-readiness: preflight summary (read-only, no new tables) ---

/**
 * Evaluate bot-readiness from existing portfolio intelligence, alerts, and reconciliation data.
 * Deterministic; no mutation. Used by GET /api/bot/guardrails.
 */
export async function getGuardrailsReadiness(
  funderAddress: string
): Promise<GuardrailsReadinessPayload> {
  const funder = funderAddress?.trim()?.toLowerCase() ?? "";
  const asOf = new Date().toISOString();
  const checks: GuardrailCheck[] = [];

  let intelligence: Awaited<ReturnType<typeof getPortfolioIntelligence>> | null = null;
  try {
    intelligence = await getPortfolioIntelligence({ funderAddress: funder });
  } catch {
    checks.push({
      key: "portfolio_truth",
      status: "fail",
      title: "Portfolio truth-model",
      message: "Portfolio intelligence unavailable. Resolve sync and retry.",
      blocking: true,
      metadata: { error: true },
    });
  }

  if (intelligence) {
    const diag = intelligence.diagnostics;
    const summary = intelligence.summary;

    // Portfolio freshness
    const freshnessMs = diag.freshnessMs ?? null;
    if (freshnessMs == null) {
      checks.push({
        key: "portfolio_freshness",
        status: "warn",
        title: "Portfolio freshness",
        message: "Freshness unknown. Run sync to refresh.",
        blocking: false,
        metadata: { freshnessMs: null },
      });
    } else if (freshnessMs > FRESHNESS_CAUTION_MS) {
      checks.push({
        key: "portfolio_freshness",
        status: "warn",
        title: "Portfolio freshness",
        message: `Portfolio data is ${Math.round(freshnessMs / 60000)}m old. Consider re-syncing before automation.`,
        blocking: false,
        metadata: { freshnessMs },
      });
    } else {
      checks.push({
        key: "portfolio_freshness",
        status: "pass",
        title: "Portfolio freshness",
        message: "Portfolio data is recent.",
        blocking: false,
        metadata: { freshnessMs },
      });
    }

    // Unresolved positions
    const unresolved = summary.unresolvedPositions ?? 0;
    if (unresolved > 0) {
      checks.push({
        key: "unresolved_positions",
        status: "fail",
        title: "Unresolved positions",
        message: `${unresolved} position(s) not resolved to catalog. Resolve before automation.`,
        blocking: true,
        metadata: { count: unresolved },
      });
    } else {
      checks.push({
        key: "unresolved_positions",
        status: "pass",
        title: "Unresolved positions",
        message: "All positions resolved to catalog.",
        blocking: false,
      });
    }

    // High concentration
    const themePct = summary.topThemeConcentrationPct ?? 0;
    const marketPct = summary.topMarketConcentrationPct ?? 0;
    const maxPct = Math.max(themePct, marketPct);
    if (maxPct >= CONCENTRATION_BLOCK_PCT) {
      checks.push({
        key: "high_concentration",
        status: "fail",
        title: "High concentration",
        message: `Top concentration ${maxPct.toFixed(0)}% (theme or market). Reduce before automation.`,
        blocking: true,
        metadata: { topThemeConcentrationPct: themePct, topMarketConcentrationPct: marketPct },
      });
    } else if (maxPct >= CONCENTRATION_CAUTION_PCT) {
      checks.push({
        key: "high_concentration",
        status: "warn",
        title: "High concentration",
        message: `Top concentration ${maxPct.toFixed(0)}%. Consider trimming before automation.`,
        blocking: false,
        metadata: { topThemeConcentrationPct: themePct, topMarketConcentrationPct: marketPct },
      });
    } else {
      checks.push({
        key: "high_concentration",
        status: "pass",
        title: "Concentration",
        message: "Concentration within range.",
        blocking: false,
        metadata: { topThemeConcentrationPct: themePct, topMarketConcentrationPct: marketPct },
      });
    }

    // Stale sync
    const stale = summary.stalePositions ?? 0;
    if (stale > 0) {
      checks.push({
        key: "stale_sync",
        status: "fail",
        title: "Stale sync",
        message: `${stale} position(s) have stale sync. Run portfolio sync.`,
        blocking: true,
        metadata: { count: stale },
      });
    } else {
      checks.push({
        key: "stale_sync",
        status: "pass",
        title: "Stale sync",
        message: "No stale positions.",
        blocking: false,
      });
    }
  }

  // High-severity alerts (drift + engine)
  const driftRows = await prisma.driftAlert.findMany({
    where: { funderAddress: funder, resolved: false },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
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
  const hasCritical = alerts.some((a) => a.severity === "critical");
  if (hasCritical) {
    checks.push({
      key: "high_severity_alerts",
      status: "fail",
      title: "High-severity alerts",
      message: "Critical alert(s) present. Resolve before automation.",
      blocking: true,
      metadata: { activeAlertsCount: alerts.length, hasCritical: true },
    });
  } else if (alerts.length > 0) {
    checks.push({
      key: "high_severity_alerts",
      status: "warn",
      title: "Active alerts",
      message: `${alerts.length} non-critical alert(s). Review before automation.`,
      blocking: false,
      metadata: { activeAlertsCount: alerts.length },
    });
  } else {
    checks.push({
      key: "high_severity_alerts",
      status: "pass",
      title: "Alerts",
      message: "No active alerts.",
      blocking: false,
    });
  }

  // Order reconciliation mismatch
  const mismatchCount = await prisma.orderReconciliationSnapshot.count({
    where: { funderAddress: funder, mismatch: true },
  });
  if (mismatchCount > 0) {
    checks.push({
      key: "reconciliation_mismatch",
      status: "warn",
      title: "Order reconciliation",
      message: `${mismatchCount} order(s) with local/remote mismatch. Run reconcile.`,
      blocking: false,
      metadata: { mismatchCount },
    });
  } else {
    checks.push({
      key: "reconciliation_mismatch",
      status: "pass",
      title: "Order reconciliation",
      message: "No reconciliation mismatches.",
      blocking: false,
    });
  }

  // Recommendation review readiness (inferable: unreviewed = no review or status NEW)
  const [unreviewedCount, totalRecs] = await Promise.all([
    prisma.recommendation.count({
      where: {
        marketSignal: { funderAddress: funder },
        OR: [{ review: null }, { review: { status: "NEW" } }],
      },
    }),
    prisma.recommendation.count({
      where: { marketSignal: { funderAddress: funder } },
    }),
  ]);
  if (totalRecs > 0 && unreviewedCount > 0) {
    checks.push({
      key: "recommendation_review",
      status: unreviewedCount >= totalRecs ? "warn" : "pass",
      title: "Recommendation review",
      message:
        unreviewedCount >= totalRecs
          ? "All recommendations unreviewed. Review before automation."
          : `${unreviewedCount} recommendation(s) not yet reviewed.`,
      blocking: false,
      metadata: { unreviewedCount, total: totalRecs },
    });
  } else {
    checks.push({
      key: "recommendation_review",
      status: "pass",
      title: "Recommendation review",
      message: "No pending review or no recommendations.",
      blocking: false,
    });
  }

  const blockingCount = checks.filter((c) => c.blocking).length;
  const warnCount = checks.filter((c) => c.status === "warn" && !c.blocking).length;
  const ready = blockingCount === 0;
  let status: GuardrailsReadinessStatus = "ready";
  if (blockingCount > 0) status = "blocked";
  else if (warnCount > 0) status = "caution";

  let portfolioRisk: GuardrailsPortfolioRiskSummary | null = null;
  if (intelligence?.portfolioRiskSnapshot) {
    const s = intelligence.portfolioRiskSnapshot;
    portfolioRisk = {
      totalOpenExposure: s.totalOpenExposure,
      totalWorkingOrderExposure: s.totalWorkingOrderExposure,
      maxSingleMarketConcentrationPct: s.maxSingleMarketConcentrationPct,
      maxSingleThemeConcentrationPct: s.maxSingleThemeConcentrationPct,
      worstCaseLossEstimate: s.worstCaseLossEstimate,
      nearResolutionExposure: s.nearResolutionExposure,
      concentrationFlags: s.concentrationFlags.map((f) => ({ code: f.code, message: f.message, scope: f.scope })),
      riskFlags: s.riskFlags.map((f) => ({ code: f.code, message: f.message, severity: f.severity })),
      warnings: s.warnings,
      computedAt: s.computedAt,
    };
  }

  return {
    ready,
    status,
    checks,
    asOf,
    notes:
      status === "blocked"
        ? "One or more checks block automation. Resolve and refresh."
        : status === "caution"
          ? "Automation allowed but some checks suggest caution."
          : undefined,
    portfolioRisk,
  };
}
