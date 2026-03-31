/**
 * Train post-fix Platt calibrator from joined paper/ML cohort (read-only output).
 * Writes dump/postfix-platt-calibrator.json
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizeShadowSideForJoin } from "../lib/shadow-telemetry";
import {
  applyPlattCalibrator,
  trainPlattCalibrator,
  type PlattCalibrator,
} from "../lib/ml/calibration/platt-calibrator";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "postfix-platt-calibrator.json");

const AFTER_RAW = process.env.POSTFIX_LINKAGE_AFTER?.trim();
const PAPER_N = Math.min(10000, Math.max(50, Number(process.env.POSTFIX_ML_QUALITY_PAPER_N ?? "2000") || 2000));
const ML_N = Math.min(50000, Math.max(200, Number(process.env.POSTFIX_ML_QUALITY_ML_N ?? "10000") || 10000));

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

function parseCalibrationRawOrScore(metadataJson: string | null, score: number): number | null {
  if (metadataJson) {
    try {
      const o = JSON.parse(metadataJson) as Record<string, unknown>;
      const open = (o.openAttribution ?? {}) as Record<string, unknown>;
      const cal = (open.paperShadowScoreCalibration ?? o.paperShadowScoreCalibration ?? {}) as Record<
        string,
        unknown
      >;
      const raw = cal.shadowMlScoreRaw;
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (raw != null) {
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
      }
    } catch {
      // fallback below
    }
  }
  return Number.isFinite(score) ? score : null;
}

function bucketId(x: number): string {
  if (x < 0.5) return "<0.5";
  if (x < 0.7) return "0.5-0.7";
  if (x < 0.9) return "0.7-0.9";
  if (x < 0.99) return "0.9-0.99";
  if (x < 0.999) return "0.99-0.999";
  return "0.999+";
}

function bucketStats(rows: Array<{ score: number; y: number }>) {
  const ids = ["<0.5", "0.5-0.7", "0.7-0.9", "0.9-0.99", "0.99-0.999", "0.999+"] as const;
  return ids.map((id) => {
    const b = rows.filter((r) => bucketId(r.score) === id);
    return {
      bucket: id,
      n: b.length,
      labelRate: b.length ? b.reduce((a, c) => a + c.y, 0) / b.length : null,
      meanScore: b.length ? b.reduce((a, c) => a + c.score, 0) / b.length : null,
    };
  });
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
      entryTime: true,
      score: true,
      metadataJson: true,
      assetId: true,
      side: true,
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

  const trainScores: number[] = [];
  const trainLabels: number[] = [];
  const joinedRows: Array<{ raw: number; y: number }> = [];

  for (const p of paperRows) {
    const rec = parseRecommendationId(p.metadataJson);
    if (!rec) continue;
    const key = `${rec}|${p.assetId}|${normalizeShadowSideForJoin(p.side)}`;
    const hits = mlByTriple.get(key) ?? [];
    const labelRow = hits.find((h) => h.labelGoodDecision12h !== null);
    if (!labelRow || labelRow.labelGoodDecision12h === null) continue;
    const raw = parseCalibrationRawOrScore(p.metadataJson, p.score);
    if (raw == null) continue;
    const y = labelRow.labelGoodDecision12h ? 1 : 0;
    trainScores.push(raw);
    trainLabels.push(y);
    joinedRows.push({ raw, y });
  }

  const params: PlattCalibrator = trainPlattCalibrator(trainScores, trainLabels);
  const before = bucketStats(joinedRows.map((r) => ({ score: r.raw, y: r.y })));
  const after = bucketStats(joinedRows.map((r) => ({ score: applyPlattCalibrator(r.raw, params), y: r.y })));

  const report = {
    generatedAt: new Date().toISOString(),
    cutoffUsed: cutoff.toISOString(),
    trainingSampleSize: trainScores.length,
    parameters: params,
    scoreVsLabelBuckets: {
      beforeRaw: before,
      afterPlatt: after,
    },
    usageHint: {
      PAPER_SHADOW_USE_PLATT_CALIBRATION: "true",
      PAPER_SHADOW_PLATT_A: String(params.a),
      PAPER_SHADOW_PLATT_B: String(params.b),
    },
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");
  console.log("[train-postfix-platt-calibrator]", {
    trainingSampleSize: trainScores.length,
    a: params.a,
    b: params.b,
    output: OUT_JSON,
  });
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

