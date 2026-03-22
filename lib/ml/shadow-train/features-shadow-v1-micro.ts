/**
 * Experimental shadow feature set: shadow_v1 + micro add-ons from existing MlShadowTrainingExample columns.
 * Paper / audit only — not wired into default trainShadowModel until validated.
 *
 * Additions (no fabricated data; parse/encode only):
 * - depthSufficiency, quoteFreshnessState (execution-quality snapshots)
 * - workingOrderExposure, worstCaseLossEstimate (portfolio snapshot numerics)
 */

import {
  toShadowFeatureVector,
  SHADOW_FEATURE_NAMES,
  type ShadowFeatureInput,
} from "./features";

export const SHADOW_FEATURE_SET_V1_MICRO = "shadow_v1_micro";

/** Conservative string → numeric encodings; unknown → 0 */
const DEPTH_SUFFICIENCY_ENC: Record<string, number> = {
  sufficient: 1,
  insufficient: 2,
  marginal: 3,
  thin: 4,
  unknown: 5,
};

const QUOTE_FRESHNESS_ENC: Record<string, number> = {
  fresh: 1,
  stale: 2,
  soft_stale: 3,
  hard_stale: 4,
  unknown: 5,
};

function parseNum(s: string | number | null | undefined): number {
  if (s == null || s === "") return 0;
  if (typeof s === "number") return Number.isFinite(s) ? s : 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

function encLoose(state: string | null | undefined, map: Record<string, number>): number {
  if (state == null) return 0;
  const k = String(state).toLowerCase().trim().replace(/\s+/g, "_");
  return map[k] ?? 0;
}

export interface ShadowFeatureInputMicro extends ShadowFeatureInput {
  depthSufficiency?: string | null;
  quoteFreshnessState?: string | null;
  workingOrderExposure?: string | null;
  worstCaseLossEstimate?: string | null;
}

export const SHADOW_MICRO_SUFFIX_NAMES = [
  "depthSufficiencyEnc",
  "quoteFreshnessEnc",
  "workingOrderExposureNum",
  "worstCaseLossEstimateNum",
] as const;

export const SHADOW_FEATURE_NAMES_V1_MICRO: string[] = [
  ...SHADOW_FEATURE_NAMES,
  ...SHADOW_MICRO_SUFFIX_NAMES,
];

/**
 * v1 vector + 4 micro features (same row order contract: append only).
 */
export function toShadowFeatureVectorV1Micro(row: ShadowFeatureInputMicro): number[] {
  const base = toShadowFeatureVector(row);
  return [
    ...base,
    encLoose(row.depthSufficiency, DEPTH_SUFFICIENCY_ENC),
    encLoose(row.quoteFreshnessState, QUOTE_FRESHNESS_ENC),
    parseNum(row.workingOrderExposure),
    parseNum(row.worstCaseLossEstimate),
  ];
}
