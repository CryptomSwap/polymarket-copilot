/**
 * Bot guardrails v1: deterministic checks before any execution.
 * Suggest-only / dry-run; never places orders. Used by dry-run API and future bot.
 */

import { prisma } from "@/lib/db";
import { getPortfolioIntelligence } from "@/lib/portfolio/intelligence";
import { buildOrderPreview } from "@/lib/polymarket/order-preview";
import type { BotCandidate, BotGuardrailConfig, GuardrailResult } from "./types";

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
