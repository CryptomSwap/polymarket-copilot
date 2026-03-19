/**
 * Shadow-to-ML dataset builder: convert ShadowCandidate rows into ML-ready training examples.
 * Feature extraction from snapshots is explicit and boring; labels from outcomeClassification/markouts.
 * Does not change live runtime behavior; advisory only.
 */

import { prisma } from "@/lib/db";
import type {
  ShadowTrainingRow,
  OutcomeClassification,
  BuildShadowTrainingExamplesOptions,
  BuildShadowTrainingExamplesResult,
  PersistShadowTrainingExamplesOptions,
  PersistShadowTrainingExamplesResult,
} from "./types";
import { subtypesFromDecisionSnapshotJson } from "@/lib/decision-calibration/subtypes";
import type { DecisionSnapshotLike } from "@/lib/decision-calibration/subtypes";
import { markout } from "@/lib/shadow-evaluation/markout";

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function toStr(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return String(n);
}

/** Parse decisionSnapshotJson into a simple shape for feature extraction. */
function parseDecisionSnapshot(json: string | null | undefined): DecisionSnapshotLike | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as DecisionSnapshotLike;
  } catch {
    return null;
  }
}

/** Extract execution policy snapshot fields (allow, blockingReasons, warnings, checks). */
function parseExecutionPolicySnapshot(json: string | null | undefined): {
  allow?: boolean;
  policyState?: string;
  blockingReasons?: string[];
  warnings?: string[];
  checks?: Record<string, { pass?: boolean; blockReason?: string }>;
} | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as {
      allow?: boolean;
      policyState?: string;
      blockingReasons?: string[];
      warnings?: string[];
      checks?: Record<string, { pass?: boolean; blockReason?: string }>;
    };
  } catch {
    return null;
  }
}

/** Extract execution quality snapshot fields. */
function parseExecutionQualitySnapshot(json: string | null | undefined): {
  qualityState?: string;
  spreadBps?: number | null;
  estimatedSlippageBps?: number | null;
  depthSufficiency?: string;
  quoteFreshnessState?: string;
  tradable?: boolean;
  blockingReasons?: string[];
  warnings?: string[];
} | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return {
      qualityState: typeof o.qualityState === "string" ? o.qualityState : undefined,
      spreadBps: typeof o.spreadBps === "number" ? o.spreadBps : null,
      estimatedSlippageBps: typeof o.estimatedSlippageBps === "number" ? o.estimatedSlippageBps : null,
      depthSufficiency: typeof o.depthSufficiency === "string" ? o.depthSufficiency : undefined,
      quoteFreshnessState: typeof o.quoteFreshnessState === "string" ? o.quoteFreshnessState : undefined,
      tradable: typeof o.tradable === "boolean" ? o.tradable : undefined,
      blockingReasons: Array.isArray(o.blockingReasons) ? (o.blockingReasons as string[]) : undefined,
      warnings: Array.isArray(o.warnings) ? (o.warnings as string[]) : undefined,
    };
  } catch {
    return null;
  }
}

