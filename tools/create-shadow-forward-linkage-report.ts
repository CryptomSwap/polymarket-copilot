/**
 * Shadow forward linkage report.
 * Traces Recommendation -> PaperTradingCandidate -> PaperTrade -> ShadowCandidate -> MlShadowTrainingExample (by recommendationId, assetId, side).
 * Read-only; verifies that new paper-linked examples can be joined to PaperTrade.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

function parseRecommendationId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const id = o.recommendationId;
    return typeof id === "string" ? id.trim() || null : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const lookbackDays = 30;
  const from = new Date();
  from.setDate(from.getDate() - lookbackDays);

  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });

  const paperTrades = await prisma.paperTrade.findMany({
    where: { entryTime: { gte: from } },
    select: {
      id: true,
      assetId: true,
      side: true,
      metadataJson: true,
      entryTime: true,
    },
    orderBy: { entryTime: "desc" },
    take: 500,
  });

  const tradesWithKey = paperTrades
    .map((t) => {
      const recId = parseRecommendationId(t.metadataJson);
      return recId
        ? {
            ...t,
            recommendationId: recId,
            key: `${recId}|${t.assetId}|${t.side}`,
          }
        : null;
    })
    .filter((t): t is { id: string; assetId: string; side: string; metadataJson: string | null; entryTime: Date; recommendationId: string; key: string } => t !== null);

  const keys = Array.from(new Set(tradesWithKey.map((t) => t.key)));

  const shadowCandidates =
    keys.length > 0
      ? await prisma.shadowCandidate.findMany({
          where: {
            recommendationId: { in: tradesWithKey.map((t) => t.recommendationId) },
          },
          select: {
            id: true,
            recommendationId: true,
            assetId: true,
            side: true,
            candidateSource: true,
            funderAddress: true,
          },
        })
      : [];

  const examples =
    keys.length > 0
      ? await prisma.mlShadowTrainingExample.findMany({
          where: {
            recommendationId: { in: tradesWithKey.map((t) => t.recommendationId) },
          },
          select: {
            id: true,
            recommendationId: true,
            assetId: true,
            side: true,
          },
        })
      : [];

  const scByKey = new Map<string, { id: string; recommendationId: string | null; assetId: string; side: string; candidateSource: string; funderAddress: string }[]>();
  for (const sc of shadowCandidates) {
    if (!sc.recommendationId) continue;
    const key = `${sc.recommendationId}|${sc.assetId}|${sc.side}`;
    const list = scByKey.get(key) ?? [];
    list.push(sc);
    scByKey.set(key, list);
  }

  const exByKey = new Map<string, { id: string; recommendationId: string | null; assetId: string; side: string }[]>();
  for (const ex of examples) {
    if (!ex.recommendationId) continue;
    const key = `${ex.recommendationId}|${ex.assetId}|${ex.side}`;
    const list = exByKey.get(key) ?? [];
    list.push(ex);
    exByKey.set(key, list);
  }

  let tradesWithShadowCandidate = 0;
  let tradesWithExample = 0;
  const brokenChains: Array<{
    paperTradeId: string;
    recommendationId: string;
    assetId: string;
    side: string;
    hasShadowCandidate: boolean;
    hasExample: boolean;
  }> = [];

  for (const t of tradesWithKey) {
    const scList = scByKey.get(t.key) ?? [];
    const exList = exByKey.get(t.key) ?? [];
    const hasSC = scList.length > 0;
    const hasEx = exList.length > 0;
    if (hasSC) tradesWithShadowCandidate++;
    if (hasEx) tradesWithExample++;
    if (!hasSC || !hasEx) {
      if (brokenChains.length < 30) {
        brokenChains.push({
          paperTradeId: t.id,
          recommendationId: t.recommendationId,
          assetId: t.assetId,
          side: t.side,
          hasShadowCandidate: hasSC,
          hasExample: hasEx,
        });
      }
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    paperTrade: {
      totalRecent: paperTrades.length,
      withRecommendationId: tradesWithKey.length,
    },
    shadowCandidate: {
      totalLinkedCandidates: shadowCandidates.length,
      distinctKeys: scByKey.size,
      tradesWithShadowCandidate,
    },
    mlShadowTrainingExample: {
      totalLinkedExamples: examples.length,
      distinctKeys: exByKey.size,
      tradesWithExample,
    },
    chain: {
      fullyLinkedTrades: tradesWithKey.filter((t) => (scByKey.get(t.key)?.length ?? 0) > 0 && (exByKey.get(t.key)?.length ?? 0) > 0).length,
      brokenTrades: brokenChains.length,
    },
    brokenChains,
  };

  const jsonPath = path.join(dumpDir, "shadow-forward-linkage-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const lines: string[] = [];
  lines.push("# Shadow forward linkage report");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push("| Recent PaperTrades (lookback) | " + result.paperTrade.totalRecent + " |");
  lines.push("| With recommendationId | " + result.paperTrade.withRecommendationId + " |");
  lines.push("| Linked ShadowCandidates (any) | " + result.shadowCandidate.totalLinkedCandidates + " |");
  lines.push("| Trades with at least one ShadowCandidate | " + result.shadowCandidate.tradesWithShadowCandidate + " |");
  lines.push("| Linked MlShadowTrainingExamples (any) | " + result.mlShadowTrainingExample.totalLinkedExamples + " |");
  lines.push("| Trades with at least one MlShadowTrainingExample | " + result.mlShadowTrainingExample.tradesWithExample + " |");
  lines.push("| Fully linked trades (PT + SC + example) | " + result.chain.fullyLinkedTrades + " |");
  lines.push("| Broken trades (missing SC or example) | " + result.chain.brokenTrades + " |");
  lines.push("");
  lines.push("## Sample broken chains");
  lines.push("");
  if (result.brokenChains.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| PaperTrade id | recommendationId | assetId | side | hasShadowCandidate | hasExample |");
    lines.push("|---------------|------------------|--------|------|---------------------|------------|");
    for (const b of result.brokenChains) {
      lines.push(
        "| " +
          b.paperTradeId.slice(0, 12) +
          " | " +
          b.recommendationId.slice(0, 12) +
          " | " +
          b.assetId.slice(0, 12) +
          " | " +
          b.side +
          " | " +
          (b.hasShadowCandidate ? "yes" : "no") +
          " | " +
          (b.hasExample ? "yes" : "no") +
          " |"
      );
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*Join key: (recommendationId, assetId, side). offline-historical examples are expected to have recommendationId = null.*");

  const mdPath = path.join(dumpDir, "shadow-forward-linkage-report.md");
  await fs.writeFile(mdPath, lines.join("\n"), "utf8");
  console.log("Wrote", mdPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

