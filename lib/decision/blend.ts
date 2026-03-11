/**
 * Blended score: heuristic + ML + news + portfolio + behavior + setup performance + review state.
 * Advisory only; hard blocks are applied in policy layer.
 */

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export interface SetupAdjustmentInput {
  actedWinRate: number | null;
  ignoredWinRate: number | null;
  avgForwardReturn24h: number | null;
  overrideWinRate: number | null;
  sampleCount: number;
}

export interface BlendInput {
  heuristicPriorityScore: string;
  mlScore: string | null;
  newsCatalystBoost: number;
  newsSaturationPenalty: number;
  themeExposurePct: number;
  topConcentrationPct: number;
  behaviorPenalty: number;
  portfolioPenalty: number;
  setupAdjustment: SetupAdjustmentInput;
  reviewStatus: string;
  blockedReason: string | null;
  action: string;
}

export interface ReasoningBreakdown {
  heuristicScore: number;
  mlScore: number | null;
  mlWeight: number;
  newsCatalystBoost: number;
  newsSaturationPenalty: number;
  concentrationPenalty: number;
  behaviorPenalty: number;
  portfolioPenalty: number;
  setupAdjustment: number;
  reviewAdjustment: number;
  blendedRaw: number;
  blendedClamped: number;
  blockers: string[];
  supportive: string[];
}

/**
 * Compute blended score and reasoning. Does not apply policy; policy layer uses this + hard rules.
 */
export function computeBlendedScore(input: BlendInput): {
  blendedScore: number;
  reasoning: ReasoningBreakdown;
} {
  const heuristic = parseNum(input.heuristicPriorityScore);
  const ml = input.mlScore != null ? parseNum(input.mlScore) : null;
  const themeExp = input.themeExposurePct;
  const topConc = input.topConcentrationPct;
  const behPen = input.behaviorPenalty;
  const portPen = input.portfolioPenalty;
  const setup = input.setupAdjustment;

  const blockers: string[] = [];
  const supportive: string[] = [];

  if (input.blockedReason) blockers.push(input.blockedReason);
  if (themeExp > 30) blockers.push("High theme exposure");
  else if (themeExp > 15) supportive.push("Moderate theme exposure");
  if (topConc > 50) blockers.push("High concentration");
  else if (topConc < 25) supportive.push("Low concentration");
  if (behPen >= 0.25) blockers.push("Behavior flags");
  if (portPen >= 0.3) blockers.push("Portfolio overconcentrated");
  if (input.newsSaturationPenalty >= 0.15) blockers.push("News saturation");
  if (input.newsCatalystBoost > 0.03) supportive.push("Catalyst support");
  if (ml != null && ml > 0.6) supportive.push("ML support");
  if (input.reviewStatus === "APPROVED") supportive.push("Review approved");
  else if (input.reviewStatus === "REJECTED") blockers.push("Review rejected");

  let setupAdjust = 0;
  if (setup.sampleCount >= 5 && setup.actedWinRate != null) {
    if (setup.actedWinRate > 0.55) {
      setupAdjust = 0.05;
      supportive.push("Strong setup history");
    } else if (setup.actedWinRate < 0.4) {
      setupAdjust = -0.05;
      blockers.push("Weak setup history");
    }
  }
  if (setup.overrideWinRate != null && setup.overrideWinRate < 0.4) {
    setupAdjust -= 0.03;
    blockers.push("Override underperformed");
  }

  let reviewAdjust = 0;
  if (input.reviewStatus === "APPROVED") reviewAdjust = 0.05;
  else if (input.reviewStatus === "REJECTED") reviewAdjust = -0.15;
  else if (input.reviewStatus === "REVIEWED") reviewAdjust = 0.02;

  const concentrationPenalty = Math.min(0.2, (themeExp / 100) * 0.5 + (topConc / 100) * 0.3);
  const mlWeight = ml != null ? 0.35 : 0;
  const heuristicWeight = 1 - mlWeight;
  const baseScore = heuristicWeight * heuristic + (ml != null ? mlWeight * ml : 0);
  const blendedRaw =
    baseScore +
    Math.min(0.1, input.newsCatalystBoost) -
    Math.min(0.2, input.newsSaturationPenalty) -
    concentrationPenalty -
    Math.min(0.15, behPen) -
    Math.min(0.15, portPen) +
    setupAdjust +
    reviewAdjust;
  const blendedClamped = Math.max(0, Math.min(1, blendedRaw));

  const reasoning: ReasoningBreakdown = {
    heuristicScore: heuristic,
    mlScore: ml,
    mlWeight,
    newsCatalystBoost: input.newsCatalystBoost,
    newsSaturationPenalty: input.newsSaturationPenalty,
    concentrationPenalty,
    behaviorPenalty: behPen,
    portfolioPenalty: portPen,
    setupAdjustment: setupAdjust,
    reviewAdjustment: reviewAdjust,
    blendedRaw,
    blendedClamped,
    blockers,
    supportive,
  };

  return { blendedScore: blendedClamped, reasoning };
}
