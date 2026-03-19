/**
 * Shadow label pipeline debugger: find why PaperTrades do not resolve to labels.
 * Inspects PaperTrade, MlShadowTrainingExample, recommendationId joins, assetId+side, 12h label.
 * Read-only; no ML or runtime behavior change.
 */

import { prisma } from "@/lib/db";

const DEFAULT_LOOKBACK_DAYS = 90;

function parseRecommendationId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const id = o.recommendationId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

export interface ShadowLabelPipelineDebugResult {
  generatedAt: string;
  lookbackDays: number;
  paperTrade: {
    total: number;
    withRecommendationId: number;
    withoutRecommendationId: number;
    pctMissingRecommendationId: number;
    pctWithRecommendationId: number;
  };
  mlShadowTrainingExample: {
    total: number;
    withRecommendationId: number;
    withRecommendationIdNullLabel: number;
    withRecommendationIdWithLabel: number;
    pctWithRecommendationId: number;
    pctExamplesWithNullLabel: number; // among those with recId
    pctExamplesWithLabel: number;
  };
  join: {
    /** PaperTrades with no recommendationId in metadataJson → cannot join */
    noKey: number;
    /** PaperTrades with recId but no matching MlShadowTrainingExample */
    joinFailureNoExample: number;
    /** PaperTrades with matching example(s) but all have labelGoodDecision12h null */
    matchedNullLabel: number;
    /** PaperTrades with at least one matching example with non-null label */
    matchedWithLabel: number;
    pctMissingExamples: number;   // (noKey + joinFailureNoExample) / total
    pctJoinFailures: number;     // same as above for PaperTrades
    pctExamplesWithNullLabel: number; // matchedNullLabel / (matchedNullLabel + matchedWithLabel) or 0
    pctResolvedWithLabel: number;
  };
  priceSnapshots: {
    /** Total MarketPriceSnapshot rows in lookback window (for context) */
    totalSnapshots: number;
    /** Distinct (marketId, assetId) with at least one snapshot in window */
    distinctMarketAssetWithSnapshot: number;
    /** Among MlShadowTrainingExample with recId but null label: count (for "likely missing 12h snapshot") */
    examplesWithRecIdButNullLabel: number;
    pctMissingPriceSnapshots: number | null; // heuristic: examplesWithRecIdButNullLabel / withRecommendationId, or null
  };
  sampleJoinFailures: Array<{
    paperTradeId: string;
    assetId: string;
    side: string;
    recommendationId: string | null;
    reason: "no_recommendation_id" | "no_matching_example";
  }>;
  sampleMatchedNullLabel: Array<{
    paperTradeId: string;
    key: string;
    exampleId: string;
    exampleRecommendationId: string | null;
    exampleLabelGoodDecision12h: boolean | null;
  }>;
  caveats: string[];
}

