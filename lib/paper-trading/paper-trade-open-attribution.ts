/**
 * Rich open-time attribution for PaperTrade.metadataJson (paper only).
 * Read-only analytics join to execution context at admission without widening the Prisma row.
 */

import type { ShadowScoreInput, ShadowScoreResult } from "@/lib/ml/shadow-score/types";
import { scoreBandFromShadowProba, type PaperScoreBand } from "./paper-score-band";

export interface PaperTradeExecutionContext {
  spreadBps: number | null;
  estimatedSlippageBps: number | null;
  blockedIndicator: boolean | null;
  qualityState: string | null;
  policyState: string | null;
  executionAllow: boolean | null;
  tradable: boolean | null;
}

/** Subset of path/regime features when present on the scoring input (telemetry may omit). */
export interface PaperTradePathFeatureSummary {
  momentum1hBps?: string | null;
  momentum6hBps?: string | null;
  volatility1hBps?: string | null;
  volatility6hBps?: string | null;
  distanceFromMid?: string | null;
  timeToCloseHours?: string | null;
  liquidityTrend?: string | null;
}

/** Paper-only shadow score calibration audit (raw logistic vs temperature-scaled). */
export interface PaperShadowScoreCalibrationMeta {
  shadowMlScoreRaw: number;
  shadowMlLogit: number | null;
  shadowMlScoreCalibrated: number;
  logitTemperature: number;
  usedCalibratedForAdmission: boolean;
  /** Score compared to min threshold / sizing (may equal calibrated or raw). */
  admissionScore: number;
}

/** Paper-only ROI tuning metadata (admission floor, sizing, liquidity guards at open). */
export interface PaperRoiAdmissionMeta {
  effectiveMinScoreUsed: number;
  baseMinScoreBeforePaperOverride: number;
  globalPaperMinScoreOverride: number | null;
  botPaperMinScoreOverride: number | null;
  admittedUnderTightenedPaperThreshold: boolean;
  sizeByScoreEnabled: boolean;
  sizeScoreBucketLabel: string;
  paperSizeMultiplier: number;
  spreadBpsAtAdmission: number | null;
  estimatedSlippageBpsAtAdmission: number | null;
  blockedBySpreadGuard: false;
  blockedBySlippageGuard: false;
}

export interface PaperTradeOpenAttribution {
  modelRunId: string;
  targetLabel: string;
  featureSetName: string;
  score: number;
  scoreBand: PaperScoreBand;
  thresholdUsed: number;
  minScoreUsed: number;
  shadowCandidateId: string | null;
  candidateId: string | null;
  featureCompletenessWarnings: string[];
  executionContext: PaperTradeExecutionContext;
  pathFeatureSummary: PaperTradePathFeatureSummary;
  /** Present on opens after paper ROI tuning shipped; omitted on older rows. */
  paperRoiAdmission?: PaperRoiAdmissionMeta;
  /** Raw vs calibrated shadow probability at open; omitted on older rows. */
  paperShadowScoreCalibration?: PaperShadowScoreCalibrationMeta;
}

