/**
 * Eligibility stage: hard blockers only. No score decay; explicit eligible/blockers/warnings.
 */

import type { EligibilityResult, StagedDecisionInput } from "./types";

const CHASE_TYPES = ["LATE_CHASE", "CHASING"];

export function evaluateEligibility(input: StagedDecisionInput): EligibilityResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (input.blockedReason && input.blockedReason.trim()) {
    blockers.push(input.blockedReason.trim());
  }
  if (input.qualityBlocker && input.qualityBlocker.trim()) {
    blockers.push(input.qualityBlocker.trim());
  }
  if (input.reviewStatus === "REJECTED") {
    blockers.push("Review rejected.");
  }
  if (
    input.action === "NO_TRADE" &&
    (input.blockedReason || input.qualityBlocker) &&
    !blockers.some((b) => b.toLowerCase().includes("review"))
  ) {
    // Already added above; ensure no duplicate
  }
  if (
    input.signalType &&
    CHASE_TYPES.includes(input.signalType) &&
    (input.heuristicPriorityScore < 0.6 || (input.mlScore != null && input.mlScore < 0.6))
  ) {
    blockers.push("Chase setup with low conviction.");
  }

  if (input.reviewStatus !== "APPROVED" && input.reviewStatus !== "REJECTED" && input.reviewStatus !== "REVIEWED") {
    warnings.push("Recommendation not yet reviewed.");
  }

  const eligible = blockers.length === 0;
  return { eligible, blockers, warnings };
}