/** Extract portfolio risk snapshot numeric fields. */
function parsePortfolioRiskSnapshot(json: string | null | undefined): {
  grossExposure?: number;
  totalOpenExposure?: number;
  totalWorkingOrderExposure?: number;
  maxSingleMarketConcentrationPct?: number;
  maxSingleThemeConcentrationPct?: number;
  worstCaseLossEstimate?: number;
  nearResolutionExposure?: number;
  illiquidExposureEstimate?: number;
  correlatedExposureEstimate?: number;
  concentrationFlags?: unknown[];
  riskFlags?: unknown[];
} | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return {
      grossExposure: typeof o.grossExposure === "number" ? o.grossExposure : undefined,
      totalOpenExposure: typeof o.totalOpenExposure === "number" ? o.totalOpenExposure : undefined,
      totalWorkingOrderExposure: typeof o.totalWorkingOrderExposure === "number" ? o.totalWorkingOrderExposure : undefined,
      maxSingleMarketConcentrationPct: typeof o.maxSingleMarketConcentrationPct === "number" ? o.maxSingleMarketConcentrationPct : undefined,
      maxSingleThemeConcentrationPct: typeof o.maxSingleThemeConcentrationPct === "number" ? o.maxSingleThemeConcentrationPct : undefined,
      worstCaseLossEstimate: typeof o.worstCaseLossEstimate === "number" ? o.worstCaseLossEstimate : undefined,
      nearResolutionExposure: typeof o.nearResolutionExposure === "number" ? o.nearResolutionExposure : undefined,
      illiquidExposureEstimate: typeof o.illiquidExposureEstimate === "number" ? o.illiquidExposureEstimate : undefined,
      correlatedExposureEstimate: typeof o.correlatedExposureEstimate === "number" ? o.correlatedExposureEstimate : undefined,
      concentrationFlags: Array.isArray(o.concentrationFlags) ? o.concentrationFlags : undefined,
      riskFlags: Array.isArray(o.riskFlags) ? o.riskFlags : undefined,
    };
  } catch {
    return null;
  }
}

/** Extract runtime safety snapshot (state, reasons). */
function parseRuntimeSafetySnapshot(json: string | null | undefined): {
  state?: string;
  blockingReasons?: string[];
  warnings?: string[];
} | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const reasons = Array.isArray(o.blockingReasons) ? (o.blockingReasons as string[]) : [];
    const warnings = Array.isArray(o.warnings) ? (o.warnings as string[]) : [];
    return {
      state: typeof o.state === "string" ? o.state : undefined,
      blockingReasons: reasons,
      warnings,
    };
  } catch {
    return null;
  }
}

/** Group blocking reasons by prefix (e.g. "freshness:", "exposure:") for a compact feature. */
function groupBlockingReasons(reasons: unknown): string {
  const arr = Array.isArray(reasons) ? (reasons as string[]) : [];
  const groups = new Set<string>();
  for (const r of arr) {
    const s = String(r).trim();
    const idx = s.indexOf(":");
    if (idx > 0) groups.add(s.slice(0, idx));
    else if (s) groups.add("other");
  }
  return Array.from(groups).sort().join(",") || "";
}

/**
 * Derive conservative labels from outcomeClassification.
 * Semantics:
 * - good_allow: we allowed and outcome was favorable -> good decision (allow).
 * - bad_allow: we allowed and outcome was unfavorable -> bad decision (allow).
 * - good_block: we blocked and outcome was unfavorable -> good decision (block).
 * - bad_block: we blocked and outcome was favorable -> missed opportunity.
 */
export function deriveLabels(
  outcome: OutcomeClassification | null,
  wasBlocked: boolean,
  executionQualityHadBlocks: boolean
): {
  labelGoodDecision: boolean | null;
  labelBadDecision: boolean | null;
  labelMissedOpportunity: boolean | null;
  labelExecutionUnsafe: boolean | null;
} {
  if (outcome == null) {
    return {
      labelGoodDecision: null,
      labelBadDecision: null,
      labelMissedOpportunity: null,
      labelExecutionUnsafe: null,
    };
  }
  switch (outcome) {
    case "good_allow":
      return {
        labelGoodDecision: true,
        labelBadDecision: false,
        labelMissedOpportunity: false,
        labelExecutionUnsafe: false,
      };
    case "bad_allow":
      return {
        labelGoodDecision: false,
        labelBadDecision: true,
        labelMissedOpportunity: false,
        labelExecutionUnsafe: executionQualityHadBlocks ? true : null,
      };
    case "good_block":
      return {
        labelGoodDecision: true,
        labelBadDecision: false,
        labelMissedOpportunity: false,
        labelExecutionUnsafe: false,
      };
    case "bad_block":
      return {
        labelGoodDecision: false,
        labelBadDecision: false,
        labelMissedOpportunity: true,
        labelExecutionUnsafe: null,
      };
    default:
      return {
        labelGoodDecision: null,
        labelBadDecision: null,
        labelMissedOpportunity: null,
        labelExecutionUnsafe: null,
      };
  }
}

