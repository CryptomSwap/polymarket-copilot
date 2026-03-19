/**
 * Shadow label coverage and score calibration audit (read-only).
 * Primary target: labelGoodDecision12h.
 * Segments by persisted dimensions from PaperTrade; resolves labels from MlShadowTrainingExample.
 * Null label = missing/insufficient 12h data; never treated as 0/false.
 */

import { prisma } from "@/lib/db";

const PRIMARY_TARGET = "labelGoodDecision12h";
const SCORE_BUCKETS = 10;
const DEFAULT_MIN_SUPPORT = 10;
const DEFAULT_LOOKBACK_DAYS = 90;

export interface ShadowLabelCoverageSegment {
  dimension: string;
  value: string | null;
  totalRows: number;
  labeledRows: number;
  unlabeledRows: number;
  labelCoveragePct: number | null;
  avgShadowMlScore: number | null;
  empiricalPositiveRate: number | null;
  calibrationGap: number | null;
  brierLikeError: number | null;
  winCount: number | null;
  lossCount: number | null;
  scoreBucketCounts: Record<string, { count: number; empiricalPositiveRate: number | null }>;
  challengerAvailableCount: number | null;
  challengerCoveragePct: number | null;
}

export interface ShadowLabelCoverageAuditResult {
  generatedAt: string;
  assumptions: string[];
  primaryTarget: string;
  lookbackDays: number;
  minSupport: number;
  global: {
    totalPaperTrades: number;
    totalWithResolvedExample: number;
    totalLabeled: number;
    totalUnlabeled: number;
    labelCoveragePct: number | null;
    avgScore: number | null;
    empiricalPositiveRate: number | null;
    calibrationGap: number | null;
    brierLikeError: number | null;
    winCount: number;
    lossCount: number;
    scoreBucketCounts: Record<string, { count: number; labeledCount: number; empiricalPositiveRate: number | null }>;
  };
  byBotType: ShadowLabelCoverageSegment[];
  byTargetLabel: ShadowLabelCoverageSegment[];
  byPolicyState: ShadowLabelCoverageSegment[];
  byPaperPolicyMode: ShadowLabelCoverageSegment[];
  byPaperRelaxationReason: ShadowLabelCoverageSegment[];
  byEntryPriceBand: ShadowLabelCoverageSegment[];
  byTheme: ShadowLabelCoverageSegment[];
  byCategory: ShadowLabelCoverageSegment[];
  byChallengerAvailable: ShadowLabelCoverageSegment[];
  byExplorationAdmissionMode: ShadowLabelCoverageSegment[];
  riskSegments: Array<{
    dimension: string;
    value: string | null;
    reason: string;
    severity: "high" | "medium" | "low";
    detail: Record<string, unknown>;
  }>;
  caveats: string[];
  dimensionsNotAvailable: string[];
}

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

function buildSegment(
  dimension: string,
  value: string | null,
  rows: Array<{ score: number; label: boolean | null; challengerAvailable: boolean | null }>
): ShadowLabelCoverageSegment {
  const totalRows = rows.length;
  const labeled = rows.filter((r) => r.label !== null);
  const labeledRows = labeled.length;
  const unlabeledRows = totalRows - labeledRows;
  const labelCoveragePct = totalRows > 0 ? (labeledRows / totalRows) * 100 : null;

  const scores = rows.map((r) => r.score).filter((s) => Number.isFinite(s));
  const avgShadowMlScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  let empiricalPositiveRate: number | null = null;
  let calibrationGap: number | null = null;
  let brierLikeError: number | null = null;
  let winCount: number | null = null;
  let lossCount: number | null = null;

  if (labeledRows > 0) {
    const positives = labeled.filter((r) => r.label === true).length;
    empiricalPositiveRate = positives / labeledRows;
    if (avgShadowMlScore != null) {
      calibrationGap = avgShadowMlScore - empiricalPositiveRate;
    }
    const brierSum = labeled.reduce((sum, r) => {
      const s = Number.isFinite(r.score) ? r.score : 0;
      const y = r.label === true ? 1 : 0;
      return sum + (s - y) * (s - y);
    }, 0);
    brierLikeError = brierSum / labeledRows;
    winCount = positives;
    lossCount = labeledRows - positives;
  }

  const bucketCounts: Record<string, { count: number; empiricalPositiveRate: number | null }> = {};
  for (let i = 0; i < SCORE_BUCKETS; i++) {
    const lo = i / SCORE_BUCKETS;
    const hi = (i + 1) / SCORE_BUCKETS;
    const isLast = i === SCORE_BUCKETS - 1;
    const key = `[${lo.toFixed(1)},${isLast ? hi.toFixed(1) + "]" : hi.toFixed(1) + ")"}`;
    const inBucket = rows.filter((r) => r.score >= lo && (isLast ? r.score <= 1 : r.score < hi));
    const labeledInBucket = inBucket.filter((r) => r.label !== null);
    const count = inBucket.length;
    const posRate =
      labeledInBucket.length > 0
        ? labeledInBucket.filter((r) => r.label === true).length / labeledInBucket.length
        : null;
    bucketCounts[key] = { count, empiricalPositiveRate: posRate };
  }

  const withChallenger = rows.filter((r) => r.challengerAvailable === true).length;
  const challengerAvailableCount = withChallenger;
  const challengerCoveragePct = totalRows > 0 ? (withChallenger / totalRows) * 100 : null;

  return {
    dimension,
    value,
    totalRows,
    labeledRows,
    unlabeledRows,
    labelCoveragePct,
    avgShadowMlScore,
    empiricalPositiveRate,
    calibrationGap,
    brierLikeError,
    winCount,
    lossCount,
    scoreBucketCounts: bucketCounts,
    challengerAvailableCount,
    challengerCoveragePct,
  };
}