export async function runShadowLabelPipelineDebug(options?: {
  lookbackDays?: number;
  sampleSize?: number;
}): Promise<ShadowLabelPipelineDebugResult> {
  const lookbackDays = options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const sampleSize = options?.sampleSize ?? 20;
  const from = new Date();
  from.setDate(from.getDate() - lookbackDays);

  const caveats: string[] = [
    "Join key is (recommendationId, assetId, side). recommendationId on PaperTrade comes from metadataJson.",
    "MlShadowTrainingExample is built from ShadowCandidate + MarketPriceSnapshot at 12h; PaperTrades are not necessarily created from ShadowCandidates.",
    "Null labelGoodDecision12h = missing/insufficient 12h price data; never interpreted as false.",
  ];

  let paperTrades: Array<{ id: string; assetId: string; side: string; metadataJson: string | null }>;
  try {
    paperTrades = await prisma.paperTrade.findMany({
      where: { entryTime: { gte: from } },
      select: { id: true, assetId: true, side: true, metadataJson: true },
    });
  } catch {
    paperTrades = [];
  }

  const totalPt = paperTrades.length;
  let withRecId = 0;
  let withoutRecId = 0;
  const keyToTradeIds = new Map<string, string[]>();
  for (const t of paperTrades) {
    const recId = parseRecommendationId(t.metadataJson);
    if (recId == null || recId === "") {
      withoutRecId++;
      continue;
    }
    withRecId++;
    const key = `${recId}|${t.assetId}|${t.side}`;
    if (!keyToTradeIds.has(key)) keyToTradeIds.set(key, []);
    keyToTradeIds.get(key)!.push(t.id);
  }

  let examples: Array<{
    id: string;
    recommendationId: string | null;
    assetId: string;
    side: string;
    labelGoodDecision12h: boolean | null;
    marketId: string | null;
  }>;
  try {
    examples = await prisma.mlShadowTrainingExample.findMany({
      select: {
        id: true,
        recommendationId: true,
        assetId: true,
        side: true,
        labelGoodDecision12h: true,
        marketId: true,
      },
    });
  } catch {
    examples = [];
  }

  const totalEx = examples.length;
  let exWithRecId = 0;
  let exWithRecIdNullLabel = 0;
  let exWithRecIdWithLabel = 0;
  const keyToBestExample = new Map<
    string,
    { id: string; recommendationId: string | null; labelGoodDecision12h: boolean | null }
  >();
  for (const e of examples) {
    const recId = e.recommendationId ?? "";
    if (recId === "") continue;
    exWithRecId++;
    if (e.labelGoodDecision12h === null) exWithRecIdNullLabel++;
    else exWithRecIdWithLabel++;
    const key = `${recId}|${e.assetId}|${e.side}`;
    if (!keyToBestExample.has(key)) {
      keyToBestExample.set(key, {
        id: e.id,
        recommendationId: e.recommendationId,
        labelGoodDecision12h: e.labelGoodDecision12h,
      });
    }
  }

  let noKey = 0;
  let joinFailureNoExample = 0;
  let matchedNullLabel = 0;
  let matchedWithLabel = 0;
  const sampleNoExample: ShadowLabelPipelineDebugResult["sampleJoinFailures"] = [];
  const sampleNullLabel: ShadowLabelPipelineDebugResult["sampleMatchedNullLabel"] = [];

  for (const t of paperTrades) {
    const recId = parseRecommendationId(t.metadataJson);
    if (recId == null || recId === "") {
      noKey++;
      if (sampleNoExample.length < sampleSize) {
        sampleNoExample.push({
          paperTradeId: t.id,
          assetId: t.assetId,
          side: t.side,
          recommendationId: null,
          reason: "no_recommendation_id",
        });
      }
      continue;
    }
    const key = `${recId}|${t.assetId}|${t.side}`;
    const ex = keyToBestExample.get(key);
    if (!ex) {
      joinFailureNoExample++;
      if (sampleNoExample.length < sampleSize) {
        sampleNoExample.push({
          paperTradeId: t.id,
          assetId: t.assetId,
          side: t.side,
          recommendationId: recId,
          reason: "no_matching_example",
        });
      }
      continue;
    }
    if (ex.labelGoodDecision12h === null) {
      matchedNullLabel++;
      if (sampleNullLabel.length < sampleSize) {
        sampleNullLabel.push({
          paperTradeId: t.id,
          key,
          exampleId: ex.id,
          exampleRecommendationId: ex.recommendationId,
          exampleLabelGoodDecision12h: ex.labelGoodDecision12h,
        });
      }
    } else {
      matchedWithLabel++;
    }
  }

  const matchedTotal = matchedNullLabel + matchedWithLabel;
  const pctMissingExamples = totalPt > 0 ? ((noKey + joinFailureNoExample) / totalPt) * 100 : 0;
  const pctJoinFailures = totalPt > 0 ? ((noKey + joinFailureNoExample) / totalPt) * 100 : 0;
  const pctExamplesWithNullLabelAmongMatched =
    matchedTotal > 0 ? (matchedNullLabel / matchedTotal) * 100 : 0;
  const pctResolvedWithLabel = totalPt > 0 ? (matchedWithLabel / totalPt) * 100 : 0;

  let totalSnapshots = 0;
  let distinctMarketAssetWithSnapshot = 0;
  try {
    const snapshotFrom = new Date();
    snapshotFrom.setDate(snapshotFrom.getDate() - lookbackDays);
    totalSnapshots = await prisma.marketPriceSnapshot.count({
      where: { capturedAt: { gte: snapshotFrom } },
    });
    const grouped = await prisma.marketPriceSnapshot.groupBy({
      by: ["marketId", "assetId"],
      where: { capturedAt: { gte: snapshotFrom } },
    });
    distinctMarketAssetWithSnapshot = grouped.length;
  } catch {
    // table may not exist
  }

  const pctMissingPriceSnapshots =
    exWithRecId > 0 ? (exWithRecIdNullLabel / exWithRecId) * 100 : null;

  return {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    paperTrade: {
      total: totalPt,
      withRecommendationId: withRecId,
      withoutRecommendationId: withoutRecId,
      pctMissingRecommendationId: totalPt > 0 ? (withoutRecId / totalPt) * 100 : 0,
      pctWithRecommendationId: totalPt > 0 ? (withRecId / totalPt) * 100 : 0,
    },
    mlShadowTrainingExample: {
      total: totalEx,
      withRecommendationId: exWithRecId,
      withRecommendationIdNullLabel: exWithRecIdNullLabel,
      withRecommendationIdWithLabel: exWithRecIdWithLabel,
      pctWithRecommendationId: totalEx > 0 ? (exWithRecId / totalEx) * 100 : 0,
      pctExamplesWithNullLabel: exWithRecId > 0 ? (exWithRecIdNullLabel / exWithRecId) * 100 : 0,
      pctExamplesWithLabel: exWithRecId > 0 ? (exWithRecIdWithLabel / exWithRecId) * 100 : 0,
    },
    join: {
      noKey,
      joinFailureNoExample,
      matchedNullLabel,
      matchedWithLabel,
      pctMissingExamples,
      pctJoinFailures,
      pctExamplesWithNullLabel: pctExamplesWithNullLabelAmongMatched,
      pctResolvedWithLabel,
    },
    priceSnapshots: {
      totalSnapshots,
      distinctMarketAssetWithSnapshot,
      examplesWithRecIdButNullLabel: exWithRecIdNullLabel,
      pctMissingPriceSnapshots,
    },
    sampleJoinFailures: sampleNoExample,
    sampleMatchedNullLabel: sampleNullLabel,
    caveats,
  };
}