/** Build one ShadowTrainingRow from a ShadowCandidate (with optional snapshots). */
export function buildShadowTrainingRow(c: {
  id: string;
  funderAddress: string;
  recommendationId: string | null;
  orderIntentId: string | null;
  assetId: string;
  marketId: string | null;
  side: string;
  intendedPrice: string;
  intendedSize: string;
  candidateSource: string;
  createdAt: Date;
  decisionSnapshotJson: string | null;
  executionPolicySnapshotJson: string | null;
  executionQualitySnapshotJson: string | null;
  portfolioRiskSnapshotJson: string | null;
  runtimeSafetySnapshotJson: string | null;
  wasBlocked: boolean;
  blockingReasons: unknown;
  wasSubmitted: boolean;
  wasFilled: boolean | null;
  evaluatedAt: Date | null;
  markout1h: string | null;
  markout6h: string | null;
  markout24h: string | null;
  outcomeClassification: string | null;
}): ShadowTrainingRow {
  const decision = parseDecisionSnapshot(c.decisionSnapshotJson);
  const policy = parseExecutionPolicySnapshot(c.executionPolicySnapshotJson);
  const eq = parseExecutionQualitySnapshot(c.executionQualitySnapshotJson);
  const risk = parsePortfolioRiskSnapshot(c.portfolioRiskSnapshotJson);
  const safety = parseRuntimeSafetySnapshot(c.runtimeSafetySnapshotJson);

  const decisionSubtypes = c.decisionSnapshotJson ? subtypesFromDecisionSnapshotJson(c.decisionSnapshotJson) : [];
  const eligibilityBlockersCount = (decision?.blockers ?? []).length;
  const sizeMult = decision?.sizeMultiplier;
  const sizeMultNum = typeof sizeMult === "number" ? sizeMult : parseNum(String(sizeMult ?? ""));
  const finalSize = decision?.finalSuggestedSize;
  const finalSizeNum = typeof finalSize === "number" ? finalSize : parseNum(String(finalSize ?? ""));
  const reducedSizeIndicator =
    sizeMultNum != null && Number.isFinite(sizeMultNum) && sizeMultNum > 0 && sizeMultNum < 1;
  const blockedIndicator = c.wasBlocked;

  const executionAllow = policy?.allow ?? null;
  const executionBlockingReasonGroups = policy?.blockingReasons?.length
    ? groupBlockingReasons(policy.blockingReasons)
    : (c.wasBlocked && c.blockingReasons ? groupBlockingReasons(c.blockingReasons as string[]) : null);
  const executionWarningCount = policy?.warnings?.length ?? 0;

  const eqHadBlocks = (eq?.blockingReasons?.length ?? 0) > 0;
  const outcome = (c.outcomeClassification as OutcomeClassification) ?? null;
  const labels = deriveLabels(outcome, c.wasBlocked, eqHadBlocks);

  const riskFlagsCount =
    (risk?.concentrationFlags?.length ?? 0) + (risk?.riskFlags?.length ?? 0);

  const outcomeBlockedVsAllowedVsSubmitted: "blocked" | "allowed" | "submitted" | null = c.wasBlocked
    ? "blocked"
    : c.wasSubmitted
      ? "submitted"
      : "allowed";

  return {
    shadowCandidateId: c.id,
    funderAddress: c.funderAddress,
    recommendationId: c.recommendationId,
    orderIntentId: c.orderIntentId,
    assetId: c.assetId,
    marketId: c.marketId,
    candidateSource: c.candidateSource,
    createdAt: c.createdAt,
    policyState: decision?.policyState ?? null,
    sizeMultiplier: sizeMult != null ? String(sizeMult) : null,
    finalSuggestedSize: finalSize != null ? String(finalSize) : null,
    eligibilityBlockersCount,
    reducedSizeIndicator,
    blockedIndicator,
    executionAllow,
    executionBlockingReasonGroups,
    executionWarningCount,
    qualityState: eq?.qualityState ?? null,
    spreadBps: toStr(eq?.spreadBps ?? null),
    estimatedSlippage: eq?.estimatedSlippageBps != null ? String(eq.estimatedSlippageBps / 10_000) : null,
    depthSufficiency: eq?.depthSufficiency ?? null,
    quoteFreshnessState: eq?.quoteFreshnessState ?? null,
    tradable: eq?.tradable ?? null,
    grossExposure: toStr(risk?.grossExposure ?? risk?.totalOpenExposure ?? null),
    totalOpenExposure: toStr(risk?.totalOpenExposure ?? null),
    workingOrderExposure: toStr(risk?.totalWorkingOrderExposure ?? null),
    maxSingleMarketConcentrationPct: toStr(risk?.maxSingleMarketConcentrationPct ?? null),
    maxSingleThemeConcentrationPct: toStr(risk?.maxSingleThemeConcentrationPct ?? null),
    worstCaseLossEstimate: toStr(risk?.worstCaseLossEstimate ?? null),
    nearResolutionExposure: toStr(risk?.nearResolutionExposure ?? null),
    illiquidExposureEstimate: toStr(risk?.illiquidExposureEstimate ?? null),
    correlatedExposureEstimate: toStr(risk?.correlatedExposureEstimate ?? null),
    portfolioRiskFlagsCount: riskFlagsCount,
    runtimeSafetyState: safety?.state ?? null,
    runtimeWarningCount: safety?.warnings?.length ?? 0,
    runtimeBlockingCount: safety?.blockingReasons?.length ?? 0,
    side: c.side,
    intendedPrice: c.intendedPrice,
    intendedSize: c.intendedSize,
    recommendationPresent: c.recommendationId != null && c.recommendationId !== "",
    outcomeBlockedVsAllowedVsSubmitted,
    markout1h: c.markout1h,
    markout6h: c.markout6h,
    markout12h: null,
    markout24h: c.markout24h,
    outcomeClassification: outcome,
    wasBlocked: c.wasBlocked,
    wasSubmitted: c.wasSubmitted,
    wasFilled: c.wasFilled,
    ...labels,
  };
}

