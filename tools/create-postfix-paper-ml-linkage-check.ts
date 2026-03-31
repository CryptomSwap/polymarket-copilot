/**
 * Post-fix-only paper ↔ ML linkage validation (read-only).
 * Requires POSTFIX_LINKAGE_AFTER=ISO timestamp; only PaperTrade.entryTime >= cutoff
 * and MlShadowTrainingExample.createdAt >= cutoff are considered.
 *
 * Run: POSTFIX_LINKAGE_AFTER=2025-03-20T12:00:00.000Z npx tsx tools/create-postfix-paper-ml-linkage-check.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizeShadowSideForJoin } from "../lib/shadow-telemetry";
import { parseOpenAttributionFromMetadataJson } from "../lib/paper-trading/paper-trade-open-attribution";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "postfix-paper-ml-linkage-check.json");
const OUT_MD = path.join(DUMP_DIR, "postfix-paper-ml-linkage-check.md");
const OUT_CHAT = path.join(DUMP_DIR, "postfix-paper-ml-linkage-check-chat-summary.md");

const AFTER_RAW = process.env.POSTFIX_LINKAGE_AFTER?.trim();
const PAPER_N = Math.min(2000, Math.max(1, Number(process.env.POSTFIX_LINKAGE_PAPER_N ?? "100") || 100));
const ML_N = Math.min(10000, Math.max(50, Number(process.env.POSTFIX_LINKAGE_ML_N ?? "500") || 500));

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

type MlRow = {
  id: string;
  createdAt: Date;
  shadowCandidateId: string;
  recommendationId: string | null;
  assetId: string;
  side: string;
  labelGoodDecision12h: boolean | null;
  funderAddress: string;
};

function tripleMatch(ml: MlRow, rec: string, assetId: string, sideN: "BUY" | "SELL"): boolean {
  return (
    (ml.recommendationId?.trim() ?? "") === rec &&
    ml.assetId === assetId &&
    normalizeShadowSideForJoin(ml.side) === sideN
  );
}

function nearestMlInPool(
  paper: { entryTime: Date; funderAddress: string | null; assetId: string },
  pool: MlRow[]
): MlRow | null {
  const funder = (paper.funderAddress ?? "paper").toLowerCase().trim();
  let best: MlRow | null = null;
  let bestDt = Infinity;
  for (const m of pool) {
    if (m.funderAddress.toLowerCase().trim() !== funder) continue;
    if (m.assetId !== paper.assetId) continue;
    const dt = Math.abs(m.createdAt.getTime() - paper.entryTime.getTime());
    if (dt < bestDt) {
      bestDt = dt;
      best = m;
    }
  }
  return best;
}

function diffFields(
  paper: { rec: string | null; sc: string | null; assetId: string; sideN: "BUY" | "SELL" },
  ml: MlRow
): string[] {
  const d: string[] = [];
  const mlR = ml.recommendationId?.trim() ?? null;
  if (paper.rec !== mlR) d.push("recommendationId");
  if (paper.assetId !== ml.assetId) d.push("assetId");
  if (paper.sideN !== normalizeShadowSideForJoin(ml.side)) d.push("side");
  if (paper.sc !== ml.shadowCandidateId) d.push("shadowCandidateId");
  return d;
}

async function main(): Promise<void> {
  if (!AFTER_RAW) {
    console.error(
      "POSTFIX_LINKAGE_AFTER is required (ISO-8601), e.g. POSTFIX_LINKAGE_AFTER=2025-03-20T12:00:00.000Z"
    );
    process.exit(1);
  }
  const cutoff = new Date(AFTER_RAW);
  if (Number.isNaN(cutoff.getTime())) {
    console.error("POSTFIX_LINKAGE_AFTER is not a valid ISO date:", AFTER_RAW);
    process.exit(1);
  }

  await fs.mkdir(DUMP_DIR, { recursive: true });

  const paperTrades = await prisma.paperTrade.findMany({
    where: { entryTime: { gte: cutoff } },
    orderBy: { entryTime: "desc" },
    take: PAPER_N,
    select: {
      id: true,
      entryTime: true,
      createdAt: true,
      metadataJson: true,
      assetId: true,
      side: true,
      funderAddress: true,
    },
  });

  const mlRowsRaw = await prisma.mlShadowTrainingExample.findMany({
    where: { createdAt: { gte: cutoff } },
    orderBy: { createdAt: "desc" },
    take: ML_N,
    select: {
      id: true,
      createdAt: true,
      shadowCandidateId: true,
      recommendationId: true,
      assetId: true,
      side: true,
      labelGoodDecision12h: true,
      funderAddress: true,
    },
  });

  const mlPool: MlRow[] = mlRowsRaw.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    shadowCandidateId: r.shadowCandidateId,
    recommendationId: r.recommendationId,
    assetId: r.assetId,
    side: r.side,
    labelGoodDecision12h: r.labelGoodDecision12h,
    funderAddress: r.funderAddress,
  }));

  const mlScSet = new Set(mlPool.map((m) => m.shadowCandidateId));
  const mlRecSet = new Set(mlPool.map((m) => m.recommendationId?.trim()).filter((x): x is string => Boolean(x)));

  let tradesWithRecommendationIdInMetadata = 0;
  let tradesJoinedToTrainingExample = 0;
  let tradesWithNonNullLabelGoodDecision12h = 0;
  let exactShadowCandidateIdMatch = 0;
  let exactRecommendationIdMatch = 0;
  let exactTripleMatch = 0;
  let sameAssetSideButDifferentRecommendation = 0;

  const sampleMatched: unknown[] = [];
  const sampleUnmatched: unknown[] = [];

  const paperTimes = paperTrades.map((p) => p.entryTime.getTime());
  const mlTimes = mlPool.map((m) => m.createdAt.getTime());

  for (const t of paperTrades) {
    const rec = parseRec(t.metadataJson);
    const sc = parseSc(t.metadataJson);
    const sideN = normalizeShadowSideForJoin(t.side);

    if (rec) tradesWithRecommendationIdInMetadata++;

    if (sc && mlScSet.has(sc)) exactShadowCandidateIdMatch++;
    if (rec && mlRecSet.has(rec)) exactRecommendationIdMatch++;

    const tripleHits = rec
      ? mlPool.filter((m) => tripleMatch(m, rec, t.assetId, sideN))
      : [];
    if (tripleHits.length > 0) {
      exactTripleMatch++;
      if (sampleMatched.length < 10) {
        const pick = tripleHits[0]!;
        sampleMatched.push({
          paperTradeId: t.id,
          entryTime: t.entryTime.toISOString(),
          recommendationId: rec,
          shadowCandidateId: sc,
          assetId: t.assetId,
          sideNormalized: sideN,
          matchedMlId: pick.id,
          mlCreatedAt: pick.createdAt.toISOString(),
          mlShadowCandidateId: pick.shadowCandidateId,
          mlRecommendationId: pick.recommendationId,
          labelGoodDecision12h: pick.labelGoodDecision12h,
        });
      }
    } else {
      if (rec) {
        const sameShape = mlPool.some(
          (m) => m.assetId === t.assetId && normalizeShadowSideForJoin(m.side) === sideN
        );
        if (sameShape) sameAssetSideButDifferentRecommendation++;
      }
      if (sampleUnmatched.length < 10) {
        const nearest = nearestMlInPool(
          { entryTime: t.entryTime, funderAddress: t.funderAddress, assetId: t.assetId },
          mlPool
        );
        sampleUnmatched.push({
          paperTradeId: t.id,
          entryTime: t.entryTime.toISOString(),
          recommendationId: rec,
          shadowCandidateId: sc,
          assetId: t.assetId,
          sideNormalized: sideN,
          nearestMlInPostfixPool: nearest
            ? {
                id: nearest.id,
                createdAt: nearest.createdAt.toISOString(),
                shadowCandidateId: nearest.shadowCandidateId,
                recommendationId: nearest.recommendationId,
                assetId: nearest.assetId,
                side: nearest.side,
                labelGoodDecision12h: nearest.labelGoodDecision12h,
                timeDeltaMs: Math.abs(nearest.createdAt.getTime() - t.entryTime.getTime()),
                fieldsDifferingFromPaper: diffFields(
                  { rec, sc, assetId: t.assetId, sideN },
                  nearest
                ),
              }
            : null,
        });
      }
    }

    if (rec && tripleHits.length > 0) {
      tradesJoinedToTrainingExample++;
      if (tripleHits.some((m) => m.labelGoodDecision12h !== null)) {
        tradesWithNonNullLabelGoodDecision12h++;
      }
    }
  }

  const nPaper = paperTrades.length;
  const pct = (a: number, b: number) => (b === 0 ? 0 : Number(((100 * a) / b).toFixed(2)));

  const dominantMismatchAfterFix = (() => {
    if (nPaper === 0) return "no_paper_in_scope";
    const trRate = exactTripleMatch / nPaper;
    if (trRate >= 0.9) return "triple_aligned";
    if (sameAssetSideButDifferentRecommendation / nPaper > 0.2) {
      return "recommendationId_basis_mismatch_same_asset_side";
    }
    if (exactShadowCandidateIdMatch / nPaper < 0.25 && nPaper > 5) return "shadow_candidate_id_mismatch";
    return "mixed_or_insufficient_label";
  })();

  const forwardPathWorking =
    nPaper > 0 &&
    tradesWithRecommendationIdInMetadata > 0 &&
    pct(tradesJoinedToTrainingExample, tradesWithRecommendationIdInMetadata) >= 70;

  const sectionA = {
    cutoffTimestampUsed: cutoff.toISOString(),
    cutoffEnvRaw: AFTER_RAW,
    paperRowsScannedAfterCutoff: nPaper,
    mlRowsScannedAfterCutoff: mlPool.length,
    paperEntryTimeEarliest:
      paperTimes.length > 0 ? new Date(Math.min(...paperTimes)).toISOString() : null,
    paperEntryTimeLatest:
      paperTimes.length > 0 ? new Date(Math.max(...paperTimes)).toISOString() : null,
    mlCreatedAtEarliest: mlTimes.length > 0 ? new Date(Math.min(...mlTimes)).toISOString() : null,
    mlCreatedAtLatest: mlTimes.length > 0 ? new Date(Math.max(...mlTimes)).toISOString() : null,
    paperFilter: "PaperTrade.entryTime >= cutoff",
    mlFilter: "MlShadowTrainingExample.createdAt >= cutoff",
  };

  const sectionB = {
    tradesWithRecommendationIdInMetadata,
    tradesJoinedToTrainingExample,
    tradesWithNonNullLabelGoodDecision12h,
    pctPaperTradesJoinedToExample: pct(tradesJoinedToTrainingExample, nPaper),
    pctPaperTradesWithNonNullLabel12h: pct(tradesWithNonNullLabelGoodDecision12h, nPaper),
    note: "Joined = post-fix ML pool has row matching recommendationId + assetId + normalized side (same as recommendation-linkage-check).",
  };

  const sectionC = {
    exactShadowCandidateIdMatch,
    exactRecommendationIdMatch,
    exactTripleMatch,
    sameAssetSideButDifferentRecommendation,
    dominantMismatchAfterFix,
  };

  const sectionF = {
    forwardPathWorking,
    legacyContaminationExcluded: true,
    explanation:
      "Only trades with entryTime >= POSTFIX_LINKAGE_AFTER and ML examples with createdAt >= same cutoff are used; pre-fix rows are excluded from both cohorts. Join/label checks search matches only within the post-fix ML pool.",
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    env: { POSTFIX_LINKAGE_AFTER: AFTER_RAW, POSTFIX_LINKAGE_PAPER_N: PAPER_N, POSTFIX_LINKAGE_ML_N: ML_N },
    sectionA_scope: sectionA,
    sectionB_linkage: sectionB,
    sectionC_identityAlignment: sectionC,
    sectionD_sampleMatchedRows: sampleMatched,
    sectionE_sampleUnmatchedRows: sampleUnmatched,
    sectionF_interpretation: sectionF,
    pasteBackIntoChat: "dump/postfix-paper-ml-linkage-check-chat-summary.md (or JSON sectionB/C/F for metrics)",
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(payload, null, 2), "utf8");

  const md = [
    "# Post-fix paper ↔ ML linkage check",
    "",
    `**Cutoff:** \`${sectionA.cutoffTimestampUsed}\``,
    "",
    "## A. Scope",
    `- Paper after cutoff: **${sectionA.paperRowsScannedAfterCutoff}** (entryTime)`,
    `- ML after cutoff: **${sectionA.mlRowsScannedAfterCutoff}** (createdAt)`,
    `- Paper entryTime range: ${sectionA.paperEntryTimeEarliest ?? "—"} → ${sectionA.paperEntryTimeLatest ?? "—"}`,
    `- ML createdAt range: ${sectionA.mlCreatedAtEarliest ?? "—"} → ${sectionA.mlCreatedAtLatest ?? "—"}`,
    "",
    "## B. Linkage",
    `- With metadata recommendationId: **${tradesWithRecommendationIdInMetadata}**`,
    `- Joined to post-fix training row (triple): **${tradesJoinedToTrainingExample}** (${sectionB.pctPaperTradesJoinedToExample}% of papers in scope)`,
    `- Non-null labelGoodDecision12h: **${tradesWithNonNullLabelGoodDecision12h}** (${sectionB.pctPaperTradesWithNonNullLabel12h}% of papers in scope)`,
    "",
    "## C. Identity",
    ...Object.entries(sectionC).map(([k, v]) => `- ${k}: **${v}**`),
    "",
    "## F. Interpretation",
    `- forwardPathWorking: **${forwardPathWorking}**`,
    `- legacyContaminationExcluded: **true**`,
    `- ${sectionF.explanation}`,
    "",
    `Full JSON: \`${OUT_JSON}\``,
  ].join("\n");
  await fs.writeFile(OUT_MD, md, "utf8");

  const chat = [
    "## Post-fix paper ↔ ML linkage",
    `- Cutoff: \`${sectionA.cutoffTimestampUsed}\``,
    `- Paper in scope: **${nPaper}**, ML in scope: **${mlPool.length}**`,
    `- Exact triple (paper vs post-fix ML pool): **${exactTripleMatch}**`,
    `- Joined % (of all papers in scope): **${sectionB.pctPaperTradesJoinedToExample}%**`,
    `- Label12h % (of papers in scope): **${sectionB.pctPaperTradesWithNonNullLabel12h}%**`,
    `- Dominant mismatch: **${dominantMismatchAfterFix}**`,
    `- Files: \`dump/postfix-paper-ml-linkage-check.{json,md,-chat-summary.md}\``,
  ].join("\n");
  await fs.writeFile(OUT_CHAT, chat, "utf8");

  console.info("[postfix-paper-ml-linkage-check]", {
    cutoff: sectionA.cutoffTimestampUsed,
    paperRowsScanned: nPaper,
    mlRowsScanned: mlPool.length,
    exactTripleMatches: exactTripleMatch,
    pctPaperTradesJoinedToExample: sectionB.pctPaperTradesJoinedToExample,
    pctPaperTradesWithNonNullLabel12h: sectionB.pctPaperTradesWithNonNullLabel12h,
    dominantMismatch: dominantMismatchAfterFix,
    outputs: [OUT_JSON, OUT_MD, OUT_CHAT],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
