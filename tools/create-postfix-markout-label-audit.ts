/**
 * Post-fix 12h markout/label audit on joined paper<->ML cohort (read-only).
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizeShadowSideForJoin } from "../lib/shadow-telemetry";
import { getSnapshotPriceAtOrBefore } from "../lib/polymarket/market-price-snapshot-lookup";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "postfix-markout-label-audit.json");
const OUT_MD = path.join(DUMP_DIR, "postfix-markout-label-audit.md");
const OUT_CHAT = path.join(DUMP_DIR, "postfix-markout-label-audit-chat-summary.md");

const AFTER_RAW = process.env.POSTFIX_LINKAGE_AFTER?.trim();
const PAPER_N = Math.min(
  3000,
  Math.max(20, Number(process.env.POSTFIX_MARKOUT_AUDIT_PAPER_N ?? "200") || 200)
);
const ML_N = Math.min(
  20000,
  Math.max(100, Number(process.env.POSTFIX_MARKOUT_AUDIT_ML_N ?? "1000") || 1000)
);

function parseRecommendationId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const id = o.recommendationId;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function distribution(values: number[]) {
  const s = [...values].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return {
    n: s.length,
    min: s.length ? s[0]! : null,
    p10: quantile(s, 0.1),
    p25: quantile(s, 0.25),
    p50: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    p90: quantile(s, 0.9),
    max: s.length ? s[s.length - 1]! : null,
  };
}

function markoutBucket(x: number): string {
  if (x <= -0.1) return "<= -10%";
  if (x <= -0.05) return "-10% to -5%";
  if (x <= 0) return "-5% to 0%";
  if (x <= 0.05) return "0% to 5%";
  if (x <= 0.1) return "5% to 10%";
  return "> 10%";
}

type Joined = {
  paperTradeId: string;
  entryTime: Date;
  recommendationId: string;
  botType: string;
  assetId: string;
  side: string;
  wasBlocked: boolean;
  marketId: string | null;
  markout12h: number | null;
  labelGoodDecision12h: boolean | null;
  mlCreatedAt: Date;
  mlUpdatedAt: Date;
};

async function main(): Promise<void> {
  if (!AFTER_RAW) {
    console.error("POSTFIX_LINKAGE_AFTER is required.");
    process.exit(1);
  }
  const cutoff = new Date(AFTER_RAW);
  if (Number.isNaN(cutoff.getTime())) {
    console.error("POSTFIX_LINKAGE_AFTER invalid ISO date:", AFTER_RAW);
    process.exit(1);
  }
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const paperRows = await prisma.paperTrade.findMany({
    where: { entryTime: { gte: cutoff } },
    orderBy: { entryTime: "desc" },
    take: PAPER_N,
    select: {
      id: true,
      entryTime: true,
      metadataJson: true,
      assetId: true,
      side: true,
      botType: true,
    },
  });

  const mlRows = await prisma.mlShadowTrainingExample.findMany({
    where: { createdAt: { gte: cutoff } },
    orderBy: { updatedAt: "desc" },
    take: ML_N,
    select: {
      id: true,
      recommendationId: true,
      assetId: true,
      side: true,
      marketId: true,
      wasBlocked: true,
      markout12h: true,
      labelGoodDecision12h: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const byTriple = new Map<string, typeof mlRows>();
  for (const m of mlRows) {
    const rec = m.recommendationId?.trim();
    if (!rec) continue;
    const key = `${rec}|${m.assetId}|${normalizeShadowSideForJoin(m.side)}`;
    const arr = byTriple.get(key) ?? [];
    arr.push(m);
    byTriple.set(key, arr);
  }
  for (const arr of byTriple.values()) {
    arr.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  const joined: Joined[] = [];
  for (const p of paperRows) {
    const rec = parseRecommendationId(p.metadataJson);
    if (!rec) continue;
    const key = `${rec}|${p.assetId}|${normalizeShadowSideForJoin(p.side)}`;
    const hits = byTriple.get(key) ?? [];
    if (hits.length === 0) continue;
    const pick = hits.find((h) => h.labelGoodDecision12h !== null) ?? hits[0]!;
    const m12n = pick.markout12h == null ? null : Number(pick.markout12h);
    joined.push({
      paperTradeId: p.id,
      entryTime: p.entryTime,
      recommendationId: rec,
      botType: p.botType,
      assetId: p.assetId,
      side: normalizeShadowSideForJoin(p.side),
      wasBlocked: pick.wasBlocked,
      marketId: pick.marketId,
      markout12h: Number.isFinite(m12n) ? m12n : null,
      labelGoodDecision12h: pick.labelGoodDecision12h,
      mlCreatedAt: pick.createdAt,
      mlUpdatedAt: pick.updatedAt,
    });
  }

  const nonNullMarkouts = joined
    .map((j) => j.markout12h)
    .filter((x): x is number => x != null && Number.isFinite(x));

  const hist = {
    "<= -10%": 0,
    "-10% to -5%": 0,
    "-5% to 0%": 0,
    "0% to 5%": 0,
    "5% to 10%": 0,
    "> 10%": 0,
  };
  for (const x of nonNullMarkouts) hist[markoutBucket(x) as keyof typeof hist]++;

  const labelCounts = {
    positive: joined.filter((j) => j.labelGoodDecision12h === true).length,
    negative: joined.filter((j) => j.labelGoodDecision12h === false).length,
    null: joined.filter((j) => j.labelGoodDecision12h == null).length,
  };
  const blockedCounts = {
    blockedTrue: joined.filter((j) => j.wasBlocked).length,
    blockedFalse: joined.filter((j) => !j.wasBlocked).length,
  };

  const labelByBlocked = {
    wasBlockedTrue: {
      positive: joined.filter((j) => j.wasBlocked && j.labelGoodDecision12h === true).length,
      negative: joined.filter((j) => j.wasBlocked && j.labelGoodDecision12h === false).length,
      null: joined.filter((j) => j.wasBlocked && j.labelGoodDecision12h == null).length,
    },
    wasBlockedFalse: {
      positive: joined.filter((j) => !j.wasBlocked && j.labelGoodDecision12h === true).length,
      negative: joined.filter((j) => !j.wasBlocked && j.labelGoodDecision12h === false).length,
      null: joined.filter((j) => !j.wasBlocked && j.labelGoodDecision12h == null).length,
    },
  };

  // Dominant false-label source decomposition.
  const falseRows = joined.filter((j) => j.labelGoodDecision12h === false);
  const falseReasons = {
    wasBlockedFalse_and_negativeOrZeroMarkout: falseRows.filter(
      (j) => !j.wasBlocked && j.markout12h != null && j.markout12h <= 0
    ).length,
    wasBlockedTrue_and_positiveMarkout: falseRows.filter(
      (j) => j.wasBlocked && j.markout12h != null && j.markout12h > 0
    ).length,
    nullMarkout_or_other: falseRows.filter(
      (j) =>
        j.markout12h == null ||
        (!j.wasBlocked && j.markout12h > 0) ||
        (j.wasBlocked && j.markout12h <= 0)
    ).length,
  };

  // Snapshot integrity hints.
  let price0Missing = 0;
  let price12hMissing = 0;
  let nullDueToMissingPrices = 0;
  let sourceHeuristicExistingRow = 0;
  let sourceHeuristicNewlyDerived = 0;
  const hourCluster: Record<string, number> = {};
  const botCluster: Record<string, number> = {};

  for (const j of joined) {
    const hour = j.entryTime.toISOString().slice(0, 13) + ":00Z";
    hourCluster[hour] = (hourCluster[hour] ?? 0) + 1;
    botCluster[j.botType] = (botCluster[j.botType] ?? 0) + 1;

    if (!j.marketId) {
      if (j.markout12h == null) nullDueToMissingPrices++;
      continue;
    }
    const price0 = await getSnapshotPriceAtOrBefore(j.marketId, j.assetId, j.mlCreatedAt);
    const at12 = new Date(j.mlCreatedAt.getTime() + 12 * 60 * 60 * 1000);
    const price12 = await getSnapshotPriceAtOrBefore(j.marketId, j.assetId, at12);
    if (price0 == null) price0Missing++;
    if (price12 == null) price12hMissing++;
    if (j.markout12h == null && (price0 == null || price12 == null)) nullDueToMissingPrices++;

    // Heuristic only (exact source not stored in schema/history):
    if (j.markout12h != null) {
      if (j.mlUpdatedAt.getTime() > j.mlCreatedAt.getTime() + 60_000) {
        sourceHeuristicExistingRow++;
      } else {
        sourceHeuristicNewlyDerived++;
      }
    }
  }

  const perBot = ["strict_quality", "relaxed_edge", "tail_extremes"].map((bot) => {
    const rows = joined.filter((j) => j.botType === bot);
    const m = rows.map((r) => r.markout12h).filter((x): x is number => x != null && Number.isFinite(x));
    const s = [...m].sort((a, b) => a - b);
    return {
      botType: bot,
      joinedN: rows.length,
      nonNullMarkoutN: m.length,
      meanMarkout12h: m.length ? m.reduce((a, c) => a + c, 0) / m.length : null,
      medianMarkout12h: m.length ? quantile(s, 0.5) : null,
      positiveMarkoutRate: m.length ? m.filter((x) => x > 0).length / m.length : null,
      labelTrueRate: rows.length ? rows.filter((r) => r.labelGoodDecision12h === true).length / rows.length : null,
    };
  });

  const strongestNeg = [...joined]
    .filter((j) => j.markout12h != null)
    .sort((a, b) => (a.markout12h ?? 0) - (b.markout12h ?? 0))
    .slice(0, 5);
  const nearZero = [...joined]
    .filter((j) => j.markout12h != null && Math.abs(j.markout12h) <= 0.01)
    .slice(0, 5);
  const positive = [...joined]
    .filter((j) => j.markout12h != null && j.markout12h > 0)
    .sort((a, b) => (b.markout12h ?? 0) - (a.markout12h ?? 0))
    .slice(0, 5);

  const sampleRows = [...strongestNeg, ...nearZero, ...positive].map((j) => ({
    paperTradeId: j.paperTradeId,
    recommendationId: j.recommendationId,
    assetId: j.assetId,
    side: j.side,
    wasBlocked: j.wasBlocked,
    markout12h: j.markout12h,
    labelGoodDecision12h: j.labelGoodDecision12h,
    entryTime: j.entryTime.toISOString(),
  }));

  const joinedN = joined.length;
  const positiveMarkoutRate = nonNullMarkouts.length
    ? nonNullMarkouts.filter((x) => x > 0).length / nonNullMarkouts.length
    : 0;
  const positiveLabelRate = joinedN
    ? joined.filter((j) => j.labelGoodDecision12h === true).length / joinedN
    : 0;

  const dominantFalseReason = Object.entries(falseReasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
  const sampleTooSmall = joinedN < 50 || nonNullMarkouts.length < 40;
  const outcomesActuallyNegative = positiveMarkoutRate < 0.35 && nonNullMarkouts.length > 0;
  const snapshotBiasSuspected =
    (nullDueToMissingPrices > 0 && nullDueToMissingPrices / Math.max(joinedN, 1) > 0.2) ||
    (price12hMissing > price0Missing * 1.5 && price12hMissing > 10);
  const labelLogicSeemsCorrect = !snapshotBiasSuspected && falseReasons.wasBlockedFalse_and_negativeOrZeroMarkout >= falseReasons.wasBlockedTrue_and_positiveMarkout;

  const recommendedNextMove = sampleTooSmall
    ? "collect more data"
    : snapshotBiasSuspected
      ? "inspect snapshot construction"
      : outcomesActuallyNegative
        ? "proceed to recalibration later"
        : "adjust horizon later";

  const report = {
    generatedAt: new Date().toISOString(),
    sectionA_scope: {
      cutoffUsed: cutoff.toISOString(),
      joinedCohortSize: joinedN,
      countWithNonNullMarkout12h: nonNullMarkouts.length,
      countWithNullMarkout12h: joinedN - nonNullMarkouts.length,
      countWasBlockedTrue: blockedCounts.blockedTrue,
      countWasBlockedFalse: blockedCounts.blockedFalse,
    },
    sectionB_markoutDistribution: {
      distribution: distribution(nonNullMarkouts),
      histogram: hist,
    },
    sectionC_labelBreakdown: {
      overall: labelCounts,
      byWasBlocked: labelByBlocked,
      falseLabelDominantSourceBreakdown: falseReasons,
    },
    sectionD_perBotMarkoutQuality: perBot,
    sectionE_snapshotIntegrityHints: {
      countPrice0Missing: price0Missing,
      countPrice12hMissing: price12hMissing,
      countMarkout12hNullBecauseOfMissingPrices: nullDueToMissingPrices,
      countMarkoutSourceHeuristicExistingRow: sourceHeuristicExistingRow,
      countMarkoutSourceHeuristicNewlyDerived: sourceHeuristicNewlyDerived,
      sourceHeuristicNote:
        "Exact existing-vs-newly-derived source is not stored; heuristic uses updatedAt significantly after createdAt as likely updated-existing-row path.",
      clusteringHints: {
        topEntryHourClusters: Object.entries(hourCluster)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8),
        byBot: botCluster,
      },
    },
    sectionF_exampleRows: sampleRows,
    sectionG_interpretation: {
      labelLogicSeemsCorrect,
      sampleTooSmall,
      outcomesActuallyNegative,
      snapshotBiasSuspected,
      recommendedNextMove,
    },
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Post-fix markout/label audit",
    "",
    `Cutoff: \`${report.sectionA_scope.cutoffUsed}\``,
    `Joined cohort: **${joinedN}**`,
    `Non-null markout12h: **${nonNullMarkouts.length}**`,
    "",
    "## Markout quality",
    `- Positive markout rate: **${(100 * positiveMarkoutRate).toFixed(1)}%**`,
    `- Positive label rate: **${(100 * positiveLabelRate).toFixed(1)}%**`,
    `- Dominant false-label reason: **${dominantFalseReason}**`,
    "",
    "## Interpretation",
    `- labelLogicSeemsCorrect: **${labelLogicSeemsCorrect}**`,
    `- sampleTooSmall: **${sampleTooSmall}**`,
    `- outcomesActuallyNegative: **${outcomesActuallyNegative}**`,
    `- snapshotBiasSuspected: **${snapshotBiasSuspected}**`,
    `- recommendedNextMove: **${recommendedNextMove}**`,
    "",
    `JSON: \`${OUT_JSON}\``,
  ].join("\n");
  await fs.writeFile(OUT_MD, md, "utf8");

  const chat = [
    "## Post-fix markout/label audit",
    `- joined rows: **${joinedN}**`,
    `- positive markout rate: **${(100 * positiveMarkoutRate).toFixed(1)}%**`,
    `- positive label rate: **${(100 * positiveLabelRate).toFixed(1)}%**`,
    `- dominant false-label reason: **${dominantFalseReason}**`,
    `- recommendation: **${recommendedNextMove}**`,
    `- files: \`dump/postfix-markout-label-audit.{json,md,-chat-summary.md}\``,
  ].join("\n");
  await fs.writeFile(OUT_CHAT, chat, "utf8");

  console.log("[postfix-markout-label-audit]", {
    joinedRows: joinedN,
    positiveMarkoutRate,
    positiveLabelRate,
    dominantReasonForFalseLabels: dominantFalseReason,
    topRecommendation: recommendedNextMove,
    outputs: [OUT_JSON, OUT_MD, OUT_CHAT],
  });
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

