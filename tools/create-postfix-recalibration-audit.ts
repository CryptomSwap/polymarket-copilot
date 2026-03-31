/**
 * Post-fix recalibration audit (read-only).
 * Focus: raw -> calibrated -> admission behavior on post-fix joined cohort.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizeShadowSideForJoin } from "../lib/shadow-telemetry";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "postfix-recalibration-audit.json");
const OUT_MD = path.join(DUMP_DIR, "postfix-recalibration-audit.md");
const OUT_CHAT = path.join(DUMP_DIR, "postfix-recalibration-audit-chat-summary.md");

const AFTER_RAW = process.env.POSTFIX_LINKAGE_AFTER?.trim();
const PAPER_N = Math.min(5000, Math.max(50, Number(process.env.POSTFIX_ML_QUALITY_PAPER_N ?? "300") || 300));
const ML_N = Math.min(20000, Math.max(200, Number(process.env.POSTFIX_ML_QUALITY_ML_N ?? "1500") || 1500));

const SCORE_BUCKETS = [
  { id: "<0.5", min: -Infinity, max: 0.5 },
  { id: "0.5-0.7", min: 0.5, max: 0.7 },
  { id: "0.7-0.9", min: 0.7, max: 0.9 },
  { id: "0.9-0.99", min: 0.9, max: 0.99 },
  { id: "0.99-0.999", min: 0.99, max: 0.999 },
  { id: "0.999+", min: 0.999, max: Infinity },
] as const;

type BucketId = (typeof SCORE_BUCKETS)[number]["id"];

type JoinedRow = {
  paperTradeId: string;
  botType: string;
  raw: number;
  calibrated: number;
  admission: number;
  label: boolean | null;
  pnlProxy: number | null;
};

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

function parsePnlProxy(pnlPct: string | null, markout12h: string | null): number | null {
  const p = pnlPct == null ? NaN : Number(pnlPct);
  if (Number.isFinite(p)) return p;
  const m = markout12h == null ? NaN : Number(markout12h);
  return Number.isFinite(m) ? m : null;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function summary(values: number[]) {
  const s = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  return {
    n: s.length,
    min: s.length ? s[0]! : null,
    p10: quantile(s, 0.1),
    p25: quantile(s, 0.25),
    p50: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    p90: quantile(s, 0.9),
    p99: quantile(s, 0.99),
    max: s.length ? s[s.length - 1]! : null,
  };
}

function histogram(values: number[]): Record<BucketId, number> {
  const out = Object.fromEntries(SCORE_BUCKETS.map((b) => [b.id, 0])) as Record<BucketId, number>;
  for (const x of values) {
    if (!Number.isFinite(x)) continue;
    const b = SCORE_BUCKETS.find((z) => x >= z.min && x < z.max);
    if (b) out[b.id]++;
  }
  return out;
}

function byBucket(rows: JoinedRow[], field: "raw" | "calibrated"): Array<{
  bucket: BucketId;
  n: number;
  labelN: number;
  labelRate: number | null;
  pnlProxyAvg: number | null;
}> {
  return SCORE_BUCKETS.map((b) => {
    const rs = rows.filter((r) => r[field] >= b.min && r[field] < b.max);
    const labels = rs.filter((r) => r.label !== null);
    const pnlVals = rs.map((r) => r.pnlProxy).filter((x): x is number => x != null && Number.isFinite(x));
    return {
      bucket: b.id,
      n: rs.length,
      labelN: labels.length,
      labelRate: labels.length ? labels.filter((r) => r.label === true).length / labels.length : null,
      pnlProxyAvg: pnlVals.length ? pnlVals.reduce((a, c) => a + c, 0) / pnlVals.length : null,
    };
  });
}

function monotonicitySignal(rows: Array<{ labelRate: number | null }>): {
  monotonicNonDecreasing: boolean | null;
  violations: number;
} {
  const vals = rows.map((r) => r.labelRate);
  const finite = vals.filter((x): x is number => x != null && Number.isFinite(x));
  if (finite.length < 3) return { monotonicNonDecreasing: null, violations: 0 };
  let prev: number | null = null;
  let violations = 0;
  for (const v of vals) {
    if (v == null) continue;
    if (prev != null && v + 1e-9 < prev) violations++;
    prev = v;
  }
  return { monotonicNonDecreasing: violations === 0, violations };
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null;
}

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
      botType: true,
      entryTime: true,
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
  for (const m of mlRows) {
    const rec = m.recommendationId?.trim();
    if (!rec) continue;
    const key = `${rec}|${m.assetId}|${normalizeShadowSideForJoin(m.side)}`;
    const arr = mlByTriple.get(key) ?? [];
    arr.push(m);
    mlByTriple.set(key, arr);
  }
  for (const arr of mlByTriple.values()) arr.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const joined: JoinedRow[] = [];
  for (const p of paperRows) {
    const rec = parseRecommendationId(p.metadataJson);
    if (!rec) continue;
    const key = `${rec}|${p.assetId}|${normalizeShadowSideForJoin(p.side)}`;
    const hits = mlByTriple.get(key) ?? [];
    if (hits.length === 0) continue;
    const h = hits.find((x) => x.labelGoodDecision12h !== null) ?? hits[0]!;
    const cal = parseCalibration(p.metadataJson);
    const raw = cal.raw ?? p.score;
    const calibrated = cal.calibrated ?? raw;
    const admission = cal.admission ?? calibrated;
    joined.push({
      paperTradeId: p.id,
      botType: p.botType,
      raw,
      calibrated,
      admission,
      label: h.labelGoodDecision12h,
      pnlProxy: parsePnlProxy(p.pnlPct, p.markout12h),
    });
  }

  const rawArr = joined.map((j) => j.raw);
  const calArr = joined.map((j) => j.calibrated);
  const admArr = joined.map((j) => j.admission);
  const rawBuckets = byBucket(joined, "raw");
  const calBuckets = byBucket(joined, "calibrated");
  const monoRaw = monotonicitySignal(rawBuckets);
  const monoCal = monotonicitySignal(calBuckets);

  const shareRaw999 = rawArr.length ? rawArr.filter((x) => x >= 0.999).length / rawArr.length : 0;
  const shareCal999 = calArr.length ? calArr.filter((x) => x >= 0.999).length / calArr.length : 0;
  const rawTopHeavy = shareRaw999 > 0.2 || (summary(rawArr).p90 ?? 0) > 0.995;
  const calTopHeavy = shareCal999 > 0.2 || (summary(calArr).p90 ?? 0) > 0.99;
  const calIqr = (summary(calArr).p75 ?? 0) - (summary(calArr).p25 ?? 0);
  const calibratedTooCompressed = calIqr < 0.05 || calTopHeavy;

  const lowCal = calBuckets.find((b) => b.bucket === "<0.5")?.labelRate ?? null;
  const highCal = calBuckets.find((b) => b.bucket === "0.9-0.99")?.labelRate ?? null;
  const thresholdUseful =
    lowCal != null && highCal != null ? highCal - lowCal >= 0.08 : (monoCal.monotonicNonDecreasing ?? false);

  const perBot = ["strict_quality", "relaxed_edge", "tail_extremes"].map((bot) => {
    const rows = joined.filter((j) => j.botType === bot);
    const labels = rows.filter((r) => r.label !== null);
    const pnlVals = rows.map((r) => r.pnlProxy).filter((x): x is number => x != null && Number.isFinite(x));
    return {
      botType: bot,
      joinedCount: rows.length,
      avgRawScore: mean(rows.map((r) => r.raw)),
      avgCalibratedScore: mean(rows.map((r) => r.calibrated)),
      avgAdmissionScore: mean(rows.map((r) => r.admission)),
      labelRate: labels.length ? labels.filter((r) => r.label === true).length / labels.length : null,
      pnlProxyAvg: mean(pnlVals),
    };
  });

  const optionMatrix = [
    {
      option: "recalibrator retrain using post-fix-compatible cohort",
      implementationRisk: "low",
      expectedEffectOnScoreSpread: "medium",
      compatibilityWithCurrentPipeline: "high",
      notes:
        "Current calibrator is temperature scaling via PAPER_SHADOW_LOGIT_TEMPERATURE. Safest refresh is parameter-only retune from post-fix joined cohort.",
    },
    {
      option: "raw-score logit clipping before calibration",
      implementationRisk: "medium",
      expectedEffectOnScoreSpread: "low_to_medium",
      compatibilityWithCurrentPipeline: "medium",
      notes:
        "Would change transform in score path (applyPaperShadowLogitTemperature/probaToLogit behavior). Higher risk than pure temperature retune.",
    },
    {
      option: "isotonic/platt refresh if already supported",
      implementationRisk: "high",
      expectedEffectOnScoreSpread: "unknown_to_high",
      compatibilityWithCurrentPipeline: "low",
      notes: "No native isotonic/platt artifact/loader path found in current score pipeline.",
    },
    {
      option: "no change yet if sample too small",
      implementationRisk: "lowest",
      expectedEffectOnScoreSpread: "none_now",
      compatibilityWithCurrentPipeline: "highest",
      notes: "Prefer when joined cohort or labeled support is insufficient.",
    },
  ];

  const labeledSupport = joined.filter((j) => j.label !== null).length;
  const recommendation =
    joined.length < 80 || labeledSupport < 40
      ? "collect more data first"
      : calibratedTooCompressed || !thresholdUseful
        ? "retrain calibrator only"
        : monoCal.monotonicNonDecreasing === false && monoRaw.monotonicNonDecreasing === true
          ? "keep current calibrator"
          : rawTopHeavy
            ? "retrain calibrator only"
            : "keep current calibrator";

  const report = {
    generatedAt: new Date().toISOString(),
    sectionA_currentCalibrationMappingSummary: {
      flow: "scoreShadowCandidate: raw logistic proba (shadowMlScore) -> applyPaperShadowLogitTemperature(raw, T) => shadowMlScoreCalibrated -> admissionScore uses calibrated iff paperShadowUseCalibratedScoreForPaper=true else raw.",
      calibratorType: "logit temperature scaling only",
      calibratorParameters: {
        paperShadowLogitTemperatureEnv: "PAPER_SHADOW_LOGIT_TEMPERATURE",
        paperShadowUseCalibratedScoreForPaperEnv: "PAPER_SHADOW_USE_CALIBRATED_SCORE_FOR_PAPER",
      },
      calibratorTrainingDataSource:
        "No separate learned calibrator artifact path found; behavior controlled by runtime config/env temperature.",
      refreshCadence:
        "Runtime config refresh (env/config read). No standalone calibrator retrain job observed in scheduled-jobs/self-improvement loop.",
      cutoffUsed: cutoff.toISOString(),
      paperRowsScanned: paperRows.length,
      mlRowsScanned: mlRows.length,
      joinedPaperTrades: joined.length,
    },
    sectionB_rawVsCalibratedBucketsOnJoined: {
      raw: { quantiles: summary(rawArr), histogram: histogram(rawArr), shareGe0999: shareRaw999 },
      calibrated: { quantiles: summary(calArr), histogram: histogram(calArr), shareGe0999: shareCal999 },
      admission: { quantiles: summary(admArr), histogram: histogram(admArr) },
    },
    sectionC_outcomeByRawScoreBucket: rawBuckets,
    sectionD_outcomeByCalibratedScoreBucket: calBuckets,
    sectionE_monotonicity: {
      rawMonotonicity: monoRaw,
      calibratedMonotonicity: monoCal,
      monotonicityLooksSensible:
        (monoCal.monotonicNonDecreasing ?? monoRaw.monotonicNonDecreasing ?? false) && labeledSupport >= 40,
    },
    sectionF_topHeavyThresholding: {
      calibratedScoresTooTopHeavy: calibratedTooCompressed,
      thresholdUseful,
      shortExplanation:
        `joined=${joined.length}, labeled=${labeledSupport}, rawTopHeavy=${rawTopHeavy}, calTopHeavy=${calTopHeavy}, calIqr=${calIqr.toFixed(
          4
        )}, thresholdUseful=${thresholdUseful}.`,
    },
    sectionG_recommendation: {
      recommendation,
      optionMatrix,
    },
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Post-fix recalibration audit",
    "",
    `Cutoff: \`${cutoff.toISOString()}\``,
    `Paper rows: **${paperRows.length}**, ML rows: **${mlRows.length}**, joined: **${joined.length}**`,
    "",
    "## Calibration mapping",
    `- ${report.sectionA_currentCalibrationMappingSummary.flow}`,
    "",
    "## Joined-cohort diagnostics",
    `- raw share >=0.999: **${(100 * shareRaw999).toFixed(1)}%**`,
    `- calibrated share >=0.999: **${(100 * shareCal999).toFixed(1)}%**`,
    `- calibrated too top-heavy/compressed: **${calibratedTooCompressed}**`,
    `- threshold useful: **${thresholdUseful}**`,
    "",
    "## Recommendation",
    `- **${recommendation}**`,
    "",
    `JSON: \`${OUT_JSON}\``,
  ].join("\n");
  await fs.writeFile(OUT_MD, md, "utf8");

  const chat = [
    "## Post-fix recalibration audit",
    `- joined rows analyzed: **${joined.length}**`,
    `- raw top-heavy: **${rawTopHeavy}**`,
    `- calibrated too compressed/top-heavy: **${calibratedTooCompressed}**`,
    `- threshold useful: **${thresholdUseful}**`,
    `- recommendation: **${recommendation}**`,
    `- files: \`dump/postfix-recalibration-audit.{json,md,-chat-summary.md}\``,
  ].join("\n");
  await fs.writeFile(OUT_CHAT, chat, "utf8");

  console.log("[postfix-recalibration-audit]", {
    joinedRowsAnalyzed: joined.length,
    rawTopHeavy,
    calibratedTooCompressed,
    thresholdUseful,
    recommendation,
    outputs: [OUT_JSON, OUT_MD, OUT_CHAT],
  });
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
