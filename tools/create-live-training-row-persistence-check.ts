/**
 * Read-only check: runtime_automated paper-load ShadowCandidate rows vs MlShadowTrainingExample
 * and paper trade triple join health.
 *
 * Run: npx tsx tools/create-live-training-row-persistence-check.ts
 * Env: LIVE_TRAINING_PERSIST_CHECK_SHADOW_N (default 200), LIVE_TRAINING_PERSIST_CHECK_PAPER_N (default 50)
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizeShadowSideForJoin } from "../lib/shadow-telemetry";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "live-training-row-persistence-check.json");
const OUT_MD = path.join(DUMP_DIR, "live-training-row-persistence-check.md");
const OUT_CHAT = path.join(DUMP_DIR, "live-training-row-persistence-check-chat-summary.md");

const SHADOW_N = Math.min(
  2000,
  Math.max(20, Number(process.env.LIVE_TRAINING_PERSIST_CHECK_SHADOW_N ?? "200") || 200)
);
const PAPER_N = Math.min(
  500,
  Math.max(5, Number(process.env.LIVE_TRAINING_PERSIST_CHECK_PAPER_N ?? "50") || 50)
);

function parseRecommendationId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const id = o.recommendationId;
    if (typeof id === "string" && id.trim()) return id.trim();
    return null;
  } catch {
    return null;
  }
}

function parseMetadataShadowCandidateId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const root = o.shadowCandidateId;
    if (typeof root === "string" && root.trim()) return root.trim();
    const a = o.openAttribution as Record<string, unknown> | undefined;
    const sid = a?.shadowCandidateId ?? a?.candidateId;
    if (typeof sid === "string" && sid.trim()) return sid.trim();
    return null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const shadowRows = await prisma.shadowCandidate.findMany({
    where: {
      candidateSource: "runtime_automated",
      wasSubmitted: true,
      wasBlocked: false,
    },
    orderBy: { createdAt: "desc" },
    take: SHADOW_N,
    select: { id: true, createdAt: true, funderAddress: true, assetId: true, side: true, recommendationId: true },
  });

  const shadowIds = shadowRows.map((r) => r.id);
  const examplesForShadow = await prisma.mlShadowTrainingExample.findMany({
    where: { shadowCandidateId: { in: shadowIds } },
    select: { shadowCandidateId: true },
  });
  const exampleSet = new Set(examplesForShadow.map((e) => e.shadowCandidateId));

  let shadowWithTrainingRow = 0;
  const shadowFailures: string[] = [];
  for (const s of shadowRows) {
    if (exampleSet.has(s.id)) shadowWithTrainingRow++;
    else if (shadowFailures.length < 30) shadowFailures.push(s.id);
  }

  const paperTrades = await prisma.paperTrade.findMany({
    orderBy: { entryTime: "desc" },
    take: PAPER_N,
    select: { id: true, entryTime: true, metadataJson: true, assetId: true, side: true },
  });

  let paperWithSourceTraining = 0;
  let fullJoinOk = 0;
  const paperFailureReasons: Record<string, number> = {};

  for (const t of paperTrades) {
    const metaSc = parseMetadataShadowCandidateId(t.metadataJson);
    const rec = parseRecommendationId(t.metadataJson);
    const sideN = normalizeShadowSideForJoin(t.side);

    let hasTrainingForSource = false;
    if (metaSc) {
      const ex = await prisma.mlShadowTrainingExample.findFirst({
        where: { shadowCandidateId: metaSc },
        select: { id: true },
      });
      hasTrainingForSource = ex != null;
    }
    if (hasTrainingForSource) paperWithSourceTraining++;

    if (!rec) {
      paperFailureReasons["no_metadata_rec"] = (paperFailureReasons["no_metadata_rec"] ?? 0) + 1;
      continue;
    }

    const n = await prisma.mlShadowTrainingExample.count({
      where: { recommendationId: rec, assetId: t.assetId, side: sideN },
    });
    if (n > 0) {
      fullJoinOk++;
    } else {
      let reason = "no_triple_match";
      if (!metaSc) reason = "no_shadow_candidate_id_in_metadata";
      else if (!hasTrainingForSource) reason = "source_shadow_has_no_ml_row";
      else reason = "triple_mismatch_recommendation_asset_or_side";
      paperFailureReasons[reason] = (paperFailureReasons[reason] ?? 0) + 1;
    }
  }

  const pct = (a: number, b: number) => (b === 0 ? 0 : Number(((100 * a) / b).toFixed(1)));

  const summary = {
    shadowCandidatesScanned: shadowRows.length,
    shadowCandidatesWithMlTrainingRow: shadowWithTrainingRow,
    pctShadowWithTrainingRow: pct(shadowWithTrainingRow, shadowRows.length),
    paperTradesScanned: paperTrades.length,
    paperTradesWithTrainingRowForMetadataShadowCandidateId: paperWithSourceTraining,
    pctPaperWithSourceTraining: pct(paperWithSourceTraining, paperTrades.length),
    paperTradesFullTripleJoinOk: fullJoinOk,
    fullJoinSuccessPct: pct(fullJoinOk, paperTrades.length),
    paperJoinFailureHistogram: paperFailureReasons,
    documentation: {
      paperLoadShape:
        "ShadowCandidate: candidateSource=runtime_automated, wasSubmitted=true, wasBlocked=false (lib/paper-trading/candidates.ts#getSubmittedShadowCandidatesForTickWithDiagnostics).",
      persistPath:
        "persistShadowTrainingExamples: lib/ml/shadow-dataset/build.ts; invoked from scheduled ml_shadow_dataset_build (with includeUnevaluatedPaperLoadShapeRuntimeAutomated when evaluatedOnly), paper_trading_tick (paperLoadShapeRuntimeAutomatedOnly + lookback), self-improvement runShadowDatasetRefreshJob.",
      dedupe: "MlShadowTrainingExample.shadowCandidateId @unique — persist skips create when row exists (lib/ml/shadow-dataset/build.ts).",
      effectiveRecommendationId:
        "lib/shadow-telemetry/effective-recommendation-id.ts — effectiveRecommendationIdForShadowCandidate matches paper metadata recommendationId.",
    },
    sampleShadowIdsMissingMlRow: shadowFailures,
  };

  const payload = { generatedAt: new Date().toISOString(), summary };
  await fs.writeFile(OUT_JSON, JSON.stringify(payload, null, 2), "utf8");

  const md = [
    "# Live training row persistence check",
    "",
    `- Shadow candidates (paper load shape, recent ${SHADOW_N}): **${summary.shadowCandidatesScanned}**`,
    `- With MlShadowTrainingExample: **${shadowWithTrainingRow}** (${summary.pctShadowWithTrainingRow}%)`,
    `- Paper trades (recent ${PAPER_N}): **${summary.paperTradesScanned}**`,
    `- Paper with training row for metadata shadowCandidateId: **${paperWithSourceTraining}** (${summary.pctPaperWithSourceTraining}%)`,
    `- Full join (metadata recommendationId + assetId + normalized side): **${fullJoinOk}** (${summary.fullJoinSuccessPct}%)`,
    "",
    "## Failure histogram (paper)",
    ...Object.entries(paperFailureReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- ${k}: ${v}`),
    "",
    `JSON: \`${OUT_JSON}\``,
  ].join("\n");
  await fs.writeFile(OUT_MD, md, "utf8");

  const chat = [
    "## Live training persistence (paste)",
    `- Shadow scanned: **${summary.shadowCandidatesScanned}**, with ML row: **${shadowWithTrainingRow}** (${summary.pctShadowWithTrainingRow}%)`,
    `- Paper scanned: **${summary.paperTradesScanned}**, source candidate has ML row: **${paperWithSourceTraining}** (${summary.pctPaperWithSourceTraining}%)`,
    `- Full triple join OK: **${fullJoinOk}** (${summary.fullJoinSuccessPct}%)`,
    `- Files: \`dump/live-training-row-persistence-check.{json,md,-chat-summary.md}\``,
  ].join("\n");
  await fs.writeFile(OUT_CHAT, chat, "utf8");

  console.log("[live-training-row-persistence-check]", {
    recentShadowCandidatesScanned: summary.shadowCandidatesScanned,
    recentTrainingRowsForThose: shadowWithTrainingRow,
    recentPaperTradesScanned: summary.paperTradesScanned,
    paperTradesWhoseSourceCandidateHasTrainingRow: paperWithSourceTraining,
    fullJoinSuccessPct: summary.fullJoinSuccessPct,
    outputs: [OUT_JSON, OUT_MD, OUT_CHAT],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
