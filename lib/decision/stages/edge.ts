/**
 * Edge assessment stage: thesis strength only. No concentration or sizing.
 * Heuristic + ML + news (as edge modifiers) + setup history.
 */

import type { EdgeResult, EdgeState, StagedDecisionInput } from "./types";

const ML_WEIGHT = 0.35;
const HEURISTIC_WEIGHT = 1 - ML_WEIGHT;
const EDGE_HIGH = 0.65;
const EDGE_MEDIUM = 0.45;
const EDGE_LOW = 0.25;

export function evaluateEdge(input: StagedDecisionInput): EdgeResult {
  const reasons: string[] = [];
  let base = input.heuristicPriorityScore;
  if (input.mlScore != null && Number.isFinite(input.mlScore)) {
    base = HEURISTIC_WEIGHT * input.heuristicPriorityScore + ML_WEIGHT * input.mlScore;
    reasons.push(`Edge: heuristic ${input.heuristicPriorityScore.toFixed(2)}, ML ${input.mlScore.toFixed(2)}.`);
  } else {
    reasons.push(`Edge: heuristic ${input.heuristicPriorityScore.toFixed(2)} (no ML).`);
  }

  let conviction = base;
  conviction += Math.min(0.1, Math.max(0, input.newsCatalystBoost));
  conviction -= Math.min(0.2, Math.max(0, input.newsSaturationPenalty));
  if (input.setupSampleCount >= 5 && input.setupActedWinRate != null) {
    if (input.setupActedWinRate > 0.55) {
      conviction += 0.05;
      reasons.push("Strong setup history.");
    } else if (input.setupActedWinRate < 0.4) {
      conviction -= 0.05;
      reasons.push("Weak setup history.");
    }
  }
  if (input.setupOverrideWinRate != null && input.setupOverrideWinRate < 0.4) {
    conviction -= 0.03;
    reasons.push("Override underperformed.");
  }
  conviction = Math.max(0, Math.min(1, conviction));

  let edgeState: EdgeState = "low";
  if (conviction >= EDGE_HIGH) edgeState = "high";
  else if (conviction >= EDGE_MEDIUM) edgeState = "medium";
  else if (conviction < EDGE_LOW && conviction > 0) edgeState = "low";
  else if (conviction <= 0) edgeState = "negative";

  return { edgeState, convictionScore: conviction, edgeReasons: reasons };
}
