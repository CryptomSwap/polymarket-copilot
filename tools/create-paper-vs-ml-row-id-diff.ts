/**
 * Read-only: compare identities of recent PaperTrade vs MlShadowTrainingExample vs ShadowCandidate.
 * Does not change runtime, ML, schema, or thresholds.
 *
 * Run: npx tsx tools/create-paper-vs-ml-row-id-diff.ts
 * Env: PAPER_VS_ML_PAPER_N (default 50), PAPER_VS_ML_ML_N (default 300)
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizeShadowSideForJoin } from "../lib/shadow-telemetry";
import { parseOpenAttributionFromMetadataJson } from "../lib/paper-trading/paper-trade-open-attribution";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "paper-vs-ml-row-id-diff.json");
const OUT_MD = path.join(DUMP_DIR, "paper-vs-ml-row-id-diff.md");
const OUT_CHAT = path.join(DUMP_DIR, "paper-vs-ml-row-id-diff-chat-summary.md");

const PAPER_N = Math.min(200, Math.max(5, Number(process.env.PAPER_VS_ML_PAPER_N ?? "50") || 50));
const ML_N = Math.min(5000, Math.max(50, Number(process.env.PAPER_VS_ML_ML_N ?? "300") || 300));
const NEARBY_MS = 72 * 60 * 60 * 1000;

function parseRootRecommendationId(metadataJson: string | null): string | null {
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
  } catch {
    // invalid JSON; openAttribution parse may still fail closed
  }
  const attr = parseOpenAttributionFromMetadataJson(metadataJson);
  const sid = attr?.shadowCandidateId ?? attr?.candidateId;
  if (typeof sid === "string" && sid.trim()) return sid.trim();
  return null;
}

function tripleKey(rec: string | null, assetId: string, sideNorm: string): string | null {
  if (!rec) return null;
  return `${rec}\0${assetId}\0${sideNorm}`;
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

function nearestMlRow(
  paper: { entryTime: Date; funderAddress: string | null; assetId: string },
  mlRows: MlRow[]
): MlRow | null {
  const funder = (paper.funderAddress ?? "paper").toLowerCase().trim();
  let best: MlRow | null = null;
  let bestDt = Infinity;
  for (const m of mlRows) {
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

function diffFields(paper: {
  recommendationId: string | null;
  assetId: string;
  sideNorm: string;
  shadowCandidateId: string | null;
}, ml: MlRow): string[] {
  const diffs: string[] = [];
  const mlRec = ml.recommendationId?.trim() ?? null;
  if (paper.recommendationId !== mlRec) diffs.push("recommendationId");
  if (paper.assetId !== ml.assetId) diffs.push("assetId");
  if (paper.sideNorm !== normalizeShadowSideForJoin(ml.side)) diffs.push("side");
  if (paper.shadowCandidateId !== ml.shadowCandidateId) diffs.push("shadowCandidateId");
  return diffs;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const paperTrades = await prisma.paperTrade.findMany({
    orderBy: { entryTime: "desc" },
    take: PAPER_N,
    select: {
      id: true,
      entryTime: true,
      metadataJson: true,
      assetId: true,
      side: true,
      funderAddress: true,
    },
  });

  const mlRowsRaw = await prisma.mlShadowTrainingExample.findMany({
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

  const mlRows: MlRow[] = mlRowsRaw.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    shadowCandidateId: r.shadowCandidateId,
    recommendationId: r.recommendationId,
    assetId: r.assetId,
    side: r.side,
    labelGoodDecision12h: r.labelGoodDecision12h,
    funderAddress: r.funderAddress,
  }));

  const mlByShadowId = new Map(mlRows.map((m) => [m.shadowCandidateId, m]));
  const mlRecSet = new Set(
    mlRows.map((m) => m.recommendationId?.trim()).filter((x): x is string => Boolean(x))
  );
  const mlScSet = new Set(mlRows.map((m) => m.shadowCandidateId));
  const mlTripleSet = new Set<string>();
  for (const m of mlRows) {
    const k = tripleKey(m.recommendationId?.trim() ?? null, m.assetId, normalizeShadowSideForJoin(m.side));
    if (k) mlTripleSet.add(k);
  }

  const sectionA = paperTrades.map((t) => {
    const recommendationId = parseRootRecommendationId(t.metadataJson);
    const shadowCandidateId = parseMetadataShadowCandidateId(t.metadataJson);
    const sideNorm = normalizeShadowSideForJoin(t.side);
    return {
      paperTradeId: t.id,
      entryTime: t.entryTime.toISOString(),
      funderAddress: t.funderAddress,
      metadataRecommendationId: recommendationId,
      assetId: t.assetId,
      sideRaw: t.side,
      sideNormalized: sideNorm,
      shadowCandidateIdFromMetadata: shadowCandidateId,
    };
  });

  const sectionB = mlRows.map((m) => ({
    mlShadowTrainingExampleId: m.id,
    createdAt: m.createdAt.toISOString(),
    shadowCandidateId: m.shadowCandidateId,
    recommendationId: m.recommendationId,
    assetId: m.assetId,
    side: m.side,
    sideNormalized: normalizeShadowSideForJoin(m.side),
    labelGoodDecision12h: m.labelGoodDecision12h,
    funderAddress: m.funderAddress,
  }));

  const paperRecSet = new Set(
    sectionA.map((p) => p.metadataRecommendationId).filter((x): x is string => Boolean(x))
  );
  const paperScSet = new Set(
    sectionA.map((p) => p.shadowCandidateIdFromMetadata).filter((x): x is string => Boolean(x))
  );
  const paperTripleSet = new Set<string>();
  for (const p of sectionA) {
    const k = tripleKey(p.metadataRecommendationId, p.assetId, p.sideNormalized);
    if (k) paperTripleSet.add(k);
  }

  const intersect = <T>(a: Set<T>, b: Set<T>): T[] => [...a].filter((x) => b.has(x));
  const onlyA = <T>(a: Set<T>, b: Set<T>): T[] => [...a].filter((x) => !b.has(x));

  const sectionC = {
    recommendationIds: {
      paperOnly: onlyA(paperRecSet, mlRecSet),
      mlOnly: onlyA(mlRecSet, paperRecSet),
      intersection: intersect(paperRecSet, mlRecSet),
      countPaper: paperRecSet.size,
      countMl: mlRecSet.size,
    },
    shadowCandidateIds: {
      paperOnly: onlyA(paperScSet, mlScSet),
      mlOnly: onlyA(mlScSet, paperScSet),
      intersection: intersect(paperScSet, mlScSet),
      countPaper: paperScSet.size,
      countMl: mlScSet.size,
    },
    triples: {
      paperOnly: onlyA(paperTripleSet, mlTripleSet),
      mlOnly: onlyA(mlTripleSet, paperTripleSet),
      intersection: intersect(paperTripleSet, mlTripleSet),
      countPaper: paperTripleSet.size,
      countMl: mlTripleSet.size,
    },
  };

  let exactShadowCandidateIdMatches = 0;
  let exactRecommendationIdMatches = 0;
  let exactTripleMatches = 0;
  let sameAssetSideDiffRec = 0;
  let sameRecDiffAssetOrSide = 0;
  let noNearbyMlAtAll = 0;

  const mismatchSamples: unknown[] = [];

  for (const p of sectionA) {
    const sc = p.shadowCandidateIdFromMetadata;
    const rec = p.metadataRecommendationId;
    const tk = tripleKey(rec, p.assetId, p.sideNormalized);

    const hasScMatch = sc != null && mlByShadowId.has(sc);
    const hasRecMatch = rec != null && mlRecSet.has(rec);
    const hasTripleMatch = tk != null && mlTripleSet.has(tk);

    if (hasScMatch) exactShadowCandidateIdMatches++;
    if (hasRecMatch) exactRecommendationIdMatches++;
    if (hasTripleMatch) exactTripleMatches++;

    const mlSameAssetSide = mlRows.filter(
      (m) => m.assetId === p.assetId && normalizeShadowSideForJoin(m.side) === p.sideNormalized
    );
    const diffRecSameShape = mlSameAssetSide.some(
      (m) => (m.recommendationId?.trim() ?? "") !== (rec ?? "")
    );
    if (!hasTripleMatch && mlSameAssetSide.length > 0 && diffRecSameShape) sameAssetSideDiffRec++;

    const mlSameRec = rec ? mlRows.filter((m) => (m.recommendationId?.trim() ?? "") === rec) : [];
    const diffAssetSide =
      rec &&
      mlSameRec.some(
        (m) => m.assetId !== p.assetId || normalizeShadowSideForJoin(m.side) !== p.sideNormalized
      );
    if (!hasTripleMatch && mlSameRec.length > 0 && diffAssetSide) sameRecDiffAssetOrSide++;

    const paperForNear = {
      entryTime: new Date(p.entryTime),
      funderAddress: p.funderAddress,
      assetId: p.assetId,
    };
    const nearby = mlRows.filter((m) => {
      const dt = Math.abs(m.createdAt.getTime() - paperForNear.entryTime.getTime());
      return (
        dt <= NEARBY_MS &&
        m.funderAddress.toLowerCase().trim() ===
          (paperForNear.funderAddress ?? "paper").toLowerCase().trim()
      );
    });
    if (!hasTripleMatch && !hasScMatch && nearby.length === 0) noNearbyMlAtAll++;

    if (!hasTripleMatch && mismatchSamples.length < 10) {
      const nearest = nearestMlRow(paperForNear, mlRows);
      mismatchSamples.push({
        paper: {
          paperTradeId: p.paperTradeId,
          entryTime: p.entryTime,
          recommendationId: rec,
          assetId: p.assetId,
          sideNormalized: p.sideNormalized,
          shadowCandidateId: sc,
        },
        nearestMlByFunderAndAsset: nearest
          ? {
              mlShadowTrainingExampleId: nearest.id,
              createdAt: nearest.createdAt.toISOString(),
              shadowCandidateId: nearest.shadowCandidateId,
              recommendationId: nearest.recommendationId,
              assetId: nearest.assetId,
              side: nearest.side,
              sideNormalized: normalizeShadowSideForJoin(nearest.side),
              labelGoodDecision12h: nearest.labelGoodDecision12h,
              timeDeltaMs: Math.abs(nearest.createdAt.getTime() - paperForNear.entryTime.getTime()),
            }
          : null,
        fieldsDiffering: nearest
          ? diffFields(
              {
                recommendationId: rec,
                assetId: p.assetId,
                sideNorm: p.sideNormalized,
                shadowCandidateId: sc,
              },
              nearest
            )
          : ["no_ml_row_same_funder_and_asset"],
      });
    }
  }

  const shadowIdsForLookup = new Set<string>([
    ...[...paperScSet].filter(Boolean),
    ...mlRows.map((m) => m.shadowCandidateId),
  ]);
  const shadowCandidates =
    shadowIdsForLookup.size > 0
      ? await prisma.shadowCandidate.findMany({
          where: { id: { in: [...shadowIdsForLookup] } },
          select: {
            id: true,
            createdAt: true,
            funderAddress: true,
            recommendationId: true,
            assetId: true,
            side: true,
            candidateSource: true,
            wasSubmitted: true,
            wasBlocked: true,
          },
        })
      : [];

  const sectionCohort = {
    paperEntryTimeMin: sectionA.length
      ? sectionA.reduce((a, b) => (a.entryTime < b.entryTime ? a : b)).entryTime
      : null,
    paperEntryTimeMax: sectionA.length
      ? sectionA.reduce((a, b) => (a.entryTime > b.entryTime ? a : b)).entryTime
      : null,
    mlCreatedAtMin: mlRows.length
      ? new Date(Math.min(...mlRows.map((m) => m.createdAt.getTime()))).toISOString()
      : null,
    mlCreatedAtMax: mlRows.length
      ? new Date(Math.max(...mlRows.map((m) => m.createdAt.getTime()))).toISOString()
      : null,
    note: "If paper entryTime range and ML createdAt range barely overlap, mismatch may be wrong cohort window.",
  };

  const mismatchHistogram: Record<string, number> = {
    exact_shadowCandidateId_match: exactShadowCandidateIdMatches,
    exact_recommendationId_match_any_row: exactRecommendationIdMatches,
    exact_triple_match: exactTripleMatches,
    same_asset_side_but_not_triple_diff_rec: sameAssetSideDiffRec,
    same_rec_but_not_triple_diff_asset_or_side: sameRecDiffAssetOrSide,
    no_nearby_ml_same_funder_72h: noNearbyMlAtAll,
  };

  const dominantMismatch = (() => {
    const paperCount = sectionA.length;
    const tripleRate = paperCount ? exactTripleMatches / paperCount : 0;
    if (tripleRate >= 0.8) return "triple_join_mostly_ok_check_edge_cases";
    if (noNearbyMlAtAll >= paperCount * 0.4) return "no_corresponding_ml_rows_near_in_time_or_funder";
    if (sameAssetSideDiffRec >= sameRecDiffAssetOrSide && sameAssetSideDiffRec > paperCount * 0.2) {
      return "recommendationId_basis_mismatch_same_asset_side";
    }
    if (exactShadowCandidateIdMatches < paperCount * 0.3 && paperScSet.size > 0) {
      return "shadow_candidate_id_basis_mismatch";
    }
    if (sectionC.triples.intersection.length === 0 && sectionC.recommendationIds.intersection.length > 0) {
      return "asset_or_side_mismatch_given_some_shared_recommendation_ids";
    }
    return "mixed_or_asset_side_mismatch";
  })();

  const sameCohortLikely =
    sectionCohort.paperEntryTimeMax != null &&
    sectionCohort.mlCreatedAtMax != null &&
    new Date(sectionCohort.paperEntryTimeMin!).getTime() - NEARBY_MS <=
      new Date(sectionCohort.mlCreatedAtMax).getTime() &&
    new Date(sectionCohort.paperEntryTimeMax).getTime() + NEARBY_MS >=
      new Date(sectionCohort.mlCreatedAtMin!).getTime();

  const sectionF = {
    dominantMismatch,
    sameRecentPaperTradeCohortLikely: sameCohortLikely,
    explanation: sameCohortLikely
      ? "Paper entry times and ML createdAt windows overlap in a ~72h sense; rows may still differ on ids if paper points at different ShadowCandidate than persisted ML."
      : "Paper trade times and recent ML createdAt may be disjoint (different windows or delayed persist) — check cohort / job timing.",
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    config: { PAPER_N, ML_N, NEARBY_MS_HOURS: NEARBY_MS / 3600000 },
    sectionA_recentPaperTrades: sectionA,
    sectionB_recentMlRows: sectionB,
    sectionC_exactSetComparisons: sectionC,
    sectionD_matchClassificationCounts: mismatchHistogram,
    sectionE_sampleMismatches: mismatchSamples,
    sectionF_rootCauseSummary: sectionF,
    shadowCandidateRowsReferenced: shadowCandidates.map((s) => ({
      shadowCandidateId: s.id,
      createdAt: s.createdAt.toISOString(),
      funderAddress: s.funderAddress,
      recommendationId: s.recommendationId,
      assetId: s.assetId,
      side: s.side,
      sideNormalized: normalizeShadowSideForJoin(s.side),
      candidateSource: s.candidateSource,
      wasSubmitted: s.wasSubmitted,
      wasBlocked: s.wasBlocked,
    })),
    documentation: {
      paperMetadata:
        "PaperTrade.metadataJson: root recommendationId + shadowCandidateId (optional); openAttribution.shadowCandidateId from lib/paper-trading/paper-trade-open-attribution.ts",
      mlPersist: "lib/ml/shadow-dataset/build.ts persistShadowTrainingExamples",
      joinTriple: "recommendationId + assetId + normalized side (BUY/SELL)",
    },
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(payload, null, 2), "utf8");

  const md = [
    "# Paper vs ML row identity diff (read-only)",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    "## C. Set comparison (counts)",
    `- recommendationIds — paper: ${sectionC.recommendationIds.countPaper}, ml: ${sectionC.recommendationIds.countMl}, intersection: ${sectionC.recommendationIds.intersection.length}`,
    `- shadowCandidateIds — paper: ${sectionC.shadowCandidateIds.countPaper}, ml: ${sectionC.shadowCandidateIds.countMl}, intersection: ${sectionC.shadowCandidateIds.intersection.length}`,
    `- triples — paper: ${sectionC.triples.countPaper}, ml: ${sectionC.triples.countMl}, intersection: ${sectionC.triples.intersection.length}`,
    "",
    "## D. Match classification (paper rows in window)",
    ...Object.entries(mismatchHistogram).map(([k, v]) => `- ${k}: **${v}**`),
    "",
    "## F. Root cause (heuristic)",
    `- **Dominant mismatch:** ${dominantMismatch}`,
    `- **Same cohort likely:** ${sameCohortLikely}`,
    "",
    "## E. Sample mismatches",
    "See JSON `sectionE_sampleMismatches` for 10 examples.",
    "",
    `Full: \`${OUT_JSON}\``,
  ].join("\n");
  await fs.writeFile(OUT_MD, md, "utf8");

  const chat = [
    "## Paper vs ML id diff",
    `- Triple match count (papers in last ${PAPER_N}): **${exactTripleMatches}** / ${sectionA.length}`,
    `- SC id intersection size: **${sectionC.shadowCandidateIds.intersection.length}**`,
    `- Dominant mismatch: **${dominantMismatch}**`,
    `- Same cohort (time overlap): **${sameCohortLikely}**`,
    `- \`dump/paper-vs-ml-row-id-diff.{json,md,-chat-summary.md}\``,
  ].join("\n");
  await fs.writeFile(OUT_CHAT, chat, "utf8");

  console.info("[paper-vs-ml-row-id-diff]", {
    paperTrades: sectionA.length,
    mlRows: mlRows.length,
    tripleIntersection: sectionC.triples.intersection.length,
    dominantMismatch,
    sameCohortLikely,
    outputs: [OUT_JSON, OUT_MD, OUT_CHAT],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
