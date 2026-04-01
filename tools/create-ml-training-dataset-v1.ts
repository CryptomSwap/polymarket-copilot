/**
 * Build a compact ML training dataset (v1) from PaperTrade + ShadowCandidate.
 *
 * Output:
 * - dump/ml-training-dataset-v1.csv
 *
 * Notes:
 * - No LiveEvent dependency.
 * - One row per PaperTrade decision.
 * - Deterministic ordering for reproducibility.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

type Args = {
  days: number;
  includeOpen: boolean;
};

type ParsedMeta = {
  recommendationId: string | null;
};

type CsvRow = {
  decisionId: string;
  decisionAt: string;
  modelRunId: string;
  marketId: string;
  assetId: string;
  side: string;
  score: string;
  threshold: string;
  status: string;
  entryPrice: string;
  probabilityBand: string;
  intendedSize: string;
  botType: string;
  entryPriceBand: string;
  recommendationId: string;
  shadowCandidateId: string;
  candidateSource: string;
  wasBlocked: string;
  wasSubmitted: string;
  shadowOutcomeClassification: string;
  shadowMarkout6h: string;
  shadowMarkout24h: string;
  paperMarkout12h: string;
  paperPnlPct: string;
  numericReturn: string;
  labelGoodDecision: string;
  labelSource: string;
};

function parseArgs(argv: string[]): Args {
  let days = 120;
  let includeOpen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--days" || a === "-d") && argv[i + 1]) {
      days = Math.max(1, parseInt(argv[++i], 10) || 120);
      continue;
    }
    if (a === "--include-open") {
      includeOpen = true;
    }
  }
  return { days, includeOpen };
}

function parseNum(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseMetadataRecommendationId(metadataJson: string | null): ParsedMeta {
  if (!metadataJson) return { recommendationId: null };
  try {
    const obj = JSON.parse(metadataJson) as Record<string, unknown>;
    const direct = obj.recommendationId;
    if (typeof direct === "string" && direct.trim().length > 0) {
      return { recommendationId: direct.trim() };
    }
    const openAttr = obj.openAttribution as Record<string, unknown> | undefined;
    if (openAttr && typeof openAttr.recommendationId === "string" && openAttr.recommendationId.trim().length > 0) {
      return { recommendationId: openAttr.recommendationId.trim() };
    }
    return { recommendationId: null };
  } catch {
    return { recommendationId: null };
  }
}

function probabilityBand(entryPrice: string): string {
  const p = parseNum(entryPrice);
  if (p == null) return "unknown";
  if (p <= 0.2) return "low";
  if (p >= 0.8) return "high";
  return "mid";
}

function toCsvValue(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n") || v.includes("\r")) {
    return `"${v.replace(/"/g, "\"\"")}"`;
  }
  return v;
}

function toCsv(rows: CsvRow[]): string {
  const headers: Array<keyof CsvRow> = [
    "decisionId",
    "decisionAt",
    "modelRunId",
    "marketId",
    "assetId",
    "side",
    "score",
    "threshold",
    "status",
    "entryPrice",
    "probabilityBand",
    "intendedSize",
    "botType",
    "entryPriceBand",
    "recommendationId",
    "shadowCandidateId",
    "candidateSource",
    "wasBlocked",
    "wasSubmitted",
    "shadowOutcomeClassification",
    "shadowMarkout6h",
    "shadowMarkout24h",
    "paperMarkout12h",
    "paperPnlPct",
    "numericReturn",
    "labelGoodDecision",
    "labelSource",
  ];

  const lines: string[] = [];
  lines.push(headers.join(","));
  for (const r of rows) {
    lines.push(headers.map((h) => toCsvValue(r[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });
  const outCsv = path.join(dumpDir, "ml-training-dataset-v1.csv");

  const from = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);
  const paperTrades = await prisma.paperTrade.findMany({
    where: args.includeOpen
      ? { entryTime: { gte: from } }
      : { entryTime: { gte: from }, status: "closed" },
    orderBy: [{ entryTime: "asc" }, { id: "asc" }],
    select: {
      id: true,
      entryTime: true,
      modelRunId: true,
      marketId: true,
      assetId: true,
      side: true,
      score: true,
      threshold: true,
      status: true,
      entryPrice: true,
      intendedSize: true,
      botType: true,
      entryPriceBand: true,
      metadataJson: true,
      markout12h: true,
      pnlPct: true,
    },
  });

  const tradeMeta = paperTrades.map((t) => ({
    tradeId: t.id,
    entryTime: t.entryTime,
    assetId: t.assetId,
    side: t.side,
    recommendationId: parseMetadataRecommendationId(t.metadataJson).recommendationId,
  }));

  const recommendationIds = Array.from(
    new Set(
      tradeMeta
        .map((m) => m.recommendationId)
        .filter((x): x is string => x != null && x.length > 0)
    )
  );

  const shadowCandidates = await prisma.shadowCandidate.findMany({
    where: {
      OR: [
        { recommendationId: { in: recommendationIds.length > 0 ? recommendationIds : ["__none__"] } },
        { createdAt: { gte: from } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      recommendationId: true,
      assetId: true,
      side: true,
      candidateSource: true,
      wasBlocked: true,
      wasSubmitted: true,
      markout6h: true,
      markout24h: true,
      outcomeClassification: true,
      createdAt: true,
    },
    take: 300000,
  });

  const byRecAssetSide = new Map<string, typeof shadowCandidates>();
  const byAssetSide = new Map<string, typeof shadowCandidates>();
  for (const sc of shadowCandidates) {
    const aKey = `${sc.assetId}|${sc.side}`;
    const arrA = byAssetSide.get(aKey) ?? [];
    arrA.push(sc);
    byAssetSide.set(aKey, arrA);

    if (sc.recommendationId) {
      const key = `${sc.recommendationId}|${sc.assetId}|${sc.side}`;
      const arr = byRecAssetSide.get(key) ?? [];
      arr.push(sc);
      byRecAssetSide.set(key, arr);
    }
  }

  const rows: CsvRow[] = [];
  for (const t of paperTrades) {
    const meta = parseMetadataRecommendationId(t.metadataJson);
    const recId = meta.recommendationId;
    const key = recId ? `${recId}|${t.assetId}|${t.side}` : null;
    const candidates = (key ? byRecAssetSide.get(key) : undefined) ?? byAssetSide.get(`${t.assetId}|${t.side}`) ?? [];
    const sc = candidates.find((c) => c.createdAt.getTime() <= t.entryTime.getTime()) ?? candidates[0] ?? null;

    const paperReturn = parseNum(t.markout12h) ?? parseNum(t.pnlPct);
    const shadowReturn = parseNum(sc?.markout24h);
    let numericReturn: number | null = paperReturn ?? shadowReturn;
    let labelSource = paperReturn != null ? "paperTrade.markout12h_or_pnlPct" : shadowReturn != null ? "shadowCandidate.markout24h" : "none";

    let labelGoodDecision: boolean | null = null;
    if (numericReturn != null) {
      labelGoodDecision = numericReturn > 0;
    } else if (sc?.outcomeClassification) {
      const c = sc.outcomeClassification.toLowerCase();
      if (c.includes("good")) labelGoodDecision = true;
      else if (c.includes("bad") || c.includes("unsafe") || c.includes("missed")) labelGoodDecision = false;
      if (labelGoodDecision != null) labelSource = "shadowCandidate.outcomeClassification";
    }

    rows.push({
      decisionId: t.id,
      decisionAt: t.entryTime.toISOString(),
      modelRunId: t.modelRunId,
      marketId: t.marketId,
      assetId: t.assetId,
      side: t.side,
      score: String(t.score),
      threshold: String(t.threshold),
      status: t.status,
      entryPrice: t.entryPrice,
      probabilityBand: probabilityBand(t.entryPrice),
      intendedSize: t.intendedSize,
      botType: t.botType ?? "",
      entryPriceBand: t.entryPriceBand ?? "",
      recommendationId: recId ?? "",
      shadowCandidateId: sc?.id ?? "",
      candidateSource: sc?.candidateSource ?? "",
      wasBlocked: sc == null ? "" : String(sc.wasBlocked),
      wasSubmitted: sc == null ? "" : String(sc.wasSubmitted),
      shadowOutcomeClassification: sc?.outcomeClassification ?? "",
      shadowMarkout6h: sc?.markout6h ?? "",
      shadowMarkout24h: sc?.markout24h ?? "",
      paperMarkout12h: t.markout12h ?? "",
      paperPnlPct: t.pnlPct ?? "",
      numericReturn: numericReturn == null ? "" : String(numericReturn),
      labelGoodDecision: labelGoodDecision == null ? "" : String(labelGoodDecision),
      labelSource,
    });
  }

  await fs.writeFile(outCsv, toCsv(rows), "utf8");
  console.log(`Wrote ${outCsv}`);
  console.log(`Rows: ${rows.length}`);
  console.log(`Window start: ${from.toISOString()}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
