/**
 * Read-only forensic trace: PaperTrade → ShadowCandidate → MlShadowTrainingExample join keys.
 * Does not change runtime, ML, schema, or training.
 *
 * Run: npx tsx tools/create-live-linkage-trace.ts
 * Env: LIVE_LINKAGE_TRACE_N (default 10)
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import {
  effectiveRecommendationIdForShadowCandidate,
  normalizeShadowSideForJoin,
} from "../lib/shadow-telemetry";
import { parseOpenAttributionFromMetadataJson } from "../lib/paper-trading/paper-trade-open-attribution";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "live-linkage-trace.json");
const OUT_MD = path.join(DUMP_DIR, "live-linkage-trace.md");
const OUT_CHAT = path.join(DUMP_DIR, "live-linkage-trace-chat-summary.md");

const N = Math.min(200, Math.max(1, Number(process.env.LIVE_LINKAGE_TRACE_N ?? "10") || 10));

/** Source-of-truth paths (documentation only; read-only tool). */
const LINEAGE_SOURCE_PATHS = {
  paperCandidateLoad:
    "lib/paper-trading/candidates.ts — getSubmittedShadowCandidatesForPaperTick / loadShadowCandidatesForPaperTick: PaperTradingCandidate.recommendationId = effectiveRecommendationIdForShadowCandidate(r.id, r.recommendationId); side via normalizeShadowSideForJoin.",
  paperOpenMetadata:
    "lib/paper-trading/engine.ts — prisma.paperTrade.create: metadataJson merges recommendationId (base) + openAttribution via mergeOpenAttributionIntoMetadata (lib/paper-trading/paper-trade-open-attribution.ts).",
  shadowTelemetryInsert:
    "lib/shadow-telemetry/record.ts — recordShadowCandidate: explicit id + recommendationId = effectiveRecommendationIdForShadowCandidate(id, input.recommendationId); side normalized.",
  trainingPersist:
    "lib/ml/shadow-dataset/build.ts — buildShadowTrainingRow + persistShadowTrainingExamples: recommendationId and side aligned with effective helpers (same as paper path).",
  joinKeyReports:
    "lib/paper-trading/paper-score-alignment-report.ts — label join: metadata.recommendationId + PaperTrade.assetId + PaperTrade.side → MlShadowTrainingExample.",
} as const;

type DivergenceBucket =
  | "missing_recommendation_id_on_paper_metadata"
  | "no_persisted_shadow_candidate_found"
  | "persisted_candidate_recommendation_id_differs_from_paper_metadata"
  | "training_example_missing_entirely"
  | "training_example_recommendation_id_differs"
  | "training_example_asset_id_differs"
  | "training_example_side_differs"
  | "training_example_exists_should_join"
  | "ambiguous_multiple_candidates";

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

function parseRootShadowCandidateId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const id = o.shadowCandidateId;
    if (typeof id === "string" && id.trim()) return id.trim();
    return null;
  } catch {
    return null;
  }
}

function syntheticIdFromPaperRecommendationId(rec: string | null): string | null {
  if (!rec || !rec.startsWith("shadow:")) return null;
  const rest = rec.slice("shadow:".length).trim();
  return rest || null;
}

