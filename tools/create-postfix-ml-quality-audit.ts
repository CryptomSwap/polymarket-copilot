/**
 * Post-fix-only ML quality audit (read-only).
 * Uses only rows after POSTFIX_LINKAGE_AFTER to avoid pre-fix contamination.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizeShadowSideForJoin } from "../lib/shadow-telemetry";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "postfix-ml-quality-audit.json");
const OUT_MD = path.join(DUMP_DIR, "postfix-ml-quality-audit.md");
const OUT_CHAT = path.join(DUMP_DIR, "postfix-ml-quality-audit-chat-summary.md");

const AFTER_RAW = process.env.POSTFIX_LINKAGE_AFTER?.trim();
const PAPER_N = Math.min(2000, Math.max(1, Number(process.env.POSTFIX_ML_QUALITY_PAPER_N ?? "200") || 200));
const ML_N = Math.min(20000, Math.max(100, Number(process.env.POSTFIX_ML_QUALITY_ML_N ?? "1000") || 1000));

const HIST_BUCKETS = ["<0.5", "0.5-0.7", "0.7-0.9", "0.9-0.99", "0.99-0.999", "0.999+"] as const;
const SCORE_BANDS = ["low", "medium", "high"] as const;
type ScoreBand = (typeof SCORE_BANDS)[number];

function quantileSorted(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function dist(values: number[]) {
  const s = [...values].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return {
    n: s.length,
    p01: quantileSorted(s, 0.01),
    p05: quantileSorted(s, 0.05),
    p10: quantileSorted(s, 0.1),
    p25: quantileSorted(s, 0.25),
    p50: quantileSorted(s, 0.5),
    p75: quantileSorted(s, 0.75),
    p90: quantileSorted(s, 0.9),
    p95: quantileSorted(s, 0.95),
    p99: quantileSorted(s, 0.99),
    max: s.length ? s[s.length - 1]! : null,
    min: s.length ? s[0]! : null,
  };
}

function histogram(values: number[]) {
  const out: Record<(typeof HIST_BUCKETS)[number], number> = {
    "<0.5": 0,
    "0.5-0.7": 0,
    "0.7-0.9": 0,
    "0.9-0.99": 0,
    "0.99-0.999": 0,
    "0.999+": 0,
  };
  for (const x of values) {
    if (!Number.isFinite(x)) continue;
    if (x < 0.5) out["<0.5"]++;
    else if (x < 0.7) out["0.5-0.7"]++;
    else if (x < 0.9) out["0.7-0.9"]++;
    else if (x < 0.99) out["0.9-0.99"]++;
    else if (x < 0.999) out["0.99-0.999"]++;
    else out["0.999+"]++;
  }
  return out;
}

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

function parseCalibration(metadataJson: string | null): {
  raw: number | null;
  calibrated: number | null;
  admission: number | null;
} {
  if (!metadataJson) return { raw: null, calibrated: null, admission: null };
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const open = (o.openAttribution ?? {}) as Record<string, unknown>;
    const cal = (open.paperShadowScoreCalibration ?? o.paperShadowScoreCalibration ?? {}) as Record<
      string,
      unknown
    >;
    const num = (k: string): number | null => {
      const v = cal[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (v != null) {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };
    return {
      raw: num("shadowMlScoreRaw"),
      calibrated: num("shadowMlScoreCalibrated"),
      admission: num("admissionScore"),
    };
  } catch {
    return { raw: null, calibrated: null, admission: null };
  }
}

function scoreBand(x: number): ScoreBand {
  if (x < 0.4) return "low";
  if (x < 0.6) return "medium";
  return "high";
}

function parsePnlProxy(pnlPct: string | null, markout12h: string | null): number | null {
  const p = pnlPct == null ? NaN : Number(pnlPct);
  if (Number.isFinite(p)) return p;
  const m = markout12h == null ? NaN : Number(markout12h);
  return Number.isFinite(m) ? m : null;
}

async function main(): Promise<void> {
  if (!AFTER_RAW) {
    console.error("POSTFIX_LINKAGE_AFTER is required.");
    process.exit(1);
  }
  const cutoff = new Date(AFTER_RAW);
  if (Number.isNaN(cutoff.getTime())) {
    console.error("POSTFIX_LINKAGE_AFTER is invalid ISO date:", AFTER_RAW);
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
      botType: true,
      assetId: true,
      side: true,
      score: true,
      metadataJson: true,
      pnlPct: true,
      markout12h: true,
    },
  });
  const mlRows = await prisma.mlShadowTrainingExample.findMany({
    where: { createdAt: { gte: cutoff } },
    orderBy: { createdAt: "desc" },
    take: ML_N,
    select: {
      id: true,
      createdAt: true,
      recommendationId: true,
      assetId: true,
      side: true,
      labelGoodDecision12h: true,
    },
  });

  const mlByTriple = new Map<string, typeof mlRows>();
  for (const r of mlRows) {
    const rec = r.recommendationId?.trim();
    if (!rec) continue;
    const key = `${rec}|${r.assetId}|${normalizeShadowSideForJoin(r.side)}`;
    const arr = mlByTriple.get(key) ?? [];
    arr.push(r);
    mlByTriple.set(key, arr);
  }
  for (const arr of mlByTriple.values()) {
    arr.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  type Joined = {
    paperId: string;
    botType: string;
    raw: number;
    calibrated: number;
    admission: number;
    label: boolean | null;
    pnlProxy: number | null;
  };
  const joined: Joined[] = [];
  let withRec = 0;
  let joinedCount = 0;
  let labeledCount = 0;
  for (const p of paperRows) {
    const rec = parseRecommendationId(p.metadataJson);
    if (!rec) continue;
    withRec++;
    const key = `${rec}|${p.assetId}|${normalizeShadowSideForJoin(p.side)}`;
    const hits = mlByTriple.get(key) ?? [];
    if (hits.length === 0) continue;
    joinedCount++;
    const labelHit = hits.find((h) => h.labelGoodDecision12h !== null) ?? hits[0]!;
    if (labelHit.labelGoodDecision12h !== null) labeledCount++;
    const cal = parseCalibration(p.metadataJson);
    const raw = cal.raw ?? p.score;
    const calibrated = cal.calibrated ?? raw;
    const admission = cal.admission ?? calibrated ?? raw;
    joined.push({
      paperId: p.id,
      botType: p.botType,
      raw,
      calibrated,
      admission,
      label: labelHit.labelGoodDecision12h,
      pnlProxy: parsePnlProxy(p.pnlPct, p.markout12h),
    });
  }

  const rawArr = joined.map((x) => x.raw);
  const calArr = joined.map((x) => x.calibrated);
  const admArr = joined.map((x) => x.admission);
  const share = (arr: number[], t: number) => (arr.length ? arr.filter((x) => x >= t).length / arr.length : 0);

  const byBand = SCORE_BANDS.map((band) => {
    const rows = joined.filter((j) => scoreBand(j.admission) === band);
    const labels = rows.filter((r) => r.label !== null);
    const pnlVals = rows.map((r) => r.pnlProxy).filter((x): x is number => x != null && Number.isFinite(x));
    return {
      band,
      n: rows.length,
      labeledN: labels.length,
      labelRate: labels.length ? labels.filter((r) => r.label === true).length / labels.length : null,
      pnlProxyAvg: pnlVals.length ? pnlVals.reduce((a, b) => a + b, 0) / pnlVals.length : null,
    };
  });

  const bots = ["strict_quality", "relaxed_edge", "tail_extremes"] as const;
  const perBot = bots.map((b) => {
    const rows = joined.filter((j) => j.botType === b);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null);
    const labels = rows.filter((r) => r.label !== null);
    const pnlVals = rows.map((r) => r.pnlProxy).filter((x): x is number => x != null && Number.isFinite(x));
    return {
      botType: b,
      joinedCount: rows.length,
      avgRawScore: avg(rows.map((r) => r.raw)),
      avgCalibratedScore: avg(rows.map((r) => r.calibrated)),
      avgAdmissionScore: avg(rows.map((r) => r.admission)),
      labelRate: labels.length ? labels.filter((r) => r.label === true).length / labels.length : null,
      pnlProxyAvg: avg(pnlVals),
    };
  });

  const rawScoreSaturated = share(rawArr, 0.999) > 0.2 || (dist(rawArr).p90 ?? 0) > 0.995;
  const calibratedScoreStillTooCompressed =
    (dist(calArr).p75 ?? 0) - (dist(calArr).p25 ?? 0) < 0.05 || share(calArr, 0.99) > 0.5;
  const lowBand = byBand.find((b) => b.band === "low");
  const highBand = byBand.find((b) => b.band === "high");
  const thresholdUseful =
    lowBand?.labelRate != null && highBand?.labelRate != null
      ? highBand.labelRate - lowBand.labelRate >= 0.08
      : false;

  const calibrationUsefulnessSummary =
    calibratedScoreStillTooCompressed
      ? "Calibrated scores remain tightly clustered; limited ranking separation."
      : "Calibrated scores show usable spread in this post-fix cohort.";

  const recommendationRanked = (() => {
    if (rawScoreSaturated) {
      return [
        "recalibrate model",
        "improve feature set",
        "retrain with better labels/support",
        "adjust thresholds",
        "tune exploration",
      ];
    }
    if (!thresholdUseful) {
      return [
        "retrain with better labels/support",
        "improve feature set",
        "recalibrate model",
        "adjust thresholds",
        "tune exploration",
      ];
    }
    if (calibratedScoreStillTooCompressed) {
      return [
        "recalibrate model",
        "adjust thresholds",
        "improve feature set",
        "retrain with better labels/support",
        "tune exploration",
      ];
    }
    return [
      "adjust thresholds",
      "tune exploration",
      "improve feature set",
      "recalibrate model",
      "retrain with better labels/support",
    ];
  })();

  const report = {
    generatedAt: new Date().toISOString(),
    sectionA_scope: {
      cutoffUsed: cutoff.toISOString(),
      paperRowsScanned: paperRows.length,
      mlRowsScanned: mlRows.length,
      joinedPaperTradesCount: joined.length,
      earliestPaperEntryTime:
        paperRows.length > 0
          ? new Date(Math.min(...paperRows.map((p) => p.entryTime.getTime()))).toISOString()
          : null,
      latestPaperEntryTime:
        paperRows.length > 0
          ? new Date(Math.max(...paperRows.map((p) => p.entryTime.getTime()))).toISOString()
          : null,
      earliestMlCreatedAt:
        mlRows.length > 0
          ? new Date(Math.min(...mlRows.map((m) => m.createdAt.getTime()))).toISOString()
          : null,
      latestMlCreatedAt:
        mlRows.length > 0
          ? new Date(Math.max(...mlRows.map((m) => m.createdAt.getTime()))).toISOString()
          : null,
    },
    sectionB_scoreDistribution: {
      joinedCount: joined.length,
      raw: {
        quantiles: dist(rawArr),
        histogram: histogram(rawArr),
        shareGe099: share(rawArr, 0.99),
        shareGe0999: share(rawArr, 0.999),
        shareGe09999: share(rawArr, 0.9999),
      },
      calibrated: {
        quantiles: dist(calArr),
        histogram: histogram(calArr),
        shareGe099: share(calArr, 0.99),
        shareGe0999: share(calArr, 0.999),
        shareGe09999: share(calArr, 0.9999),
      },
      admission: {
        quantiles: dist(admArr),
        histogram: histogram(admArr),
        shareGe099: share(admArr, 0.99),
        shareGe0999: share(admArr, 0.999),
        shareGe09999: share(admArr, 0.9999),
      },
    },
    sectionC_outcomeVsScore: {
      tradesWithRecommendationIdInMetadata: withRec,
      tradesJoinedToTrainingExample: joinedCount,
      tradesWithNonNullLabelGoodDecision12h: labeledCount,
      pctPaperTradesJoinedToExample: paperRows.length ? joinedCount / paperRows.length : 0,
      pctPaperTradesWithNonNullLabel12h: paperRows.length ? labeledCount / paperRows.length : 0,
      byAdmissionScoreBand: byBand,
      calibrationUsefulnessSummary,
    },
    sectionD_perBotPostfixQuality: perBot,
    sectionE_saturationDiagnosis: {
      rawScoreSaturated,
      calibratedScoreStillTooCompressed,
      thresholdUseful,
      explanation:
        `rawSaturated=${rawScoreSaturated}, calCompressed=${calibratedScoreStillTooCompressed}, thresholdUseful=${thresholdUseful}. ` +
        "Threshold useful means higher admission-score band has materially better label rate than low band.",
    },
    sectionF_recommendation: {
      rankedNextSteps: recommendationRanked,
      topRecommendation: recommendationRanked[0],
    },
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Post-fix ML quality audit",
    "",
    `Cutoff: \`${report.sectionA_scope.cutoffUsed}\``,
    `Joined cohort: **${joined.length}**`,
    "",
    "## Saturation diagnosis",
    `- rawScoreSaturated: **${rawScoreSaturated}**`,
    `- calibratedScoreStillTooCompressed: **${calibratedScoreStillTooCompressed}**`,
    `- thresholdUseful: **${thresholdUseful}**`,
    "",
    "## Linkage/labels (joined semantics)",
    `- joined % (of scanned paper): **${(100 * report.sectionC_outcomeVsScore.pctPaperTradesJoinedToExample).toFixed(1)}%**`,
    `- label % (of scanned paper): **${(100 * report.sectionC_outcomeVsScore.pctPaperTradesWithNonNullLabel12h).toFixed(1)}%**`,
    "",
    "## Top recommendation",
    `1. ${recommendationRanked[0]}`,
    "",
    `JSON: \`${OUT_JSON}\``,
  ].join("\n");
  await fs.writeFile(OUT_MD, md, "utf8");

  const chat = [
    "## Post-fix ML quality audit",
    `- joined rows analyzed: **${joined.length}**`,
    `- raw saturation: **${rawScoreSaturated}**`,
    `- calibrated usefulness: **${!calibratedScoreStillTooCompressed}**`,
    `- threshold usefulness: **${thresholdUseful}**`,
    `- top recommendation: **${recommendationRanked[0]}**`,
    `- files: \`dump/postfix-ml-quality-audit.{json,md,-chat-summary.md}\``,
  ].join("\n");
  await fs.writeFile(OUT_CHAT, chat, "utf8");

  console.log("[postfix-ml-quality-audit]", {
    joinedRowsAnalyzed: joined.length,
    rawSaturation: rawScoreSaturated,
    calibratedUsefulness: !calibratedScoreStillTooCompressed,
    thresholdUsefulness: thresholdUseful,
    topRecommendation: recommendationRanked[0],
    outputs: [OUT_JSON, OUT_MD, OUT_CHAT],
  });
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
