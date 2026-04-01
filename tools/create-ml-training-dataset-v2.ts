/**
 * Build ML training dataset v2 focused on decision quality.
 *
 * Outputs:
 * - dump/ml-training-dataset-v2.csv
 * - dump/ml-training-dataset-v2-diagnostics.json
 * - dump/ml-training-dataset-v2-diagnostics.md
 *
 * Key design:
 * - Label uses PaperTrade.markout12h ONLY (no shadow markout in label).
 * - ShadowCandidate fields are feature-only.
 * - Strict join mode (default): recommendationId+assetId+side with time guard.
 * - Deterministic ordering and deterministic diagnostics.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

type Args = {
  days: number;
  includeOpen: boolean;
  strictJoin: boolean;
  maxJoinLagMinutes: number;
  highConfidenceTopPct: number;
};

type ParsedPaperMeta = {
  recommendationId: string | null;
  strategyFamily: string | null;
  spreadBps: number | null;
  estimatedSlippageBps: number | null;
};

type ShadowExecQuality = {
  spreadBps: number | null;
  estimatedSlippageBps: number | null;
};

type CsvRow = {
  decisionId: string;
  decisionAt: string;
  modelRunId: string;
  marketId: string;
  assetId: string;
  side: string;
  status: string;
  botType: string;
  strategyFamily: string;
  score: string;
  threshold: string;
  scoreThresholdGap: string;
  entryPrice: string;
  probabilityBand: string;
  entryPriceBand: string;
  intendedSize: string;
  timeSinceLastTradeSeconds: string;
  recommendationId: string;
  joinConfidence: string;
  joinMethod: string;
  shadowCandidateId: string;
  candidateSource: string;
  wasBlocked: string;
  wasSubmitted: string;
  spreadBps: string;
  estimatedSlippageBps: string;
  shadowOutcomeClassification: string;
  shadowMarkout6h: string;
  shadowMarkout24h: string;
  paperMarkout12h: string;
  numericReturn12h: string;
  labelGoodDecision12h: string;
  returnBucket: string;
  highConfidenceGood: string;
  groupBotType: string;
  groupProbabilityBand: string;
  groupEntryPriceBand: string;
  scoreBucket: string;
};

type DiagnosticsBucket = {
  key: string;
  nRows: number;
  nWithReturn: number;
  meanReturn12h: number | null;
  hitRate: number | null;
};

function parseArgs(argv: string[]): Args {
  let days = 120;
  let includeOpen = false;
  let strictJoin = true;
  let maxJoinLagMinutes = 60;
  let highConfidenceTopPct = 10;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--days" || a === "-d") && argv[i + 1]) {
      days = Math.max(1, parseInt(argv[++i], 10) || 120);
      continue;
    }
    if (a === "--include-open") {
      includeOpen = true;
      continue;
    }
    if (a === "--allow-fallback-join") {
      strictJoin = false;
      continue;
    }
    if (a === "--strict-join") {
      strictJoin = true;
      continue;
    }
    if (a === "--max-join-lag-minutes" && argv[i + 1]) {
      maxJoinLagMinutes = Math.max(1, parseInt(argv[++i], 10) || 60);
      continue;
    }
    if (a === "--high-confidence-top-pct" && argv[i + 1]) {
      highConfidenceTopPct = Math.min(50, Math.max(1, Number(argv[++i]) || 10));
      continue;
    }
  }

  return { days, includeOpen, strictJoin, maxJoinLagMinutes, highConfidenceTopPct };
}

function parseNum(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toFixedOrEmpty(v: number | null, digits = 8): string {
  if (v == null || !Number.isFinite(v)) return "";
  return v.toFixed(digits);
}

function probabilityBand(entryPrice: string): string {
  const p = parseNum(entryPrice);
  if (p == null) return "unknown";
  if (p <= 0.2) return "low";
  if (p >= 0.8) return "high";
  return "mid";
}

function scoreBucket(score: number): string {
  if (score < 0.2) return "[0.00,0.20)";
  if (score < 0.4) return "[0.20,0.40)";
  if (score < 0.6) return "[0.40,0.60)";
  if (score < 0.8) return "[0.60,0.80)";
  return "[0.80,1.00]";
}

function returnBucket(ret: number | null): string {
  if (ret == null) return "unknown";
  if (ret > 0.001) return "positive";
  if (ret < -0.001) return "negative";
  return "neutral";
}

function toCsvValue(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n") || v.includes("\r")) {
    return `"${v.replace(/"/g, "\"\"")}"`;
  }
  return v;
}

function parseShadowExecQuality(raw: string | null): ShadowExecQuality {
  if (!raw) return { spreadBps: null, estimatedSlippageBps: null };
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      spreadBps: parseNum(String(j.spreadBps ?? "")),
      estimatedSlippageBps: parseNum(String(j.estimatedSlippageBps ?? "")),
    };
  } catch {
    return { spreadBps: null, estimatedSlippageBps: null };
  }
}

function parsePaperMeta(raw: string | null): ParsedPaperMeta {
  if (!raw) {
    return {
      recommendationId: null,
      strategyFamily: null,
      spreadBps: null,
      estimatedSlippageBps: null,
    };
  }
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    const openAttr = (m.openAttribution ?? {}) as Record<string, unknown>;
    const execCtx = (openAttr.executionContext ?? {}) as Record<string, unknown>;
    return {
      recommendationId:
        typeof m.recommendationId === "string"
          ? m.recommendationId
          : typeof openAttr.recommendationId === "string"
            ? openAttr.recommendationId
            : null,
      strategyFamily:
        typeof m.strategyFamily === "string"
          ? m.strategyFamily
          : typeof openAttr.strategyFamily === "string"
            ? openAttr.strategyFamily
            : null,
      spreadBps:
        parseNum(String(m.spreadBps ?? "")) ??
        parseNum(String((m.roiInput as Record<string, unknown> | undefined)?.spreadBpsAtAdmission ?? "")) ??
        parseNum(String(execCtx.spreadBps ?? "")),
      estimatedSlippageBps:
        parseNum(String(m.estimatedSlippageBps ?? "")) ??
        parseNum(String((m.roiInput as Record<string, unknown> | undefined)?.estimatedSlippageBpsAtAdmission ?? "")) ??
        parseNum(String(execCtx.estimatedSlippageBps ?? "")),
    };
  } catch {
    return {
      recommendationId: null,
      strategyFamily: null,
      spreadBps: null,
      estimatedSlippageBps: null,
    };
  }
}

function percentileCut(values: number[], topPct: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q = 1 - topPct / 100;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))));
  return sorted[idx] ?? null;
}

function buildBucketDiagnostics(rows: CsvRow[], keyOf: (r: CsvRow) => string): DiagnosticsBucket[] {
  const grouped = new Map<string, number[]>();
  const countAll = new Map<string, number>();

  for (const r of rows) {
    const k = keyOf(r);
    countAll.set(k, (countAll.get(k) ?? 0) + 1);
    const v = parseNum(r.numericReturn12h);
    if (v != null) {
      const arr = grouped.get(k) ?? [];
      arr.push(v);
      grouped.set(k, arr);
    }
  }

  return [...countAll.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((k) => {
      const vals = grouped.get(k) ?? [];
      const n = vals.length;
      const sum = vals.reduce((acc, x) => acc + x, 0);
      const wins = vals.filter((x) => x > 0).length;
      return {
        key: k,
        nRows: countAll.get(k) ?? 0,
        nWithReturn: n,
        meanReturn12h: n > 0 ? sum / n : null,
        hitRate: n > 0 ? wins / n : null,
      };
    });
}

function toCsv(rows: CsvRow[]): string {
  const headers: Array<keyof CsvRow> = [
    "decisionId",
    "decisionAt",
    "modelRunId",
    "marketId",
    "assetId",
    "side",
    "status",
    "botType",
    "strategyFamily",
    "score",
    "threshold",
    "scoreThresholdGap",
    "entryPrice",
    "probabilityBand",
    "entryPriceBand",
    "intendedSize",
    "timeSinceLastTradeSeconds",
    "recommendationId",
    "joinConfidence",
    "joinMethod",
    "shadowCandidateId",
    "candidateSource",
    "wasBlocked",
    "wasSubmitted",
    "spreadBps",
    "estimatedSlippageBps",
    "shadowOutcomeClassification",
    "shadowMarkout6h",
    "shadowMarkout24h",
    "paperMarkout12h",
    "numericReturn12h",
    "labelGoodDecision12h",
    "returnBucket",
    "highConfidenceGood",
    "groupBotType",
    "groupProbabilityBand",
    "groupEntryPriceBand",
    "scoreBucket",
  ];

  const out: string[] = [headers.join(",")];
  for (const row of rows) {
    out.push(headers.map((h) => toCsvValue(row[h])).join(","));
  }
  return out.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });
  const outCsvPath = path.join(dumpDir, "ml-training-dataset-v2.csv");
  const outJsonPath = path.join(dumpDir, "ml-training-dataset-v2-diagnostics.json");
  const outMdPath = path.join(dumpDir, "ml-training-dataset-v2-diagnostics.md");

  const from = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);
  const maxJoinLagMs = args.maxJoinLagMinutes * 60 * 1000;

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
    },
  });

  const recIds = Array.from(
    new Set(
      paperTrades
        .map((t) => parsePaperMeta(t.metadataJson).recommendationId)
        .filter((x): x is string => !!x && x.trim().length > 0)
    )
  );

  const shadowRows = await prisma.shadowCandidate.findMany({
    where: {
      OR: [
        { recommendationId: { in: recIds.length > 0 ? recIds : ["__none__"] } },
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
      outcomeClassification: true,
      markout6h: true,
      markout24h: true,
      executionQualitySnapshotJson: true,
      createdAt: true,
    },
    take: 300000,
  });

  const byRecAssetSide = new Map<string, typeof shadowRows>();
  const byAssetSide = new Map<string, typeof shadowRows>();
  for (const s of shadowRows) {
    const kAsset = `${s.assetId}|${s.side}`;
    const a = byAssetSide.get(kAsset) ?? [];
    a.push(s);
    byAssetSide.set(kAsset, a);
    if (s.recommendationId) {
      const k = `${s.recommendationId}|${s.assetId}|${s.side}`;
      const b = byRecAssetSide.get(k) ?? [];
      b.push(s);
      byRecAssetSide.set(k, b);
    }
  }

  const rowsDraft: CsvRow[] = [];
  const lastTradeByBot = new Map<string, Date>();

  for (const t of paperTrades) {
    const meta = parsePaperMeta(t.metadataJson);
    const recId = meta.recommendationId;
    const strictKey = recId ? `${recId}|${t.assetId}|${t.side}` : null;
    const strictCandidates = strictKey ? byRecAssetSide.get(strictKey) ?? [] : [];

    let chosen =
      strictCandidates.find((c) => {
        const dt = t.entryTime.getTime() - c.createdAt.getTime();
        return dt >= 0 && dt <= maxJoinLagMs;
      }) ?? null;

    let joinMethod = "none";
    let joinConfidence = "none";

    if (chosen) {
      joinMethod = "rec_asset_side_time_window";
      joinConfidence = "high";
    } else if (!args.strictJoin) {
      const fallback = (byAssetSide.get(`${t.assetId}|${t.side}`) ?? []).find((c) => c.createdAt <= t.entryTime) ?? null;
      if (fallback) {
        chosen = fallback;
        joinMethod = "asset_side_fallback";
        joinConfidence = "low";
      }
    }

    if (args.strictJoin && joinConfidence !== "high") {
      continue;
    }

    const paperMarkout12h = parseNum(t.markout12h);
    const labelGoodDecision12h = paperMarkout12h == null ? null : paperMarkout12h > 0;
    const eqShadow = parseShadowExecQuality(chosen?.executionQualitySnapshotJson ?? null);
    const spreadBps = meta.spreadBps ?? eqShadow.spreadBps;
    const estimatedSlippageBps = meta.estimatedSlippageBps ?? eqShadow.estimatedSlippageBps;
    const gap = t.score - t.threshold;
    const bucket = scoreBucket(t.score);

    const prev = lastTradeByBot.get(t.botType ?? "");
    const sinceSec = prev ? Math.max(0, Math.floor((t.entryTime.getTime() - prev.getTime()) / 1000)) : null;
    lastTradeByBot.set(t.botType ?? "", t.entryTime);

    rowsDraft.push({
      decisionId: t.id,
      decisionAt: t.entryTime.toISOString(),
      modelRunId: t.modelRunId,
      marketId: t.marketId,
      assetId: t.assetId,
      side: t.side,
      status: t.status,
      botType: t.botType ?? "",
      strategyFamily: meta.strategyFamily ?? "",
      score: String(t.score),
      threshold: String(t.threshold),
      scoreThresholdGap: toFixedOrEmpty(gap, 8),
      entryPrice: t.entryPrice,
      probabilityBand: probabilityBand(t.entryPrice),
      entryPriceBand: t.entryPriceBand ?? "",
      intendedSize: t.intendedSize,
      timeSinceLastTradeSeconds: sinceSec == null ? "" : String(sinceSec),
      recommendationId: recId ?? "",
      joinConfidence,
      joinMethod,
      shadowCandidateId: chosen?.id ?? "",
      candidateSource: chosen?.candidateSource ?? "",
      wasBlocked: chosen == null ? "" : String(chosen.wasBlocked),
      wasSubmitted: chosen == null ? "" : String(chosen.wasSubmitted),
      spreadBps: toFixedOrEmpty(spreadBps, 4),
      estimatedSlippageBps: toFixedOrEmpty(estimatedSlippageBps, 4),
      shadowOutcomeClassification: chosen?.outcomeClassification ?? "",
      shadowMarkout6h: chosen?.markout6h ?? "",
      shadowMarkout24h: chosen?.markout24h ?? "",
      paperMarkout12h: t.markout12h ?? "",
      numericReturn12h: paperMarkout12h == null ? "" : String(paperMarkout12h),
      labelGoodDecision12h: labelGoodDecision12h == null ? "" : String(labelGoodDecision12h),
      returnBucket: returnBucket(paperMarkout12h),
      highConfidenceGood: "",
      groupBotType: t.botType ?? "",
      groupProbabilityBand: probabilityBand(t.entryPrice),
      groupEntryPriceBand: t.entryPriceBand ?? "",
      scoreBucket: bucket,
    });
  }

  const returns = rowsDraft
    .map((r) => parseNum(r.numericReturn12h))
    .filter((x): x is number => x != null);
  const highCut = percentileCut(returns, args.highConfidenceTopPct);
  const rows: CsvRow[] = rowsDraft.map((r) => {
    const v = parseNum(r.numericReturn12h);
    const high = v != null && highCut != null && v >= highCut ? "true" : v == null ? "" : "false";
    return { ...r, highConfidenceGood: high };
  });

  const byProbabilityBand = buildBucketDiagnostics(rows, (r) => r.probabilityBand);
  const byBotType = buildBucketDiagnostics(rows, (r) => r.botType || "unknown");
  const byScoreBucket = buildBucketDiagnostics(rows, (r) => r.scoreBucket);

  const diagnostics = {
    generatedAt: new Date().toISOString(),
    config: {
      days: args.days,
      includeOpen: args.includeOpen,
      strictJoin: args.strictJoin,
      maxJoinLagMinutes: args.maxJoinLagMinutes,
      highConfidenceTopPct: args.highConfidenceTopPct,
      highConfidenceReturnCut: highCut,
    },
    counts: {
      paperRowsFetched: paperTrades.length,
      datasetRowsWritten: rows.length,
      rowsWithNumericReturn12h: returns.length,
      strictJoinHighConfidenceRows: rows.filter((r) => r.joinConfidence === "high").length,
      lowConfidenceRows: rows.filter((r) => r.joinConfidence === "low").length,
    },
    pnlByProbabilityBand: byProbabilityBand,
    pnlByBotType: byBotType,
    pnlByScoreBucket: byScoreBucket,
  };

  const mdLines: string[] = [];
  mdLines.push("# ML training dataset v2 diagnostics");
  mdLines.push("");
  mdLines.push(`- Generated: ${diagnostics.generatedAt}`);
  mdLines.push(`- Rows written: ${diagnostics.counts.datasetRowsWritten}`);
  mdLines.push(`- Rows with 12h return: ${diagnostics.counts.rowsWithNumericReturn12h}`);
  mdLines.push(`- Strict join: ${String(args.strictJoin)}`);
  mdLines.push(`- High-confidence cut (top ${args.highConfidenceTopPct}%): ${highCut == null ? "n/a" : highCut.toFixed(8)}`);
  mdLines.push("");
  mdLines.push("## PnL by probabilityBand");
  mdLines.push("");
  mdLines.push("| band | n rows | n outcomes | mean return12h | hit rate |");
  mdLines.push("|------|--------|------------|----------------|----------|");
  for (const b of byProbabilityBand) {
    mdLines.push(
      `| ${b.key} | ${b.nRows} | ${b.nWithReturn} | ${b.meanReturn12h == null ? "n/a" : b.meanReturn12h.toFixed(8)} | ${b.hitRate == null ? "n/a" : (b.hitRate * 100).toFixed(2) + "%"} |`
    );
  }
  mdLines.push("");
  mdLines.push("## PnL by botType");
  mdLines.push("");
  mdLines.push("| botType | n rows | n outcomes | mean return12h | hit rate |");
  mdLines.push("|--------|--------|------------|----------------|----------|");
  for (const b of byBotType) {
    mdLines.push(
      `| ${b.key} | ${b.nRows} | ${b.nWithReturn} | ${b.meanReturn12h == null ? "n/a" : b.meanReturn12h.toFixed(8)} | ${b.hitRate == null ? "n/a" : (b.hitRate * 100).toFixed(2) + "%"} |`
    );
  }
  mdLines.push("");
  mdLines.push("## PnL by score bucket");
  mdLines.push("");
  mdLines.push("| score bucket | n rows | n outcomes | mean return12h | hit rate |");
  mdLines.push("|--------------|--------|------------|----------------|----------|");
  for (const b of byScoreBucket) {
    mdLines.push(
      `| ${b.key} | ${b.nRows} | ${b.nWithReturn} | ${b.meanReturn12h == null ? "n/a" : b.meanReturn12h.toFixed(8)} | ${b.hitRate == null ? "n/a" : (b.hitRate * 100).toFixed(2) + "%"} |`
    );
  }
  mdLines.push("");

  await fs.writeFile(outCsvPath, toCsv(rows), "utf8");
  await fs.writeFile(outJsonPath, JSON.stringify(diagnostics, null, 2), "utf8");
  await fs.writeFile(outMdPath, mdLines.join("\n"), "utf8");

  console.log(`Wrote ${outCsvPath}`);
  console.log(`Wrote ${outJsonPath}`);
  console.log(`Wrote ${outMdPath}`);
  console.log(`Rows: ${rows.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