/** Fetch eligible ShadowCandidates and build training rows. Does not persist. */
export async function buildShadowTrainingExamples(
  options: BuildShadowTrainingExamplesOptions = {}
): Promise<{ rows: ShadowTrainingRow[]; examplesSkipped: number; errors: string[] }> {
  const {
    funderAddress,
    limit = 1000,
    createdAfter,
    createdBefore,
    evaluatedOnly = true,
  } = options;

  const where: {
    funderAddress?: string;
    createdAt?: { gte?: Date; lte?: Date };
    evaluatedAt?: { not: null } | null;
  } = {};
  if (funderAddress) where.funderAddress = funderAddress.toLowerCase().trim();
  if (createdAfter) where.createdAt = { ...where.createdAt, gte: createdAfter };
  if (createdBefore) where.createdAt = { ...where.createdAt, lte: createdBefore };
  if (evaluatedOnly) where.evaluatedAt = { not: null };

  const errors: string[] = [];
  const rows: ShadowTrainingRow[] = [];
  const pageSize = Math.min(250, Math.max(50, Number(process.env.SHADOW_DATASET_BUILD_PAGE_SIZE ?? "200") || 200));
  let cursorId: string | null = null;
  while (rows.length < limit) {
    const remaining = limit - rows.length;
    const take = Math.min(pageSize, remaining);
    const candidates = await prisma.shadowCandidate.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (candidates.length === 0) break;
    for (const c of candidates) {
      try {
        rows.push(
          buildShadowTrainingRow({
            id: c.id,
            funderAddress: c.funderAddress,
            recommendationId: c.recommendationId,
            orderIntentId: c.orderIntentId,
            assetId: c.assetId,
            marketId: c.marketId,
            side: c.side,
            intendedPrice: c.intendedPrice,
            intendedSize: c.intendedSize,
            candidateSource: c.candidateSource,
            createdAt: c.createdAt,
            decisionSnapshotJson: c.decisionSnapshotJson,
            executionPolicySnapshotJson: c.executionPolicySnapshotJson,
            executionQualitySnapshotJson: c.executionQualitySnapshotJson,
            portfolioRiskSnapshotJson: c.portfolioRiskSnapshotJson,
            runtimeSafetySnapshotJson: c.runtimeSafetySnapshotJson,
            wasBlocked: c.wasBlocked,
            blockingReasons: c.blockingReasons,
            wasSubmitted: c.wasSubmitted,
            wasFilled: c.wasFilled,
            evaluatedAt: c.evaluatedAt,
            markout1h: c.markout1h,
            markout6h: c.markout6h,
            markout24h: c.markout24h,
            outcomeClassification: c.outcomeClassification,
          })
        );
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    cursorId = candidates[candidates.length - 1]?.id ?? null;
  }

  return { rows, examplesSkipped: 0, errors };
}

/**
 * Build shadow training examples and optionally persist to MlShadowTrainingExample.
 * Skips candidates that already have an MlShadowTrainingExample (no duplicate per shadowCandidateId).
 */
export async function persistShadowTrainingExamples(
  options: PersistShadowTrainingExamplesOptions = {}
): Promise<PersistShadowTrainingExamplesResult> {
  const { dryRun = false } = options;
  const { rows, examplesSkipped, errors } = await buildShadowTrainingExamples(options);

  let persisted = 0;
  if (!dryRun && rows.length > 0) {
    const HORIZON_12H_MS = 12 * 60 * 60 * 1000;
    const writeBatchSize = Math.min(
      500,
      Math.max(50, Number(process.env.SHADOW_DATASET_PERSIST_BATCH_SIZE ?? "200") || 200)
    );

    function valueAtOrBefore(
      points: { capturedAt: Date; price: number }[],
      at: Date
    ): number | null {
      if (points.length === 0) return null;
      let lo = 0;
      let hi = points.length - 1;
      if (points[0].capturedAt > at) return null;
      if (points[hi].capturedAt <= at) return points[hi].price;
      while (lo < hi - 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (points[mid].capturedAt <= at) lo = mid;
        else hi = mid;
      }
      return points[lo].capturedAt <= at ? points[lo].price : null;
    }

    for (let i = 0; i < rows.length; i += writeBatchSize) {
      const batch = rows.slice(i, i + writeBatchSize);
      const existing = await prisma.mlShadowTrainingExample.findMany({
        where: { shadowCandidateId: { in: batch.map((r) => r.shadowCandidateId) } },
        select: { shadowCandidateId: true },
      });
      const existingSet = new Set(existing.map((x: { shadowCandidateId: string }) => x.shadowCandidateId));
      for (const row of batch) {
        if (existingSet.has(row.shadowCandidateId)) continue;
        try {
          let markout12h: string | null = null;
          let labelGoodDecision12h: boolean | null = null;

          if (row.marketId && row.assetId) {
            const decisionAt = row.createdAt;
            const at12h = new Date(decisionAt.getTime() + HORIZON_12H_MS);

            const snapshots = await prisma.marketPriceSnapshot.findMany({
              where: {
                marketId: row.marketId,
                assetId: row.assetId,
                capturedAt: { gte: new Date(decisionAt.getTime() - 60 * 60 * 1000), lte: at12h },
              },
              orderBy: { capturedAt: "asc" },
            });

            const points = snapshots
              .map((s) => {
                const p = parseNum(s.price);
                return p != null && p > 0
                  ? { capturedAt: s.capturedAt, price: p }
                  : null;
              })
              .filter((p): p is { capturedAt: Date; price: number } => p !== null);

            if (points.length > 0) {
              const price0 = valueAtOrBefore(points, decisionAt);
              const price12h = valueAtOrBefore(points, at12h);
              if (price0 != null && price12h != null && price0 > 0) {
                const m12 = markout(row.side, price0, price12h);
                if (m12 != null && Number.isFinite(m12)) {
                  markout12h = String(m12);
                  const favorable = m12 > 0;
                  labelGoodDecision12h = row.wasBlocked ? !favorable : favorable;
                }
              }
            }
          }

          // recommendationId is required for PaperTrade → MlShadowTrainingExample join (recommendationId, assetId, side).
          const recommendationId = row.recommendationId?.trim() || null;
          await prisma.mlShadowTrainingExample.create({
            data: {
              shadowCandidateId: row.shadowCandidateId,
              funderAddress: row.funderAddress,
              recommendationId,
              orderIntentId: row.orderIntentId,
              assetId: row.assetId,
              marketId: row.marketId,
              candidateSource: row.candidateSource,
              policyState: row.policyState,
              sizeMultiplier: row.sizeMultiplier,
              finalSuggestedSize: row.finalSuggestedSize,
              eligibilityBlockersCount: row.eligibilityBlockersCount,
              reducedSizeIndicator: row.reducedSizeIndicator,
              blockedIndicator: row.blockedIndicator,
              executionAllow: row.executionAllow,
              executionBlockingReasonGroups: row.executionBlockingReasonGroups,
              executionWarningCount: row.executionWarningCount,
              qualityState: row.qualityState,
              spreadBps: row.spreadBps,
              estimatedSlippage: row.estimatedSlippage,
              depthSufficiency: row.depthSufficiency,
              quoteFreshnessState: row.quoteFreshnessState,
              tradable: row.tradable,
              grossExposure: row.grossExposure,
              totalOpenExposure: row.totalOpenExposure,
              workingOrderExposure: row.workingOrderExposure,
              maxSingleMarketConcentrationPct: row.maxSingleMarketConcentrationPct,
              maxSingleThemeConcentrationPct: row.maxSingleThemeConcentrationPct,
              worstCaseLossEstimate: row.worstCaseLossEstimate,
              nearResolutionExposure: row.nearResolutionExposure,
              illiquidExposureEstimate: row.illiquidExposureEstimate,
              correlatedExposureEstimate: row.correlatedExposureEstimate,
              portfolioRiskFlagsCount: row.portfolioRiskFlagsCount,
              runtimeSafetyState: row.runtimeSafetyState,
              runtimeWarningCount: row.runtimeWarningCount,
              runtimeBlockingCount: row.runtimeBlockingCount,
              side: row.side,
              intendedPrice: row.intendedPrice,
              intendedSize: row.intendedSize,
              recommendationPresent: row.recommendationPresent,
              outcomeBlockedVsAllowedVsSubmitted: row.outcomeBlockedVsAllowedVsSubmitted,
              markout1h: row.markout1h,
              markout6h: row.markout6h,
              markout12h,
              markout24h: row.markout24h,
              outcomeClassification: row.outcomeClassification,
              wasBlocked: row.wasBlocked,
              wasSubmitted: row.wasSubmitted,
              wasFilled: row.wasFilled,
              labelGoodDecision: row.labelGoodDecision,
              labelGoodDecision12h,
              labelBadDecision: row.labelBadDecision,
              labelMissedOpportunity: row.labelMissedOpportunity,
              labelExecutionUnsafe: row.labelExecutionUnsafe,
            },
          });
          persisted++;
        } catch (err: unknown) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
  } else if (dryRun) {
    persisted = 0;
  }

  return {
    examplesBuilt: rows.length,
    examplesSkipped,
    errors,
    persisted,
  };
}