export async function runShadowLabelCoverageAudit(options: {
  lookbackDays?: number;
  minSupport?: number;
}): Promise<ShadowLabelCoverageAuditResult> {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const minSupport = options.minSupport ?? DEFAULT_MIN_SUPPORT;
  const from = new Date();
  from.setDate(from.getDate() - lookbackDays);

  const assumptions: string[] = [
    "PaperTrade: score, championScore, botType, targetLabel, sourceDecisionState, paperPolicyMode, paperRelaxationReason, entryPriceBand, theme, category, challengerAvailable, explorationAdmissionMode are persisted. recommendationId is in metadataJson.",
    "MlShadowTrainingExample: recommendationId, assetId, side, labelGoodDecision12h (Boolean?). Null = missing/insufficient 12h snapshot; never interpreted as false.",
    "Join: PaperTrade (metadataJson.recommendationId, assetId, side) -> MlShadowTrainingExample. Most recent example per (recommendationId, assetId, side) when multiple exist.",
    "Score used for calibration: PaperTrade.score (shadow ML score at open). Brier-like = mean((score - label)^2) over labeled rows only.",
  ];

  type TradeRow = {
    id: string;
    score: number;
    assetId: string;
    side: string;
    metadataJson: string | null;
    botType?: string | null;
    targetLabel?: string | null;
    sourceDecisionState?: string | null;
    paperPolicyMode?: string | null;
    paperRelaxationReason?: string | null;
    entryPriceBand?: string | null;
    theme?: string | null;
    category?: string | null;
    challengerAvailable?: boolean | null;
    explorationAdmissionMode?: string | null;
  };

  let trades: TradeRow[];
  try {
    trades = await prisma.paperTrade.findMany({
      where: { entryTime: { gte: from } },
      select: {
        id: true,
        score: true,
        assetId: true,
        side: true,
        metadataJson: true,
        botType: true,
        targetLabel: true,
        sourceDecisionState: true,
        paperPolicyMode: true,
        paperRelaxationReason: true,
        entryPriceBand: true,
        theme: true,
        category: true,
        challengerAvailable: true,
        explorationAdmissionMode: true,
      },
    }) as TradeRow[];
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code: string }).code : "";
    if (code === "P2022") {
      trades = (await prisma.paperTrade.findMany({
        where: { entryTime: { gte: from } },
        select: {
          id: true,
          score: true,
          assetId: true,
          side: true,
          metadataJson: true,
        },
      })) as TradeRow[];
      assumptions.push(
        "PaperTrade schema is minimal (no botType, targetLabel, etc.): dimension segments by those fields will be empty or single 'unknown'."
      );
    } else {
      throw err;
    }
  }

  const shadowExamples = await prisma.mlShadowTrainingExample.findMany({
    where: {},
    select: {
      recommendationId: true,
      assetId: true,
      side: true,
      labelGoodDecision12h: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const labelByKey = new Map<string, boolean>();
  const keyWithExample = new Set<string>();
  for (const row of shadowExamples) {
    const recId = row.recommendationId ?? "";
    const key = `${recId}|${row.assetId}|${row.side}`;
    keyWithExample.add(key);
    if (labelByKey.has(key)) continue;
    if (row.labelGoodDecision12h === null) continue;
    labelByKey.set(key, row.labelGoodDecision12h);
  }

  type Row = { score: number; label: boolean | null; challengerAvailable: boolean | null };
  const withLabel: Array<{
    score: number;
    label: boolean | null;
    challengerAvailable: boolean | null;
    botType: string | null;
    targetLabel: string | null;
    policyState: string | null;
    paperPolicyMode: string | null;
    paperRelaxationReason: string | null;
    entryPriceBand: string | null;
    theme: string | null;
    category: string | null;
    explorationAdmissionMode: string | null;
  }> = [];

  for (const t of trades) {
    const recId = parseRecommendationId(t.metadataJson);
    const key = recId != null ? `${recId}|${t.assetId}|${t.side}` : null;
    const label = key != null && labelByKey.has(key) ? labelByKey.get(key)! : null;
    const score = Number.isFinite(t.score) ? (t.score as number) : 0;
    withLabel.push({
      score,
      label,
      challengerAvailable: t.challengerAvailable ?? null,
      botType: t.botType ?? null,
      targetLabel: t.targetLabel ?? null,
      policyState: t.sourceDecisionState ?? null,
      paperPolicyMode: t.paperPolicyMode ?? null,
      paperRelaxationReason: t.paperRelaxationReason ?? null,
      entryPriceBand: t.entryPriceBand ?? null,
      theme: t.theme ?? null,
      category: t.category ?? null,
      explorationAdmissionMode: t.explorationAdmissionMode ?? null,
    });
  }

  const totalPaperTrades = withLabel.length;
  let totalWithResolvedExample = 0;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const recId = parseRecommendationId(t.metadataJson);
    const key = recId != null ? `${recId}|${t.assetId}|${t.side}` : null;
    if (key != null && keyWithExample.has(key)) totalWithResolvedExample++;
  }
  const totalLabeled = withLabel.filter((r) => r.label !== null).length;
  const totalUnlabeled = totalPaperTrades - totalLabeled;
  const labelCoveragePct = totalPaperTrades > 0 ? (totalLabeled / totalPaperTrades) * 100 : null;

  const scores = withLabel.map((r) => r.score).filter((s) => Number.isFinite(s));
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const labeledOnly = withLabel.filter((r) => r.label !== null);
  const empiricalPositiveRate =
    labeledOnly.length > 0
      ? labeledOnly.filter((r) => r.label === true).length / labeledOnly.length
      : null;
  const calibrationGap =
    avgScore != null && empiricalPositiveRate != null ? avgScore - empiricalPositiveRate : null;
  const brierLikeError =
    labeledOnly.length > 0
      ? labeledOnly.reduce((sum, r) => {
          const y = r.label === true ? 1 : 0;
          return sum + (r.score - y) * (r.score - y);
        }, 0) / labeledOnly.length
      : null;
  const winCount = labeledOnly.filter((r) => r.label === true).length;
  const lossCount = labeledOnly.filter((r) => r.label === false).length;

  const globalBucketCounts: Record<string, { count: number; labeledCount: number; empiricalPositiveRate: number | null }> = {};
  for (let i = 0; i < SCORE_BUCKETS; i++) {
    const lo = i / SCORE_BUCKETS;
    const hi = (i + 1) / SCORE_BUCKETS;
    const isLast = i === SCORE_BUCKETS - 1;
    const key = `[${lo.toFixed(1)},${isLast ? hi.toFixed(1) + "]" : hi.toFixed(1) + ")"}`;
    const inBucket = withLabel.filter((r) => r.score >= lo && (isLast ? r.score <= 1 : r.score < hi));
    const labeledInBucket = inBucket.filter((r) => r.label !== null);
    const posRate =
      labeledInBucket.length > 0
        ? labeledInBucket.filter((r) => r.label === true).length / labeledInBucket.length
        : null;
    globalBucketCounts[key] = {
      count: inBucket.length,
      labeledCount: labeledInBucket.length,
      empiricalPositiveRate: posRate,
    };
  }

  function segmentBy(dimension: string, getValue: (r: (typeof withLabel)[0]) => string | null): ShadowLabelCoverageSegment[] {
    const byVal = new Map<string | null, Row[]>();
    for (const r of withLabel) {
      const v = getValue(r);
      const list = byVal.get(v) ?? [];
      list.push({ score: r.score, label: r.label, challengerAvailable: r.challengerAvailable });
      byVal.set(v, list);
    }
    const out: ShadowLabelCoverageSegment[] = [];
    for (const [value, rows] of byVal) {
      if (rows.length < minSupport) continue;
      out.push(buildSegment(dimension, value, rows));
    }
    return out.sort((a, b) => b.totalRows - a.totalRows);
  }

  const byBotType = segmentBy("botType", (r) => r.botType);
  const byTargetLabel = segmentBy("targetLabel", (r) => r.targetLabel);
  const byPolicyState = segmentBy("policyState", (r) => r.policyState);
  const byPaperPolicyMode = segmentBy("paperPolicyMode", (r) => r.paperPolicyMode);
  const byPaperRelaxationReason = segmentBy("paperRelaxationReason", (r) => r.paperRelaxationReason);
  const byEntryPriceBand = segmentBy("entryPriceBand", (r) => r.entryPriceBand);
  const byTheme = segmentBy("theme", (r) => r.theme);
  const byCategory = segmentBy("category", (r) => r.category);
  const byChallengerAvailable = segmentBy(
    "challengerAvailable",
    (r) => (r.challengerAvailable == null ? "null" : r.challengerAvailable ? "true" : "false")
  );
  const byExplorationAdmissionMode = segmentBy("explorationAdmissionMode", (r) => r.explorationAdmissionMode);

  const riskSegments: ShadowLabelCoverageAuditResult["riskSegments"] = [];
  const segments: ShadowLabelCoverageSegment[] = [
    ...byBotType,
    ...byTargetLabel,
    ...byPolicyState,
    ...byPaperPolicyMode,
    ...byEntryPriceBand,
    ...byTheme,
    ...byCategory,
    ...byChallengerAvailable,
    ...byExplorationAdmissionMode,
  ];
  for (const seg of segments) {
    if (seg.labelCoveragePct != null && seg.labelCoveragePct < 30 && seg.totalRows >= 5) {
      riskSegments.push({
        dimension: seg.dimension,
        value: seg.value,
        reason: "low_label_coverage",
        severity: seg.labelCoveragePct < 15 ? "high" : "medium",
        detail: {
          labelCoveragePct: seg.labelCoveragePct,
          totalRows: seg.totalRows,
          labeledRows: seg.labeledRows,
        },
      });
    }
    if (seg.totalRows >= minSupport && seg.totalRows < 20) {
      riskSegments.push({
        dimension: seg.dimension,
        value: seg.value,
        reason: "sparse_support",
        severity: "medium",
        detail: { totalRows: seg.totalRows },
      });
    }
    if (
      seg.calibrationGap != null &&
      Math.abs(seg.calibrationGap) > 0.15 &&
      seg.labeledRows >= 5
    ) {
      riskSegments.push({
        dimension: seg.dimension,
        value: seg.value,
        reason: "large_calibration_gap",
        severity: Math.abs(seg.calibrationGap) > 0.25 ? "high" : "medium",
        detail: {
          calibrationGap: seg.calibrationGap,
          labeledRows: seg.labeledRows,
        },
      });
    }
    if (
      seg.challengerCoveragePct != null &&
      seg.challengerCoveragePct < 20 &&
      seg.totalRows >= 10
    ) {
      riskSegments.push({
        dimension: seg.dimension,
        value: seg.value,
        reason: "low_challenger_coverage",
        severity: "low",
        detail: {
          challengerCoveragePct: seg.challengerCoveragePct,
          totalRows: seg.totalRows,
        },
      });
    }
  }
  riskSegments.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.severity] - order[b.severity];
  });

  const caveats: string[] = [
    "Unlabeled rows = no matching MlShadowTrainingExample or labelGoodDecision12h is null (missing 12h data). Never counted as negative outcome.",
    "Calibration and Brier-like metrics use only labeled rows.",
    "Score = PaperTrade.score at open. Label = labelGoodDecision12h from most recent MlShadowTrainingExample per (recommendationId, assetId, side).",
  ];
  const dimensionsNotAvailable: string[] = [
    "liquidity_bucket, quality_bucket, time_bucket: not derived (would require extra JSON or snapshot fields).",
    "botVersion, profile_snapshot_hash: not aggregated (profileSnapshotJson present but not hashed/grouped).",
  ];

  return {
    generatedAt: new Date().toISOString(),
    assumptions,
    primaryTarget: PRIMARY_TARGET,
    lookbackDays,
    minSupport,
    global: {
      totalPaperTrades,
      totalWithResolvedExample,
      totalLabeled,
      totalUnlabeled,
      labelCoveragePct,
      avgScore,
      empiricalPositiveRate,
      calibrationGap,
      brierLikeError,
      winCount,
      lossCount,
      scoreBucketCounts: globalBucketCounts,
    },
    byBotType,
    byTargetLabel,
    byPolicyState,
    byPaperPolicyMode,
    byPaperRelaxationReason,
    byEntryPriceBand,
    byTheme,
    byCategory,
    byChallengerAvailable,
    byExplorationAdmissionMode,
    riskSegments: riskSegments.slice(0, 25),
    caveats,
    dimensionsNotAvailable,
  };
}