function classifyDivergence(args: {
  paperRec: string | null;
  tripleMatchCount: number;
  tripleDistinctShadowIds: string[];
  persistedSc: { id: string; recommendationId: string | null; assetId: string; side: string } | null;
  effectiveOnPersistedSc: string | null;
  examplesByShadowId: Array<{
    id: string;
    shadowCandidateId: string;
    recommendationId: string | null;
    assetId: string;
    side: string;
    labelGoodDecision12h: boolean | null;
    createdAt: string;
  }>;
  paperAssetId: string;
  paperSideNorm: "BUY" | "SELL";
}): DivergenceBucket {
  const {
    paperRec,
    tripleMatchCount,
    tripleDistinctShadowIds,
    persistedSc,
    effectiveOnPersistedSc,
    examplesByShadowId,
    paperAssetId,
    paperSideNorm,
  } = args;

  if (!paperRec) return "missing_recommendation_id_on_paper_metadata";

  if (tripleDistinctShadowIds.length > 1) return "ambiguous_multiple_candidates";

  if (tripleMatchCount >= 1) return "training_example_exists_should_join";

  if (examplesByShadowId.length > 1) return "ambiguous_multiple_candidates";

  if (examplesByShadowId.length === 1) {
    const ex = examplesByShadowId[0]!;
    const exSide = normalizeShadowSideForJoin(ex.side);
    const exRec = ex.recommendationId?.trim() ?? "";
    if (exRec === paperRec && ex.assetId === paperAssetId && exSide === paperSideNorm) {
      return "training_example_exists_should_join";
    }
    if (exRec !== paperRec) {
      return "training_example_recommendation_id_differs";
    }
    if (ex.assetId !== paperAssetId) return "training_example_asset_id_differs";
    if (exSide !== paperSideNorm) return "training_example_side_differs";
    return "training_example_missing_entirely";
  }

  if (!persistedSc) return "no_persisted_shadow_candidate_found";

  if (effectiveOnPersistedSc != null && effectiveOnPersistedSc !== paperRec) {
    return "persisted_candidate_recommendation_id_differs_from_paper_metadata";
  }

  return "training_example_missing_entirely";
}

function firstBrokenStage(bucket: DivergenceBucket): string {
  switch (bucket) {
    case "missing_recommendation_id_on_paper_metadata":
      return "paper_trade_metadata (recommendationId absent)";
    case "no_persisted_shadow_candidate_found":
      return "shadow_candidate_table (no row for metadata/synthetic id)";
    case "persisted_candidate_recommendation_id_differs_from_paper_metadata":
      return "shadow_candidate_row.recommendationId vs paper metadata effective key";
    case "training_example_exists_should_join":
      return "none (triple join key aligns)";
    case "ambiguous_multiple_candidates":
      return "ambiguous (multiple ML or SC resolution paths)";
    case "training_example_recommendation_id_differs":
    case "training_example_asset_id_differs":
    case "training_example_side_differs":
      return "ml_shadow_training_example (row exists for shadowCandidateId but join key mismatch)";
    case "training_example_missing_entirely":
      return "ml_shadow_training_example (no row for triple / shadowCandidateId)";
    default:
      return "unknown";
  }
}

