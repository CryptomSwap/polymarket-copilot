import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { normalizePreferredFunderForShadowLoad } from "../lib/paper-trading/candidates";

function parseDecisionSnapshot(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolvedMarketIdForShadowRow(r: {
  marketId: string | null;
  decisionSnapshotJson: string | null;
}): string | null {
  const col = r.marketId?.trim();
  if (col) return col;
  const d = parseDecisionSnapshot(r.decisionSnapshotJson);
  const mid = d && typeof d.marketId === "string" ? d.marketId.trim() : "";
  return mid || null;
}

function dedupeKeyMarketSide(marketId: string, side: string): string {
  return `${marketId}\0${side.toUpperCase() === "SELL" ? "SELL" : "BUY"}`;
}

type RowLite = {
  id: string;
  recommendationId: string | null;
  createdAt: Date;
  marketId: string | null;
  decisionSnapshotJson: string | null;
  side: string;
};

async function findTopSubmittedFunder(since: Date): Promise<string | null> {
  const groups = await prisma.shadowCandidate.groupBy({
    by: ["funderAddress"],
    where: {
      wasSubmitted: true,
      wasBlocked: false,
      candidateSource: "runtime_automated",
      createdAt: { gte: since },
    },
    _count: { id: true },
  });
  if (!groups.length) return null;
  groups.sort((a, b) => b._count.id - a._count.id);
  return groups[0]!.funderAddress.trim();
}

async function topFundersInLookback(
  since: Date,
  take: number
): Promise<{ funderAddress: string; count: number }[]> {
  const groups = await prisma.shadowCandidate.groupBy({
    by: ["funderAddress"],
    where: {
      wasSubmitted: true,
      wasBlocked: false,
      candidateSource: "runtime_automated",
      createdAt: { gte: since },
    },
    _count: { id: true },
  });
  groups.sort((a, b) => b._count.id - a._count.id);
  return groups.slice(0, take).map((g) => ({
    funderAddress: g.funderAddress.trim(),
    count: g._count.id,
  }));
}

function scopedFunderWhere(funder: string | null | undefined) {
  if (!funder?.trim()) return {};
  return { funderAddress: { equals: funder.trim(), mode: "insensitive" as const } };
}

function addrsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

function histogramAgeMinutes(agesMin: number[]): Record<string, number> {
  const h: Record<string, number> = {
    "<1 min": 0,
    "1–5 min": 0,
    "5–15 min": 0,
    "15–60 min": 0,
    ">60 min": 0,
  };
  for (const a of agesMin) {
    if (a < 1) h["<1 min"]++;
    else if (a < 5) h["1–5 min"]++;
    else if (a < 15) h["5–15 min"]++;
    else if (a < 60) h["15–60 min"]++;
    else h[">60 min"]++;
  }
  return h;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const now = Date.now();
  const config = getPaperTradingConfig();
  const lookbackMinutes = config.shadowLookbackMinutes;

  const envFunderRaw = process.env.SHADOW_AUDIT_FUNDER?.trim();
  const envFunder = normalizePreferredFunderForShadowLoad(envFunderRaw ?? null);
  const discoverSince = new Date(now - Math.max(lookbackMinutes, 720) * 60 * 1000);
  let funder =
    (envFunderRaw?.trim() ? envFunderRaw.trim() : null) ??
    envFunder ??
    (await findTopSubmittedFunder(discoverSince)) ??
    (await findTopSubmittedFunder(new Date(now - 24 * 60 * 60 * 1000)));

  const baseWhereAllFunders = {
    wasSubmitted: true,
    wasBlocked: false,
    candidateSource: "runtime_automated" as const,
  };

  const sinceLookback = new Date(now - lookbackMinutes * 60 * 1000);
  const ms = (m: number) => m * 60 * 1000;

  const windowSpecs = [
    { label: "last 1 min", ms: ms(1) },
    { label: "last 5 min", ms: ms(5) },
    { label: "last 15 min", ms: ms(15) },
    { label: "last 1 hour", ms: ms(60) },
  ];

  const ingestionGlobal: { label: string; count: number; ratePerMinute: number }[] = [];
  for (const w of windowSpecs) {
    const count = await prisma.shadowCandidate.count({
      where: { ...baseWhereAllFunders, createdAt: { gte: new Date(now - w.ms) } },
    });
    const minutes = w.ms / 60000;
    ingestionGlobal.push({ label: w.label, count, ratePerMinute: minutes > 0 ? count / minutes : count });
  }

  const funderNotes: string[] = [];
  const topInLb = await topFundersInLookback(sinceLookback, 8);

  let lookbackRows = await prisma.shadowCandidate.findMany({
    where: { ...baseWhereAllFunders, ...scopedFunderWhere(funder), createdAt: { gte: sinceLookback } },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      recommendationId: true,
      createdAt: true,
      marketId: true,
      decisionSnapshotJson: true,
      side: true,
    },
  });

  if (lookbackRows.length === 0 && topInLb.length > 0) {
    const alt = topInLb[0]!.funderAddress;
    if (!addrsEqual(alt, funder)) {
      funderNotes.push(
        `Primary funder \`${funder ?? "∅"}\` had 0 rows in the ${lookbackMinutes}m lookback; re-scoped analysis to busiest funder in window: \`${alt}\` (${topInLb[0]!.count} rows).`
      );
      funder = alt;
      lookbackRows = await prisma.shadowCandidate.findMany({
        where: { ...baseWhereAllFunders, ...scopedFunderWhere(funder), createdAt: { gte: sinceLookback } },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: {
          id: true,
          recommendationId: true,
          createdAt: true,
          marketId: true,
          decisionSnapshotJson: true,
          side: true,
        },
      });
    }
  }

  const ingestionCounts: { label: string; count: number; ratePerMinute: number }[] = [];
  for (const w of windowSpecs) {
    const count = await prisma.shadowCandidate.count({
      where: { ...baseWhereAllFunders, ...scopedFunderWhere(funder), createdAt: { gte: new Date(now - w.ms) } },
    });
    const minutes = w.ms / 60000;
    ingestionCounts.push({ label: w.label, count, ratePerMinute: minutes > 0 ? count / minutes : count });
  }

  const globalLookbackCount = await prisma.shadowCandidate.count({
    where: { ...baseWhereAllFunders, createdAt: { gte: sinceLookback } },
  });
  if (lookbackRows.length === 0 && globalLookbackCount > 0) {
    funderNotes.push(
      `Scoped funder had 0 rows in the ${lookbackMinutes}m window, but **${globalLookbackCount}** row(s) exist for **all funders** with the same filter — discovery funder may not match where telemetry is landing.`
    );
  }

  let globalLookbackSampleHist: Record<string, number> | null = null;
  if (lookbackRows.length === 0 && globalLookbackCount > 0) {
    const gRows = await prisma.shadowCandidate.findMany({
      where: { ...baseWhereAllFunders, createdAt: { gte: sinceLookback } },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { createdAt: true, funderAddress: true },
    });
    const agesG = gRows.map((r) => (now - r.createdAt.getTime()) / 60000);
    globalLookbackSampleHist = histogramAgeMinutes(agesG);
  }

  const rawInWindow = lookbackRows.length;
  const agesMinRaw = lookbackRows.map((r) => (now - r.createdAt.getTime()) / 60000);
  const ageHistRaw = histogramAgeMinutes(agesMinRaw);

  const seenKeys = new Set<string>();
  const dedupeDiag = { dropped: 0, skippedNoMarket: 0 };
  const winners: RowLite[] = [];
  for (const r of lookbackRows) {
    const mid = resolvedMarketIdForShadowRow(r);
    if (!mid) {
      dedupeDiag.skippedNoMarket++;
      continue;
    }
    const k = dedupeKeyMarketSide(mid, r.side);
    if (seenKeys.has(k)) {
      dedupeDiag.dropped++;
      continue;
    }
    seenKeys.add(k);
    winners.push({
      id: r.id,
      recommendationId: r.recommendationId,
      createdAt: r.createdAt,
      marketId: r.marketId,
      decisionSnapshotJson: r.decisionSnapshotJson,
      side: r.side,
    });
  }

  const dedupedCount = winners.length;
  const agesMinWinners = winners.map((w) => (now - w.createdAt.getTime()) / 60000);
  const ageHistWinners = histogramAgeMinutes(agesMinWinners);

  const newest10PctWindowStart = new Date(now - 0.1 * lookbackMinutes * 60 * 1000);
  const oldest50PctWindowEnd = new Date(now - 0.5 * lookbackMinutes * 60 * 1000);
  const inNewest10Time = winners.filter((w) => w.createdAt >= newest10PctWindowStart).length;
  const inOldest50Time = winners.filter((w) => w.createdAt <= oldest50PctWindowEnd).length;
  const pctNewest10 = dedupedCount ? (inNewest10Time / dedupedCount) * 100 : 0;
  const pctOldest50 = dedupedCount ? (inOldest50Time / dedupedCount) * 100 : 0;

  const recoGroups = new Map<string, RowLite[]>();
  for (const r of lookbackRows) {
    const rid = r.recommendationId?.trim() || `(null:${r.id})`;
    const arr = recoGroups.get(rid) ?? [];
    arr.push({
      id: r.id,
      recommendationId: r.recommendationId,
      createdAt: r.createdAt,
      marketId: r.marketId,
      decisionSnapshotJson: r.decisionSnapshotJson,
      side: r.side,
    });
    recoGroups.set(rid, arr);
  }
  let recoIdsMultiRow = 0;
  let extraRowsFromRecoCollapse = 0;
  for (const [, arr] of recoGroups) {
    if (arr.length > 1) {
      recoIdsMultiRow++;
      extraRowsFromRecoCollapse += arr.length - 1;
    }
  }
  const uniqueRecoIdsRaw = recoGroups.size;

  const winnerRecoSet = new Set(winners.map((w) => w.recommendationId?.trim() || `(null:${w.id})`));
  const rawRecoDistinct = new Set(
    lookbackRows.map((r) => r.recommendationId?.trim() || `(null:${r.id})`)
  ).size;

  let conclusion:
    | "ingestion rate too low"
    | "lookback window too large"
    | "dedupe collapsing new data"
    | "upstream generator not producing new candidates"
    | "evidence insufficient" = "evidence insufficient";

  const rate15 = ingestionCounts.find((x) => x.label === "last 15 min")?.ratePerMinute ?? 0;
  const rate1h = ingestionCounts.find((x) => x.label === "last 1 hour")?.ratePerMinute ?? 0;
  const dedupeRatio = dedupedCount > 0 ? rawInWindow / dedupedCount : 0;
  const droppedByMarketSide = dedupeDiag.dropped;

  const globalRate15 = ingestionGlobal.find((x) => x.label === "last 15 min")?.ratePerMinute ?? 0;
  const scopedRate15 = ingestionCounts.find((x) => x.label === "last 15 min")?.ratePerMinute ?? 0;

  if (!funder && rawInWindow === 0) {
    conclusion = "evidence insufficient";
  } else if (globalRate15 < 0.1 && ingestionGlobal.find((x) => x.label === "last 1 hour")!.count < 3) {
    conclusion = "upstream generator not producing new candidates";
  } else if (rawInWindow === 0 && topInLb.length === 0) {
    conclusion = "evidence insufficient";
  } else if (lookbackRows.length === 0 && globalLookbackCount > 0) {
    conclusion = "evidence insufficient";
  } else if (scopedRate15 < 0.15 && globalRate15 >= 0.5) {
    conclusion = "evidence insufficient";
  } else if (pctOldest50 >= 55 && lookbackMinutes >= 20 && dedupedCount >= 5) {
    conclusion = "lookback window too large";
  } else if (dedupeRatio >= 1.35 && droppedByMarketSide >= 8) {
    conclusion = "dedupe collapsing new data";
  } else if (scopedRate15 < 0.5 && globalRate15 < 0.5) {
    conclusion = "ingestion rate too low";
  } else if (rate15 < 0.15 && rate1h < 0.5 && lookbackMinutes >= 15) {
    conclusion = "upstream generator not producing new candidates";
  }

  const lines: string[] = [];
  lines.push("# V2 ShadowCandidate generation audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Loader-equivalent filter: wasSubmitted=true, wasBlocked=false, candidateSource=runtime_automated`);
  lines.push(
    funder
      ? `- Funder used for B–D (scoped): \`${funder}\` — set \`SHADOW_AUDIT_FUNDER\` to override discovery`
      : "- Funder scope: **none** — B–D use global pool if applicable"
  );
  if (funderNotes.length) for (const n of funderNotes) lines.push(`- ${n}`);
  lines.push(`- Config \`shadowLookbackMinutes\` (loader): **${lookbackMinutes}**`);
  lines.push("");

  lines.push("## A. Ingestion rate");
  lines.push("### A.1 All funders (loader filter, no funder constraint)");
  lines.push("| window | new rows | rate / minute |");
  lines.push("| --- | ---: | ---: |");
  for (const x of ingestionGlobal) {
    lines.push(`| ${x.label} | ${x.count} | ${x.ratePerMinute.toFixed(4)} |`);
  }
  lines.push("");
  lines.push("### A.2 Scoped funder (same as B–D)");
  lines.push("| window | new rows | rate / minute |");
  lines.push("| --- | ---: | ---: |");
  for (const x of ingestionCounts) {
    lines.push(`| ${x.label} | ${x.count} | ${x.ratePerMinute.toFixed(4)} |`);
  }
  lines.push("");
  lines.push("### Top funders by row count in current lookback window");
  lines.push("```json");
  lines.push(JSON.stringify(topInLb, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## B. Timestamp distribution (rows in loader lookback query, max 500, `createdAt` desc)");
  lines.push(
    `- rows in lookback matching filter **all funders**: **${globalLookbackCount}** (scoped raw: ${rawInWindow})`
  );
  if (globalLookbackSampleHist) {
    lines.push("- age histogram (**all-funders** sample when scoped slice empty):");
    lines.push("```json");
    lines.push(JSON.stringify(globalLookbackSampleHist, null, 2));
    lines.push("```");
  }
  lines.push(`- raw rows returned (scoped): ${rawInWindow}`);
  lines.push("- age of row at audit time (raw rows):");
  lines.push("```json");
  lines.push(JSON.stringify(ageHistRaw, null, 2));
  lines.push("```");
  lines.push("- age histogram for **deduped winners** (newest-first per marketId+side, skip rows without marketId):");
  lines.push("```json");
  lines.push(JSON.stringify(ageHistWinners, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## C. Lookback window effect");
  lines.push(`- lookback duration: **${lookbackMinutes} min**`);
  lines.push(
    `- “newest 10% of window” = createdAt ≥ now − ${(0.1 * lookbackMinutes).toFixed(2)} min: **${pctNewest10.toFixed(1)}%** of deduped pool (${inNewest10Time}/${dedupedCount})`
  );
  lines.push(
    `- “oldest 50% of window” = createdAt ≤ now − ${(0.5 * lookbackMinutes).toFixed(2)} min: **${pctOldest50.toFixed(1)}%** of deduped pool (${inOldest50Time}/${dedupedCount})`
  );
  lines.push(
    `- rows dropped by **marketId+side** dedupe (older / duplicate keys in the 500-row pull): **${dedupeDiag.dropped}** (extra raw rows not winning their key)`
  );
  lines.push(
    `- rows skipped (no resolvable marketId): **${dedupeDiag.skippedNoMarket}**`
  );
  lines.push("");

  lines.push("## D. Deduping effect");
  lines.push(`- raw rows in lookback slice: **${rawInWindow}**`);
  lines.push(`- deduped pool (unique marketId+side with winners): **${dedupedCount}**`);
  lines.push(`- raw / deduped ratio: **${dedupedCount ? (rawInWindow / dedupedCount).toFixed(3) : "n/a"}**`);
  lines.push(`- distinct \`recommendationId\` values in raw slice (nulls keyed as \`(null:id)\`): **${uniqueRecoIdsRaw}**`);
  lines.push(`- \`recommendationId\` groups with >1 row: **${recoIdsMultiRow}**; extra rows beyond first per id: **${extraRowsFromRecoCollapse}**`);
  lines.push(`- distinct reco ids on winning rows only: **${winnerRecoSet.size}** (vs ${rawRecoDistinct} in raw slice)`);
  lines.push("");

  lines.push("## E. Blunt conclusion");
  lines.push(`- **${conclusion}**`);
  lines.push("");
  lines.push("## JSON summary");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        generatedAt,
        funder,
        lookbackMinutes,
        ingestionGlobalAllFunders: ingestionGlobal,
        ingestionScopedFunder: ingestionCounts,
        topFundersInLookbackWindow: topInLb,
        funderNotes,
        globalLookbackCount,
        globalLookbackSampleHistogramWhenScopedEmpty: globalLookbackSampleHist,
        lookbackQueryRawRows: rawInWindow,
        ageHistogramRaw: ageHistRaw,
        dedupedPoolSize: dedupedCount,
        ageHistogramDedupedWinners: ageHistWinners,
        lookbackEffect: {
          pctDedupedInNewest10PctOfWindow: pctNewest10,
          pctDedupedInOldest50PctOfWindow: pctOldest50,
          droppedByMarketSideDedupe: dedupeDiag.dropped,
          skippedNoMarket: dedupeDiag.skippedNoMarket,
        },
        dedupe: {
          rawToDedupedRatio: dedupedCount ? rawInWindow / dedupedCount : null,
          recommendationIdGroupsWithMultipleRows: recoIdsMultiRow,
          extraRowsFromRecommendationIdDuplicates: extraRowsFromRecoCollapse,
          distinctRawRecommendationKeys: uniqueRecoIdsRaw,
          distinctRecommendationIdsOnWinners: winnerRecoSet.size,
        },
        conclusion,
      },
      null,
      2
    )
  );
  lines.push("```");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-shadow-candidate-generation-audit.md");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
