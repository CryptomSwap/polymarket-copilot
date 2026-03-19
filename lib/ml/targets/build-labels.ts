/**
 * Reusable label generation helpers.
 * Delegates to shadow-dataset deriveLabels for outcome-based; horizon-based can be added here.
 */

import { deriveLabels } from "@/lib/ml/shadow-dataset/build";
import type { OutcomeClassification } from "@/lib/ml/shadow-dataset/types";

export { deriveLabels };

/**
 * Derive horizon-specific good-decision label from markout and side.
 * Favorable (markout > 0) -> good if we allowed; bad if we blocked (missed opportunity).
 * Used for labelGoodDecision6h / 12h when markout at that horizon is available.
 */
export function deriveGoodDecisionFromMarkout(
  wasBlocked: boolean,
  markoutValue: number | null,
  side: string
): boolean | null {
  if (markoutValue == null || !Number.isFinite(markoutValue)) return null;
  const favorable = markoutValue > 0;
  if (wasBlocked) return !favorable; // good_block if unfavorable, bad_block (missed opp) if favorable
  return favorable; // good_allow if favorable, bad_allow if not
}

/**
 * Build labels for registry target key from raw outcome/markouts.
 * Only implements keys that are implemented in the registry; others return null.
 */
export function buildLabelForTarget(
  targetKey: string,
  outcome: OutcomeClassification | null,
  wasBlocked: boolean,
  executionQualityHadBlocks: boolean,
  markout6h: number | null,
  markout12h: number | null,
  markout24h: number | null,
  side: string
): boolean | null {
  const labels = deriveLabels(outcome, wasBlocked, executionQualityHadBlocks);
  switch (targetKey) {
    case "labelGoodDecision":
      return labels.labelGoodDecision;
    case "labelMissedOpportunity":
      return labels.labelMissedOpportunity;
    case "labelGoodDecision6h":
      return deriveGoodDecisionFromMarkout(wasBlocked, markout6h, side);
    case "labelGoodDecision12h":
      return deriveGoodDecisionFromMarkout(wasBlocked, markout12h, side);
    case "labelGoodDecision24h":
      return deriveGoodDecisionFromMarkout(wasBlocked, markout24h, side);
    default:
      return null;
  }
}
