/**
 * Read-only: paper vs MlShadowTrainingExample identity alignment after explicit-id persist fix.
 * Run: npx tsx tools/create-paper-ml-identity-alignment-check.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizeShadowSideForJoin } from "../lib/shadow-telemetry";
import { parseOpenAttributionFromMetadataJson } from "../lib/paper-trading/paper-trade-open-attribution";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "paper-ml-identity-alignment-check.json");
const OUT_MD = path.join(DUMP_DIR, "paper-ml-identity-alignment-check.md");
const OUT_CHAT = path.join(DUMP_DIR, "paper-ml-identity-alignment-check-chat-summary.md");

const PAPER_N = Math.min(200, Math.max(5, Number(process.env.PAPER_ML_ALIGN_PAPER_N ?? "50") || 50));
const ML_N = Math.min(5000, Math.max(50, Number(process.env.PAPER_ML_ALIGN_ML_N ?? "400") || 400));

function parseRec(metadataJson: string | null): string | null {
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

function parseSc(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const root = o.shadowCandidateId;
    if (typeof root === "string" && root.trim()) return root.trim();
  } catch {
    /* fall through */
  }
  const a = parseOpenAttributionFromMetadataJson(metadataJson);
  const sid = a?.shadowCandidateId ?? a?.candidateId;
  return typeof sid === "string" && sid.trim() ? sid.trim() : null;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const paperTrades = await prisma.paperTrade.findMany({
    orderBy: { entryTime: "desc" },
    take: PAPER_N,
    select: { id: true, entryTime: true, metadataJson: true, assetId: true, side: true },
  });

  const mlRows = await prisma.mlShadowTrainingExample.findMany({
    orderBy: { createdAt: "desc" },
    take: ML_N,
    select: {
      id: true,
      shadowCandidateId: true,
      recommendationId: true,
      assetId: true,
      side: true,
      labelGoodDecision12h: true,
      createdAt: true,
    },
  });

  const mlSc = new Set(mlRows.map((m) => m.shadowCandidateId));
  const mlRec = new Set(mlRows.map((m) => m.recommendationId?.trim()).filter((x): x is string => Boolean(x)));
  const mlTriple = new Set<string>();
  for (const m of mlRows) {
    const r = m.recommendationId?.trim();
    if (!r) continue;
    mlTriple.add(`${r}\0${m.assetId}\0${normalizeShadowSideForJoin(m.side)}`);
  }

  let exactSc = 0;
  let exactRec = 0;
  let exactTriple = 0;
  let sameAssetSideDiffRec = 0;

  for (const t of paperTrades) {
    const sc = parseSc(t.metadataJson);
    const rec = parseRec(t.metadataJson);
    const sideN = normalizeShadowSideForJoin(t.side);
    if (sc && mlSc.has(sc)) exactSc++;
    if (rec && mlRec.has(rec)) exactRec++;
    if (rec) {
      const k = `${rec}\0${t.assetId}\0${sideN}`;
      if (mlTriple.has(k)) exactTriple++;
      else {
        const anySameShape = mlRows.some(
          (m) => m.assetId === t.assetId && normalizeShadowSideForJoin(m.side) === sideN
        );
        if (anySameShape) sameAssetSideDiffRec++;
      }
    }
  }

  const paperCount = paperTrades.length;
  const dominantMismatch = (() => {
    if (paperCount === 0) return "no_paper_rows";
    const tr = exactTriple / paperCount;
    if (tr >= 0.85) return "triple_join_mostly_aligned";
    if (sameAssetSideDiffRec / paperCount > 0.25) return "recommendationId_basis_mismatch_same_asset_side";
    if (exactSc / paperCount < 0.3) return "shadow_candidate_id_mismatch";
    return "mixed";
  })();

  const payload = {
    generatedAt: new Date().toISOString(),
    config: { PAPER_N, ML_N },
    recentPaperTrades: paperTrades.map((t) => ({
      paperTradeId: t.id,
      entryTime: t.entryTime.toISOString(),
      recommendationId: parseRec(t.metadataJson),
      shadowCandidateId: parseSc(t.metadataJson),
      assetId: t.assetId,
      side: t.side,
      sideNormalized: normalizeShadowSideForJoin(t.side),
    })),
    recentMlRowsSample: mlRows.slice(0, 40).map((m) => ({
      id: m.id,
      createdAt: m.createdAt.toISOString(),
      shadowCandidateId: m.shadowCandidateId,
      recommendationId: m.recommendationId,
      assetId: m.assetId,
      side: m.side,
      sideNormalized: normalizeShadowSideForJoin(m.side),
      labelGoodDecision12h: m.labelGoodDecision12h,
    })),
    counts: {
      paperRowsScanned: paperCount,
      mlRowsScanned: mlRows.length,
      exactShadowCandidateIdMatch: exactSc,
      exactRecommendationIdMatch: exactRec,
      exactTripleMatch: exactTriple,
      sameAssetSideButDifferentRecommendation: sameAssetSideDiffRec,
      dominantMismatchAfterFix: dominantMismatch,
    },
    note: "Tick persist uses shadowCandidateIds from getSubmittedShadowCandidatesForTick — ML rows should share shadowCandidateId + effective recommendationId with paper metadata for those candidates.",
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(payload, null, 2), "utf8");

  const md = [
    "# Paper ↔ ML identity alignment check",
    "",
    `- Paper scanned: **${paperCount}**, ML scanned: **${mlRows.length}**`,
    `- Exact shadowCandidateId match: **${exactSc}**`,
    `- Exact recommendationId match (any ML row): **${exactRec}**`,
    `- Exact triple match: **${exactTriple}**`,
    `- Same asset+side but no triple (diff rec): **${sameAssetSideDiffRec}**`,
    `- Dominant mismatch: **${dominantMismatch}**`,
    "",
    `JSON: \`${OUT_JSON}\``,
  ].join("\n");
  await fs.writeFile(OUT_MD, md, "utf8");

  const chat = [
    "## Paper–ML identity alignment",
    `- paper: ${paperCount}, ml: ${mlRows.length}`,
    `- exact SC: ${exactSc}, exact rec: ${exactRec}, exact triple: ${exactTriple}`,
    `- same asset/side diff rec: ${sameAssetSideDiffRec}`,
    `- dominant: **${dominantMismatch}**`,
    `- \`dump/paper-ml-identity-alignment-check.{json,md,-chat-summary.md}\``,
  ].join("\n");
  await fs.writeFile(OUT_CHAT, chat, "utf8");

  console.info("[paper-ml-identity-alignment-check]", payload.counts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