function parseSpreadBps(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

/** Shadow pipeline stores estimated slippage as decimal fraction (see candidates.ts). */
function estimatedSlippageToBps(fraction: string | null | undefined): number | null {
  if (fraction == null || fraction === "") return null;
  const n = parseFloat(String(fraction).trim());
  if (!Number.isFinite(n)) return null;
  return n * 10_000;
}

export function buildExecutionContextFromShadowInput(input: ShadowScoreInput): PaperTradeExecutionContext {
  return {
    spreadBps: parseSpreadBps(input.spreadBps ?? null),
    estimatedSlippageBps: estimatedSlippageToBps(input.estimatedSlippage ?? null),
    blockedIndicator: typeof input.blockedIndicator === "boolean" ? input.blockedIndicator : null,
    qualityState: input.qualityState ?? null,
    policyState: input.policyState ?? null,
    executionAllow: typeof input.executionAllow === "boolean" ? input.executionAllow : null,
    tradable: typeof input.tradable === "boolean" ? input.tradable : null,
  };
}

export function buildPathFeatureSummaryFromShadowInput(input: ShadowScoreInput): PaperTradePathFeatureSummary {
  const keys = [
    "momentum1hBps",
    "momentum6hBps",
    "volatility1hBps",
    "volatility6hBps",
    "distanceFromMid",
    "timeToCloseHours",
    "liquidityTrend",
  ] as const;
  const out: PaperTradePathFeatureSummary = {};
  for (const k of keys) {
    const v = input[k];
    if (v != null && String(v).trim() !== "") {
      out[k] = v;
    }
  }
  return out;
}

export function buildPaperTradeOpenAttribution(args: {
  shadowResult: ShadowScoreResult;
  thresholdUsed: number;
  minScoreUsed: number;
  shadowCandidateId?: string | null;
  shadowInput: ShadowScoreInput;
  paperRoiAdmission?: PaperRoiAdmissionMeta | null;
  paperShadowScoreCalibration?: PaperShadowScoreCalibrationMeta | null;
}): PaperTradeOpenAttribution {
  const sid = args.shadowCandidateId?.trim() || null;
  const score = args.shadowResult.shadowMlScore;
  const base: PaperTradeOpenAttribution = {
    modelRunId: args.shadowResult.modelId,
    targetLabel: args.shadowResult.modelTargetLabel,
    featureSetName: args.shadowResult.modelFeatureSet,
    score,
    scoreBand: args.shadowResult.shadowMlScoreBand ?? scoreBandFromShadowProba(score),
    thresholdUsed: args.thresholdUsed,
    minScoreUsed: args.minScoreUsed,
    shadowCandidateId: sid,
    candidateId: sid,
    featureCompletenessWarnings: [...args.shadowResult.featureCompletenessWarnings],
    executionContext: buildExecutionContextFromShadowInput(args.shadowInput),
    pathFeatureSummary: buildPathFeatureSummaryFromShadowInput(args.shadowInput),
  };
  const withRoi =
    args.paperRoiAdmission != null ? { ...base, paperRoiAdmission: args.paperRoiAdmission } : base;
  if (args.paperShadowScoreCalibration != null) {
    return { ...withRoi, paperShadowScoreCalibration: args.paperShadowScoreCalibration };
  }
  return withRoi;
}

/** Merge openAttribution into paper trade metadata (preserves existing keys like recommendationId). */
export function mergeOpenAttributionIntoMetadata(
  base: Record<string, unknown>,
  attribution: PaperTradeOpenAttribution
): Record<string, unknown> {
  return {
    ...base,
    openAttribution: attribution,
  };
}

export function parseOpenAttributionFromMetadataJson(
  raw: string | null | undefined
): PaperTradeOpenAttribution | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const a = o.openAttribution as Record<string, unknown> | undefined;
    if (!a || typeof a !== "object") return null;
    const exec = (a.executionContext ?? {}) as Record<string, unknown>;
    const path = (a.pathFeatureSummary ?? {}) as Record<string, unknown>;
    const roi = a.paperRoiAdmission as Record<string, unknown> | undefined;
    const calRaw = a.paperShadowScoreCalibration as Record<string, unknown> | undefined;
    const score = typeof a.score === "number" ? a.score : parseFloat(String(a.score));
    if (!Number.isFinite(score)) return null;
    const bandRaw = a.scoreBand;
    const scoreBand =
      bandRaw === "low" || bandRaw === "medium" || bandRaw === "high"
        ? bandRaw
        : scoreBandFromShadowProba(score);
    let paperShadowScoreCalibration: PaperShadowScoreCalibrationMeta | undefined;
    if (calRaw && typeof calRaw === "object") {
      const rawP =
        typeof calRaw.shadowMlScoreRaw === "number"
          ? calRaw.shadowMlScoreRaw
          : parseFloat(String(calRaw.shadowMlScoreRaw));
      const calP =
        typeof calRaw.shadowMlScoreCalibrated === "number"
          ? calRaw.shadowMlScoreCalibrated
          : parseFloat(String(calRaw.shadowMlScoreCalibrated));
      const adm =
        typeof calRaw.admissionScore === "number"
          ? calRaw.admissionScore
          : parseFloat(String(calRaw.admissionScore));
      const temp =
        typeof calRaw.logitTemperature === "number"
          ? calRaw.logitTemperature
          : parseFloat(String(calRaw.logitTemperature ?? "1"));
      if (Number.isFinite(rawP) && Number.isFinite(calP) && Number.isFinite(adm) && Number.isFinite(temp)) {
        const lz =
          calRaw.shadowMlLogit == null
            ? null
            : typeof calRaw.shadowMlLogit === "number"
              ? calRaw.shadowMlLogit
              : parseFloat(String(calRaw.shadowMlLogit));
        paperShadowScoreCalibration = {
          shadowMlScoreRaw: rawP,
          shadowMlLogit: lz != null && Number.isFinite(lz) ? lz : null,
          shadowMlScoreCalibrated: calP,
          logitTemperature: temp,
          usedCalibratedForAdmission: calRaw.usedCalibratedForAdmission === true,
          admissionScore: adm,
        };
      }
    }

    let paperRoiAdmission: PaperRoiAdmissionMeta | undefined;
    if (roi && typeof roi === "object") {
      const eff = typeof roi.effectiveMinScoreUsed === "number" ? roi.effectiveMinScoreUsed : parseFloat(String(roi.effectiveMinScoreUsed));
      const baseB =
        typeof roi.baseMinScoreBeforePaperOverride === "number"
          ? roi.baseMinScoreBeforePaperOverride
          : parseFloat(String(roi.baseMinScoreBeforePaperOverride));
      if (Number.isFinite(eff) && Number.isFinite(baseB)) {
        paperRoiAdmission = {
          effectiveMinScoreUsed: eff,
          baseMinScoreBeforePaperOverride: baseB,
          globalPaperMinScoreOverride:
            roi.globalPaperMinScoreOverride == null
              ? null
              : typeof roi.globalPaperMinScoreOverride === "number"
                ? roi.globalPaperMinScoreOverride
                : parseFloat(String(roi.globalPaperMinScoreOverride)),
          botPaperMinScoreOverride:
            roi.botPaperMinScoreOverride == null
              ? null
              : typeof roi.botPaperMinScoreOverride === "number"
                ? roi.botPaperMinScoreOverride
                : parseFloat(String(roi.botPaperMinScoreOverride)),
          admittedUnderTightenedPaperThreshold: roi.admittedUnderTightenedPaperThreshold === true,
          sizeByScoreEnabled: roi.sizeByScoreEnabled === true,
          sizeScoreBucketLabel: String(roi.sizeScoreBucketLabel ?? ""),
          paperSizeMultiplier:
            typeof roi.paperSizeMultiplier === "number"
              ? roi.paperSizeMultiplier
              : parseFloat(String(roi.paperSizeMultiplier ?? "1")) || 1,
          spreadBpsAtAdmission:
            typeof roi.spreadBpsAtAdmission === "number" ? roi.spreadBpsAtAdmission : null,
          estimatedSlippageBpsAtAdmission:
            typeof roi.estimatedSlippageBpsAtAdmission === "number"
              ? roi.estimatedSlippageBpsAtAdmission
              : null,
          blockedBySpreadGuard: false,
          blockedBySlippageGuard: false,
        };
      }
    }

    return {
      modelRunId: String(a.modelRunId ?? ""),
      targetLabel: String(a.targetLabel ?? ""),
      featureSetName: String(a.featureSetName ?? ""),
      score,
      scoreBand,
      thresholdUsed: typeof a.thresholdUsed === "number" ? a.thresholdUsed : parseFloat(String(a.thresholdUsed)),
      minScoreUsed: typeof a.minScoreUsed === "number" ? a.minScoreUsed : parseFloat(String(a.minScoreUsed)),
      shadowCandidateId: a.shadowCandidateId != null ? String(a.shadowCandidateId) : null,
      candidateId: a.candidateId != null ? String(a.candidateId) : null,
      featureCompletenessWarnings: Array.isArray(a.featureCompletenessWarnings)
        ? (a.featureCompletenessWarnings as unknown[]).map((x) => String(x))
        : [],
      ...(paperRoiAdmission != null && { paperRoiAdmission }),
      ...(paperShadowScoreCalibration != null && { paperShadowScoreCalibration }),
      executionContext: {
        spreadBps: typeof exec.spreadBps === "number" ? exec.spreadBps : null,
        estimatedSlippageBps: typeof exec.estimatedSlippageBps === "number" ? exec.estimatedSlippageBps : null,
        blockedIndicator: typeof exec.blockedIndicator === "boolean" ? exec.blockedIndicator : null,
        qualityState: exec.qualityState != null ? String(exec.qualityState) : null,
        policyState: exec.policyState != null ? String(exec.policyState) : null,
        executionAllow: typeof exec.executionAllow === "boolean" ? exec.executionAllow : null,
        tradable: typeof exec.tradable === "boolean" ? exec.tradable : null,
      },
      pathFeatureSummary: {
        momentum1hBps: path.momentum1hBps != null ? String(path.momentum1hBps) : undefined,
        momentum6hBps: path.momentum6hBps != null ? String(path.momentum6hBps) : undefined,
        volatility1hBps: path.volatility1hBps != null ? String(path.volatility1hBps) : undefined,
        volatility6hBps: path.volatility6hBps != null ? String(path.volatility6hBps) : undefined,
        distanceFromMid: path.distanceFromMid != null ? String(path.distanceFromMid) : undefined,
        timeToCloseHours: path.timeToCloseHours != null ? String(path.timeToCloseHours) : undefined,
        liquidityTrend: path.liquidityTrend != null ? String(path.liquidityTrend) : undefined,
      },
    };
  } catch {
    return null;
  }
}

export function resolveScoreBandForPaperTrade(score: number, metadataJson: string | null | undefined): PaperScoreBand {
  const parsed = parseOpenAttributionFromMetadataJson(metadataJson);
  if (parsed?.scoreBand) return parsed.scoreBand;
  return scoreBandFromShadowProba(score);
}
