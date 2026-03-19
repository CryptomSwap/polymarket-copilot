/**
 * Policy block breakdown report.
 * Explains why DecisionPolicySnapshot rows are BLOCK for the current paper/recompute funder.
 *
 * Writes:
 * - dump/policy-block-breakdown-report.json
 * - dump/policy-block-breakdown-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getFunderForDecisionRecompute } from "../lib/decision/recompute";

type BlockFamily =
  | "working_orders_breach"
  | "concentration"
  | "portfolio_penalty"
  | "liquidity_market_quality"
  | "threshold"
  | "other";

interface ParsedReasoning {
  blockReason: string | null;
  blockers: string[];
  marketQualityReasons: string[];
  portfolioFitReasons: string[];
  edgeReasons: string[];
  sizingReasons: string[];
  blendedScore: number | null;
}

const SAMPLE_LIMIT = 25;

function parseReasoningJson(reasoningJson: string | null): ParsedReasoning {
  if (!reasoningJson?.trim()) {
    return {
      blockReason: null,
      blockers: [],
      marketQualityReasons: [],
      portfolioFitReasons: [],
      edgeReasons: [],
      sizingReasons: [],
      blendedScore: null,
    };
  }
  try {
    const o = JSON.parse(reasoningJson) as Record<string, unknown>;
    return {
      blockReason: typeof o.blockReason === "string" ? o.blockReason : null,
      blockers: Array.isArray(o.blockers) ? (o.blockers as string[]) : [],
      marketQualityReasons: Array.isArray(o.marketQualityReasons) ? (o.marketQualityReasons as string[]) : [],
      portfolioFitReasons: Array.isArray(o.portfolioFitReasons) ? (o.portfolioFitReasons as string[]) : [],
      edgeReasons: Array.isArray(o.edgeReasons) ? (o.edgeReasons as string[]) : [],
      sizingReasons: Array.isArray(o.sizingReasons) ? (o.sizingReasons as string[]) : [],
      blendedScore: typeof o.blendedScore === "number" ? o.blendedScore : null,
    };
  } catch {
    return {
      blockReason: null,
      blockers: [],
      marketQualityReasons: [],
      portfolioFitReasons: [],
      edgeReasons: [],
      sizingReasons: [],
      blendedScore: null,
    };
  }
}

function normalizeReasonText(parts: string[]): string {
  return parts
    .map((p) => p.toLowerCase().trim())
    .filter(Boolean)
    .join(" | ");
}

function classifyBlockFamily(parsed: ParsedReasoning): BlockFamily {
  const text = normalizeReasonText([
    parsed.blockReason ?? "",
    ...parsed.blockers,
    ...parsed.marketQualityReasons,
    ...parsed.portfolioFitReasons,
    ...parsed.edgeReasons,
    ...parsed.sizingReasons,
  ]);

  if (
    /working order|working_order|open order|reserved order|order cap|too many orders|working exposure|reserved exposure/.test(
      text
    )
  ) {
    return "working_orders_breach";
  }
  if (
    /theme concentration|high concentration|concentration exceeds|overconcentrated|high theme exposure|theme exposure/.test(
      text
    )
  ) {
    return "concentration";
  }
  if (
    /behavior flags|behavior penalty|portfolio overconcentrated|portfolio fit|portfolio penalty/.test(
      text
    )
  ) {
    return "portfolio_penalty";
  }
  if (
    /liquidity too low|moderate liquidity|market crowded|market quality|news saturation|execution risk/.test(
      text
    )
  ) {
    return "liquidity_market_quality";
  }
  if (
    /edge too small|low conviction|below threshold|no-trade recommendation|watch only|no_trade|watch/.test(
      text
    )
  ) {
    return "threshold";
  }
  return "other";
}

function pct(n: number, d: number): number {
  if (d <= 0) return 0;
  return (n / d) * 100;
}

async function main(): Promise<void> {
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });

  const funder = (await getFunderForDecisionRecompute())?.trim().toLowerCase() ?? "";
  if (!funder) throw new Error("No funder resolved.");

  const snapshots = await prisma.decisionPolicySnapshot.findMany({
    where: { funderAddress: funder, policyState: "BLOCK" },
    include: {
      recommendation: {
        include: {
          marketSignal: {
            select: {
              marketId: true,
              marketTitle: true,
              outcome: true,
              side: true,
              signalType: true,
              category: true,
              theme: true,
              marketPrice: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const allSignals = snapshots.map((s) => s.recommendation.marketSignal);
  const marketIds = Array.from(new Set(allSignals.map((s) => s.marketId)));
  const outcomes = Array.from(new Set(allSignals.map((s) => s.outcome)));
  const assets = await prisma.syncedAsset.findMany({
    where: {
      syncedMarketId: { in: marketIds },
      outcome: { in: outcomes },
    },
    select: { syncedMarketId: true, outcome: true, tokenId: true },
  });
  const assetIdByMarketOutcome = new Map<string, string>();
  for (const a of assets) {
    assetIdByMarketOutcome.set(`${a.syncedMarketId}::${a.outcome}`, a.tokenId);
  }

  const byFamily: Record<BlockFamily, number> = {
    working_orders_breach: 0,
    concentration: 0,
    portfolio_penalty: 0,
    liquidity_market_quality: 0,
    threshold: 0,
    other: 0,
  };
  const byBlockReason = new Map<string, number>();
  const byPortfolioFitReason = new Map<string, number>();
  const byEligibilityBlocker = new Map<string, number>();
  const byMarketQualityReason = new Map<string, number>();
  const byMarket = new Map<string, number>();
  const byAsset = new Map<string, number>();
  const sampleRows: Array<{
    recommendationId: string;
    snapshotId: string;
    marketId: string;
    marketTitle: string;
    assetId: string | null;
    outcome: string;
    side: string;
    blockFamily: BlockFamily;
    blockReason: string | null;
    portfolioFitReasons: string[];
    marketQualityReasons: string[];
    blockers: string[];
    blendedScore: number | null;
    finalSuggestedSize: string;
    createdAt: string;
  }> = [];

  for (const s of snapshots) {
    const parsed = parseReasoningJson(s.reasoningJson);
    const family = classifyBlockFamily(parsed);
    byFamily[family]++;

    const reasonKey = parsed.blockReason?.trim() || "unknown";
    byBlockReason.set(reasonKey, (byBlockReason.get(reasonKey) ?? 0) + 1);
    for (const r of parsed.portfolioFitReasons) {
      const k = r.trim() || "unknown";
      byPortfolioFitReason.set(k, (byPortfolioFitReason.get(k) ?? 0) + 1);
    }
    for (const r of parsed.blockers) {
      const k = r.trim() || "unknown";
      byEligibilityBlocker.set(k, (byEligibilityBlocker.get(k) ?? 0) + 1);
    }
    for (const r of parsed.marketQualityReasons) {
      const k = r.trim() || "unknown";
      byMarketQualityReason.set(k, (byMarketQualityReason.get(k) ?? 0) + 1);
    }

    const signal = s.recommendation.marketSignal;
    byMarket.set(signal.marketId, (byMarket.get(signal.marketId) ?? 0) + 1);
    const assetId = assetIdByMarketOutcome.get(`${signal.marketId}::${signal.outcome}`) ?? null;
    if (assetId) byAsset.set(assetId, (byAsset.get(assetId) ?? 0) + 1);

    if (sampleRows.length < SAMPLE_LIMIT) {
      sampleRows.push({
        recommendationId: s.recommendationId,
        snapshotId: s.id,
        marketId: signal.marketId,
        marketTitle: signal.marketTitle,
        assetId,
        outcome: signal.outcome,
        side: signal.side,
        blockFamily: family,
        blockReason: parsed.blockReason,
        portfolioFitReasons: parsed.portfolioFitReasons,
        marketQualityReasons: parsed.marketQualityReasons,
        blockers: parsed.blockers,
        blendedScore: parsed.blendedScore,
        finalSuggestedSize: s.finalSuggestedSize,
        createdAt: s.createdAt.toISOString(),
      });
    }
  }

  const totalBlocked = snapshots.length;
  const familyPct = Object.fromEntries(
    Object.entries(byFamily).map(([k, v]) => [k, pct(v, totalBlocked)])
  ) as Record<BlockFamily, number>;

  const topReasons = Array.from(byBlockReason.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([reason, count]) => ({
      reason,
      count,
      pct: pct(count, totalBlocked),
    }));
  const topPortfolioFitReasons = Array.from(byPortfolioFitReason.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([reason, count]) => ({
      reason,
      count,
      pct: pct(count, totalBlocked),
    }));
  const topEligibilityBlockers = Array.from(byEligibilityBlocker.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([reason, count]) => ({
      reason,
      count,
      pct: pct(count, totalBlocked),
    }));
  const topMarketQualityReasons = Array.from(byMarketQualityReason.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([reason, count]) => ({
      reason,
      count,
      pct: pct(count, totalBlocked),
    }));

  const topMarkets = Array.from(byMarket.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([marketId, count]) => ({ marketId, count, pct: pct(count, totalBlocked) }));

  const topAssets = Array.from(byAsset.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([assetId, count]) => ({ assetId, count, pct: pct(count, totalBlocked) }));

  const report = {
    generatedAt: new Date().toISOString(),
    funderAddress: funder,
    totalRecommendationsForFunder: await prisma.recommendation.count({
      where: { marketSignal: { funderAddress: funder } },
    }),
    totalSnapshotsForFunder: await prisma.decisionPolicySnapshot.count({
      where: { funderAddress: funder },
    }),
    totalBlockedSnapshots: totalBlocked,
    blockFamilyCounts: byFamily,
    blockFamilyPct: familyPct,
    topBlockingReasons: topReasons,
    topPortfolioFitReasons,
    topEligibilityBlockers,
    topMarketQualityReasons,
    perMarketBlocked: topMarkets,
    perAssetBlocked: topAssets,
    sampleRows,
    notes: [
      "Classification is based on DecisionPolicySnapshot.reasoningJson text patterns.",
      "A snapshot may contain multiple reason strings; blockFamily reflects dominant matched family.",
    ],
  };

  const jsonPath = path.join(dumpDir, "policy-block-breakdown-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Policy block breakdown report");
  md.push("");
  md.push("| Metric | Value |");
  md.push("|--------|-------|");
  md.push(`| Funder | \`${funder}\` |`);
  md.push(`| Recommendations | ${report.totalRecommendationsForFunder} |`);
  md.push(`| Snapshots | ${report.totalSnapshotsForFunder} |`);
  md.push(`| Blocked snapshots | ${report.totalBlockedSnapshots} |`);
  md.push("");
  md.push("## Block family counts");
  md.push("");
  md.push("| Family | Count | % |");
  md.push("|--------|-------|---|");
  for (const f of Object.keys(byFamily) as BlockFamily[]) {
    md.push(`| ${f} | ${byFamily[f]} | ${familyPct[f].toFixed(2)}% |`);
  }
  md.push("");
  md.push("## Top blocking reasons");
  md.push("");
  md.push("| Reason | Count | % |");
  md.push("|--------|-------|---|");
  for (const r of topReasons) {
    md.push(`| ${r.reason} | ${r.count} | ${r.pct.toFixed(2)}% |`);
  }
  md.push("");
  md.push("## Top portfolio-fit reasons");
  md.push("");
  md.push("| Reason | Count | % of blocked snapshots |");
  md.push("|--------|-------|------------------------|");
  for (const r of topPortfolioFitReasons) {
    md.push(`| ${r.reason} | ${r.count} | ${r.pct.toFixed(2)}% |`);
  }
  md.push("");
  md.push("## Top eligibility blockers");
  md.push("");
  md.push("| Reason | Count | % of blocked snapshots |");
  md.push("|--------|-------|------------------------|");
  for (const r of topEligibilityBlockers) {
    md.push(`| ${r.reason} | ${r.count} | ${r.pct.toFixed(2)}% |`);
  }
  md.push("");
  md.push("## Top market-quality reasons");
  md.push("");
  md.push("| Reason | Count | % of blocked snapshots |");
  md.push("|--------|-------|------------------------|");
  for (const r of topMarketQualityReasons) {
    md.push(`| ${r.reason} | ${r.count} | ${r.pct.toFixed(2)}% |`);
  }
  md.push("");
  md.push("## Top blocked markets");
  md.push("");
  md.push("| marketId | Count | % |");
  md.push("|----------|-------|---|");
  for (const m of topMarkets) {
    md.push(`| ${m.marketId} | ${m.count} | ${m.pct.toFixed(2)}% |`);
  }
  md.push("");
  md.push("## Top blocked assets");
  md.push("");
  if (topAssets.length === 0) {
    md.push("No asset mapping rows found for blocked snapshots.");
  } else {
    md.push("| assetId | Count | % |");
    md.push("|---------|-------|---|");
    for (const a of topAssets) {
      md.push(`| ${a.assetId} | ${a.count} | ${a.pct.toFixed(2)}% |`);
    }
  }
  md.push("");
  md.push("## Sample blocked rows");
  md.push("");
  md.push("| recommendationId | marketId | outcome | family | blockReason |");
  md.push("|------------------|----------|---------|--------|-------------|");
  for (const s of sampleRows.slice(0, 12)) {
    md.push(
      `| ${s.recommendationId} | ${s.marketId} | ${s.outcome} | ${s.blockFamily} | ${s.blockReason ?? "—"} |`
    );
  }

  const mdPath = path.join(dumpDir, "policy-block-breakdown-report.md");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

