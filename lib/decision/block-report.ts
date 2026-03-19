/**
 * Aggregate report on why recommendations are BLOCKed (policyState=BLOCK, finalSuggestedSize=0).
 * Parses reasoningJson from DecisionPolicySnapshot to count by block reason and category.
 */

import { prisma } from "@/lib/db";

export type BlockCategory =
  | "eligibility"
  | "theme_concentration"
  | "portfolio_fit"
  | "market_quality"
  | "liquidity"
  | "low_score"
  | "no_trade_watch"
  | "unknown";

interface ParsedReasoning {
  blockReason: string | null;
  blockers: string[];
  marketQualityReasons: string[];
  portfolioFitReasons: string[];
  policyState?: string;
  blendedScore?: number;
}

function parseReasoningJson(reasoningJson: string | null): ParsedReasoning | null {
  if (!reasoningJson?.trim()) return null;
  try {
    const o = JSON.parse(reasoningJson) as Record<string, unknown>;
    return {
      blockReason: typeof o.blockReason === "string" ? o.blockReason : null,
      blockers: Array.isArray(o.blockers) ? (o.blockers as string[]) : [],
      marketQualityReasons: Array.isArray(o.marketQualityReasons) ? (o.marketQualityReasons as string[]) : [],
      portfolioFitReasons: Array.isArray(o.portfolioFitReasons) ? (o.portfolioFitReasons as string[]) : [],
      policyState: typeof o.policyState === "string" ? o.policyState : undefined,
      blendedScore: typeof o.blendedScore === "number" ? o.blendedScore : undefined,
    };
  } catch {
    return null;
  }
}

function categorizeBlockReason(
  blockReason: string | null,
  parsed: ParsedReasoning,
  action?: string
): BlockCategory {
  if (!blockReason || !blockReason.trim()) {
    if (action === "NO_TRADE" || action === "WATCH") return "no_trade_watch";
    if (parsed.blendedScore != null && parsed.blendedScore < 0.5) return "low_score";
    return "unknown";
  }
  const r = blockReason.toLowerCase();
  if (r.includes("theme concentration") || r.includes("exceeds limit")) return "theme_concentration";
  if (r.includes("liquidity too low") || r.includes("liquidity")) return "liquidity";
  if (
    r.includes("market crowded") ||
    r.includes("market quality") ||
    r.includes("news saturation")
  )
    return "market_quality";
  if (
    r.includes("high theme exposure") ||
    r.includes("high concentration") ||
    r.includes("behavior") ||
    r.includes("portfolio overconcentrated") ||
    r.includes("portfolio fit")
  )
    return "portfolio_fit";
  if (
    r.includes("review") ||
    r.includes("rejected") ||
    r.includes("blocked") ||
    r.includes("chase") ||
    parsed.blockers.length > 0
  )
    return "eligibility";
  return "unknown";
}

export interface BlockReportSample {
  recommendationId: string;
  funderAddress: string;
  policyState: string;
  finalSuggestedSize: string;
  blockReason: string | null;
  blockers: string[];
  marketQualityReasons: string[];
  portfolioFitReasons: string[];
  category: BlockCategory;
  blendedScore: number | null;
}

export interface BlockReportResult {
  totalSnapshots: number;
  byPolicyState: Record<string, number>;
  byBlockReason: Record<string, number>;
  byCategory: Record<BlockCategory, number>;
  liquidityRelatedCount: number;
  riskRelatedCount: number;
  portfolioThemeConcentrationCount: number;
  missingOrQualityCount: number;
  sampleBlocked: BlockReportSample[];
}

/**
 * Build aggregate report of why snapshots are BLOCK (and finalSuggestedSize=0).
 * Optionally filter by funderAddress; if not provided, uses all snapshots (or pass a funder for paper-trading context).
 */
export async function buildBlockReport(funderAddress?: string): Promise<BlockReportResult> {
  const where = funderAddress ? { funderAddress: funderAddress.toLowerCase().trim() } : {};
  const snapshots = await prisma.decisionPolicySnapshot.findMany({
    where,
    select: {
      recommendationId: true,
      funderAddress: true,
      policyState: true,
      finalSuggestedSize: true,
      reasoningJson: true,
    },
  });

  const byPolicyState: Record<string, number> = {};
  const byBlockReason: Record<string, number> = {};
  const byCategory: Record<BlockCategory, number> = {
    eligibility: 0,
    theme_concentration: 0,
    portfolio_fit: 0,
    market_quality: 0,
    liquidity: 0,
    low_score: 0,
    no_trade_watch: 0,
    unknown: 0,
  };
  const sampleBlocked: BlockReportSample[] = [];
  const blockedSnapshots: { snapshot: (typeof snapshots)[0]; parsed: ParsedReasoning; category: BlockCategory }[] = [];

  for (const s of snapshots) {
    byPolicyState[s.policyState] = (byPolicyState[s.policyState] ?? 0) + 1;
    const parsed = parseReasoningJson(s.reasoningJson);
    const blockReason = parsed?.blockReason ?? null;
    if (blockReason) {
      byBlockReason[blockReason] = (byBlockReason[blockReason] ?? 0) + 1;
    }
    const category = categorizeBlockReason(blockReason, parsed ?? { blockReason: null, blockers: [], marketQualityReasons: [], portfolioFitReasons: [] });
    byCategory[category]++;

    if (s.policyState === "BLOCK" && parsed) {
      blockedSnapshots.push({ snapshot: s, parsed, category });
    }
  }

  const liquidityRelatedCount = byCategory.liquidity;
  const riskRelatedCount = byCategory.portfolio_fit + byCategory.theme_concentration;
  const portfolioThemeConcentrationCount = byCategory.theme_concentration + byCategory.portfolio_fit;
  const missingOrQualityCount = byCategory.market_quality + byCategory.eligibility;

  for (const { snapshot: s, parsed, category } of blockedSnapshots.slice(0, 20)) {
    sampleBlocked.push({
      recommendationId: s.recommendationId,
      funderAddress: s.funderAddress,
      policyState: s.policyState,
      finalSuggestedSize: s.finalSuggestedSize,
      blockReason: parsed.blockReason,
      blockers: parsed.blockers,
      marketQualityReasons: parsed.marketQualityReasons,
      portfolioFitReasons: parsed.portfolioFitReasons,
      category,
      blendedScore: parsed.blendedScore ?? null,
    });
  }

  return {
    totalSnapshots: snapshots.length,
    byPolicyState,
    byBlockReason,
    byCategory,
    liquidityRelatedCount,
    riskRelatedCount,
    portfolioThemeConcentrationCount,
    missingOrQualityCount,
    sampleBlocked,
  };
}