function nextFixReadOnly(bucket: DivergenceBucket): { file: string; why: string } {
  switch (bucket) {
    case "missing_recommendation_id_on_paper_metadata":
      return {
        file: "lib/paper-trading/engine.ts (metadata base) + lib/paper-trading/candidates.ts",
        why: "Ensure recommendationId is always written into metadataJson at open when running a fix pass; trace shows root key missing.",
      };
    case "no_persisted_shadow_candidate_found":
      return {
        file: "lib/shadow-telemetry/record.ts + worker/stream-runtime.ts (telemetry emitters)",
        why: "Paper trade references a shadow candidate id or synthetic key with no ShadowCandidate row — trace ingestion or id wiring at source.",
      };
    case "persisted_candidate_recommendation_id_differs_from_paper_metadata":
      return {
        file: "lib/shadow-telemetry/record.ts + lib/ml/shadow-dataset/build.ts",
        why: "Persisted ShadowCandidate effective recommendationId must match paper metadata (same effectiveRecommendationIdForShadowCandidate rule).",
      };
    case "training_example_recommendation_id_differs":
    case "training_example_asset_id_differs":
    case "training_example_side_differs":
    case "training_example_missing_entirely":
      return {
        file: "lib/ml/shadow-dataset/build.ts (buildShadowTrainingRow / persistShadowTrainingExamples) + ops persist job",
        why: "Training row must mirror paper triple; run or verify persistShadowTrainingExamples after linkage fixes.",
      };
    case "training_example_exists_should_join":
      return {
        file: "(none — read-only trace shows join key OK; investigate labels downstream if needed)",
        why: "Triple matches; if labels still null, problem is labeling horizon or evaluation timing, not join key.",
      };
    case "ambiguous_multiple_candidates":
      return {
        file: "lib/paper-trading/engine.ts (dedupeKey / admission) + lib/ml/shadow-dataset/build.ts",
        why: "Resolve duplicate shadow or ML rows for the same logical open; narrow to single canonical shadowCandidateId per paper open.",
      };
    default:
      return { file: "(see trace JSON)", why: "Inspect per-trade raw IDs in dump/live-linkage-trace.json." };
  }
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const trades = await prisma.paperTrade.findMany({
    orderBy: { entryTime: "desc" },
    take: N,
    select: {
      id: true,
      createdAt: true,
      entryTime: true,
      botType: true,
      assetId: true,
      side: true,
      funderAddress: true,
      metadataJson: true,
    },
  });

  const perTrade: unknown[] = [];
  const bucketCounts: Record<DivergenceBucket, number> = {
    missing_recommendation_id_on_paper_metadata: 0,
    no_persisted_shadow_candidate_found: 0,
    persisted_candidate_recommendation_id_differs_from_paper_metadata: 0,
    training_example_missing_entirely: 0,
    training_example_recommendation_id_differs: 0,
    training_example_asset_id_differs: 0,
    training_example_side_differs: 0,
    training_example_exists_should_join: 0,
    ambiguous_multiple_candidates: 0,
  };

  let foundSc = 0;
  let foundTrainingAnyStrategy = 0;
  let shouldJoinCount = 0;

  for (const t of trades) {
    const paperRec = parseRootRecommendationId(t.metadataJson);
    const rootScId = parseRootShadowCandidateId(t.metadataJson);
    const attr = parseOpenAttributionFromMetadataJson(t.metadataJson);
    const attrScId = attr?.shadowCandidateId ?? attr?.candidateId ?? null;
    const metadataShadowCandidateId = rootScId ?? attrScId;
    const hasCalibrationBlock = attr?.paperShadowScoreCalibration != null;
    const paperSideNorm = normalizeShadowSideForJoin(t.side);
    const syntheticScId = syntheticIdFromPaperRecommendationId(paperRec);

    let persistedSc: {
      id: string;
      recommendationId: string | null;
      assetId: string;
      side: string;
      createdAt: Date;
      candidateSource: string;
    } | null = null;
    let scLookupPath: string | null = null;

    if (metadataShadowCandidateId) {
      const row = await prisma.shadowCandidate.findUnique({
        where: { id: metadataShadowCandidateId },
        select: {
          id: true,
          recommendationId: true,
          assetId: true,
          side: true,
          createdAt: true,
          candidateSource: true,
        },
      });
      if (row) {
        persistedSc = row;
        scLookupPath = "metadata.shadowCandidateId or openAttribution.shadowCandidateId";
      }
    }
    if (!persistedSc && syntheticScId) {
      const row = await prisma.shadowCandidate.findUnique({
        where: { id: syntheticScId },
        select: {
          id: true,
          recommendationId: true,
          assetId: true,
          side: true,
          createdAt: true,
          candidateSource: true,
        },
      });
      if (row) {
        persistedSc = row;
        scLookupPath = "parsed paper metadata.recommendationId shadow:<ShadowCandidate.id>";
      }
    }

    if (persistedSc) foundSc++;

    const effectiveOnPersistedSc = persistedSc
      ? effectiveRecommendationIdForShadowCandidate(persistedSc.id, persistedSc.recommendationId)
      : null;

    const upstreamRecOnSc = persistedSc?.recommendationId ?? null;

    const byTripleExact =
      paperRec != null
        ? await prisma.mlShadowTrainingExample.findMany({
            where: {
              recommendationId: paperRec,
              assetId: t.assetId,
              side: paperSideNorm,
            },
            select: {
              id: true,
              shadowCandidateId: true,
              recommendationId: true,
              assetId: true,
              side: true,
              labelGoodDecision12h: true,
              createdAt: true,
            },
          })
        : [];

    const byTripleSideRaw =
      paperRec != null
        ? await prisma.mlShadowTrainingExample.findMany({
            where: {
              recommendationId: paperRec,
              assetId: t.assetId,
              side: t.side,
            },
            select: { id: true, side: true },
          })
        : [];

    const shadowIdsToTry = [...new Set([metadataShadowCandidateId, syntheticScId].filter(Boolean) as string[])];
    const byShadowCandidateId =
      shadowIdsToTry.length > 0
        ? await prisma.mlShadowTrainingExample.findMany({
            where: { shadowCandidateId: { in: shadowIdsToTry } },
            select: {
              id: true,
              shadowCandidateId: true,
              recommendationId: true,
              assetId: true,
              side: true,
              labelGoodDecision12h: true,
              createdAt: true,
            },
          })
        : [];

    const funderNorm = (t.funderAddress ?? "paper").toLowerCase().trim();
    const windowStart = new Date(t.entryTime.getTime() - 3 * 60 * 60 * 1000);
    const windowEnd = new Date(t.entryTime.getTime() + 60 * 60 * 1000);
    const nearestFallback = await prisma.mlShadowTrainingExample.findMany({
      where: {
        funderAddress: funderNorm,
        assetId: t.assetId,
        side: paperSideNorm,
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      orderBy: { createdAt: "asc" },
      take: 5,
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

    const tripleDistinctShadowIds = [...new Set(byTripleExact.map((r) => r.shadowCandidateId))];
    const tripleMatchCount = byTripleExact.length;

    if (byTripleExact.length > 0 || byShadowCandidateId.length > 0 || nearestFallback.length > 0) {
      foundTrainingAnyStrategy++;
    }
    if (tripleMatchCount >= 1) shouldJoinCount++;

    const examplesByShadowIdForClassify = byShadowCandidateId.map((r) => ({
      id: r.id,
      shadowCandidateId: r.shadowCandidateId,
      recommendationId: r.recommendationId,
      assetId: r.assetId,
      side: r.side,
      labelGoodDecision12h: r.labelGoodDecision12h,
      createdAt: r.createdAt.toISOString(),
    }));

    const bucket = classifyDivergence({
      paperRec,
      tripleMatchCount,
      tripleDistinctShadowIds,
      persistedSc: persistedSc
        ? {
            id: persistedSc.id,
            recommendationId: persistedSc.recommendationId,
            assetId: persistedSc.assetId,
            side: persistedSc.side,
          }
        : null,
      effectiveOnPersistedSc,
      examplesByShadowId: examplesByShadowIdForClassify,
      paperAssetId: t.assetId,
      paperSideNorm,
    });
    bucketCounts[bucket]++;

    perTrade.push({
      sectionA_paperTrade: {
        tradeId: t.id,
        createdAt: t.createdAt.toISOString(),
        entryTime: t.entryTime.toISOString(),
        botType: t.botType,
        funderAddress: t.funderAddress,
        assetId: t.assetId,
        sideRaw: t.side,
        sideNormalized: paperSideNorm,
        metadataRecommendationId: paperRec,
        hasOpenAttributionCalibrationBlock: hasCalibrationBlock,
        metadataRootShadowCandidateId: rootScId,
        openAttributionShadowCandidateId: attrScId,
        resolvedMetadataShadowCandidateId: metadataShadowCandidateId,
      },
      sectionB_candidateSourceTrace: {
        documentation:
          "Paper opens from PaperTradingCandidate built in lib/paper-trading/candidates.ts from ShadowCandidate DB rows; engine passes c.recommendationId and c.shadowCandidateId into metadata (lib/paper-trading/engine.ts).",
        candidateIdFromMetadata: metadataShadowCandidateId,
        upstreamRecommendationIdOnPersistedShadowCandidate: upstreamRecOnSc,
        effectiveRecommendationIdOnPersistedShadowCandidate: effectiveOnPersistedSc,
        effectiveRecommendationIdStoredOnPaperMetadata: paperRec,
        persistedShadowCandidateLookupPath: scLookupPath,
        persistedShadowCandidateFound: persistedSc != null,
        persistedShadowCandidateRow: persistedSc
          ? {
              id: persistedSc.id,
              recommendationIdRaw: persistedSc.recommendationId,
              assetId: persistedSc.assetId,
              sideRaw: persistedSc.side,
              sideNormalized: normalizeShadowSideForJoin(persistedSc.side),
              candidateSource: persistedSc.candidateSource,
              createdAt: persistedSc.createdAt.toISOString(),
            }
          : null,
        paperVersusPersistedSc: {
          recommendationIdPaperMetadataVsEffectiveOnSc:
            paperRec != null && effectiveOnPersistedSc != null
              ? paperRec === effectiveOnPersistedSc
                ? "match"
                : "diverge"
              : "n/a",
          assetIdMatch: persistedSc ? persistedSc.assetId === t.assetId : null,
          sideNormalizedMatch: persistedSc
            ? normalizeShadowSideForJoin(persistedSc.side) === paperSideNorm
            : null,
        },
      },
      sectionC_trainingExampleTrace: {
        countByStrategy: {
          byTriple_recommendationId_assetId_sideNormalized: byTripleExact.length,
          byTriple_sameRecAsset_sideRawPaperColumn: byTripleSideRaw.length,
          byShadowCandidateId_in_metadata_or_synthetic: byShadowCandidateId.length,
          nearestTimeFunderAssetSideNormalized_3hBefore_1hAfter: nearestFallback.length,
        },
        tripleExactRows: byTripleExact.map((r) => ({
          id: r.id,
          shadowCandidateId: r.shadowCandidateId,
          recommendationId: r.recommendationId,
          assetId: r.assetId,
          side: r.side,
          sideNormalized: normalizeShadowSideForJoin(r.side),
          labelGoodDecision12h: r.labelGoodDecision12h,
          createdAt: r.createdAt.toISOString(),
          shouldMatchThisPaperTriple:
            r.recommendationId === paperRec &&
            r.assetId === t.assetId &&
            normalizeShadowSideForJoin(r.side) === paperSideNorm,
        })),
        byShadowCandidateIdRows: byShadowCandidateId.map((r) => ({
          id: r.id,
          shadowCandidateId: r.shadowCandidateId,
          recommendationId: r.recommendationId,
          assetId: r.assetId,
          side: r.side,
          labelGoodDecision12h: r.labelGoodDecision12h,
          createdAt: r.createdAt.toISOString(),
        })),
        nearestTimeFallbackRows: nearestFallback.map((r) => ({
          id: r.id,
          shadowCandidateId: r.shadowCandidateId,
          recommendationId: r.recommendationId,
          createdAt: r.createdAt.toISOString(),
          note: "diagnostic only — not authoritative join",
        })),
      },
      sectionD_divergence: {
        bucket,
        firstBrokenStage: firstBrokenStage(bucket),
        fieldsCompared: {
          joinTriple: {
            recommendationId: paperRec,
            assetId: t.assetId,
            sideNormalized: paperSideNorm,
          },
        },
      },
    });
  }

  const dominantBucket = (Object.entries(bucketCounts) as [DivergenceBucket, number][]).sort(
    (a, b) => b[1] - a[1]
  )[0]![0];

  const sectionE = {
    paperTradesTraced: trades.length,
    persistedShadowCandidateFoundCount: foundSc,
    trainingExampleFoundByAnyStrategyCount: foundTrainingAnyStrategy,
    tripleJoinShouldMatchCount: shouldJoinCount,
    bucketCounts,
    dominantDivergenceBucket: dominantBucket,
    dominantFirstBrokenStage: firstBrokenStage(dominantBucket),
    lineageSourcePaths: LINEAGE_SOURCE_PATHS,
  };

  const sectionF = {
    readOnlyNextFix: nextFixReadOnly(dominantBucket),
    note: "Recommendations are read-only; do not apply from this tool automatically.",
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    config: { LIVE_LINKAGE_TRACE_N: N },
    sectionE_rootCauseSummary: sectionE,
    sectionF_minimalNextFix: sectionF,
    trades: perTrade,
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(payload, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Live paper-trade linkage trace (read-only)");
  md.push("");
  md.push(`Generated: ${payload.generatedAt}`);
  md.push(`Trades: ${trades.length} (LIVE_LINKAGE_TRACE_N=${N})`);
  md.push("");
  md.push("## E. Root-cause summary");
  md.push(`- Persisted ShadowCandidate found: **${foundSc}** / ${trades.length}`);
  md.push(`- Training row hit (any strategy): **${foundTrainingAnyStrategy}** / ${trades.length}`);
  md.push(`- Triple join should match: **${shouldJoinCount}** / ${trades.length}`);
  md.push(`- Dominant bucket: **${dominantBucket}**`);
  md.push(`- First broken stage (mode): **${firstBrokenStage(dominantBucket)}**`);
  md.push("");
  md.push("### Bucket counts");
  for (const [k, v] of Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])) {
    md.push(`- ${k}: ${v}`);
  }
  md.push("");
  md.push("## F. Next fix (read-only)");
  md.push(`- **File/path:** ${sectionF.readOnlyNextFix.file}`);
  md.push(`- **Why:** ${sectionF.readOnlyNextFix.why}`);
  md.push("");
  md.push("## Per-trade buckets");
  for (let i = 0; i < perTrade.length; i++) {
    const row = perTrade[i] as {
      sectionA_paperTrade: { tradeId: string; metadataRecommendationId: string | null };
      sectionD_divergence: { bucket: string; firstBrokenStage: string };
    };
    md.push(
      `- ${row.sectionA_paperTrade.tradeId.slice(0, 12)}… | rec=${row.sectionA_paperTrade.metadataRecommendationId ?? "∅"} | **${row.sectionD_divergence.bucket}**`
    );
  }
  md.push("");
  md.push("Full JSON: `dump/live-linkage-trace.json`");

  await fs.writeFile(OUT_MD, md.join("\n"), "utf8");

  const chat: string[] = [];
  chat.push("## Live linkage trace (paste)");
  chat.push(`- Traced **${trades.length}** paper trades`);
  chat.push(`- Persisted ShadowCandidate: **${foundSc}**`);
  chat.push(`- ML example (any strategy): **${foundTrainingAnyStrategy}**`);
  chat.push(`- Triple join OK: **${shouldJoinCount}**`);
  chat.push(`- Dominant bucket: **${dominantBucket}**`);
  chat.push(`- First broken stage (mode): **${firstBrokenStage(dominantBucket)}**`);
  chat.push(`- Next fix hint: ${sectionF.readOnlyNextFix.file} — ${sectionF.readOnlyNextFix.why}`);
  chat.push(`- Files: \`dump/live-linkage-trace.json\`, \`.md\`, \`-chat-summary.md\``);

  await fs.writeFile(OUT_CHAT, chat.join("\n"), "utf8");

  console.log("[live-linkage-trace]", {
    paperTradesTraced: trades.length,
    persistedShadowCandidateFound: foundSc,
    trainingExampleFoundAnyStrategy: foundTrainingAnyStrategy,
    tripleJoinShouldMatch: shouldJoinCount,
    dominantDivergenceBucket: dominantBucket,
    outputs: [OUT_JSON, OUT_MD, OUT_CHAT],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
