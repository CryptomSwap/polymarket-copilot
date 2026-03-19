/**
 * ML target/label key types for multi-target support.
 * Additive; current active target remains labelGoodDecision / labelGoodDecision12h where used.
 */

/** Canonical target keys for shadow/recommendation ML. */
export type MlTargetKey =
  | "labelGoodDecision"
  | "labelGoodDecision6h"
  | "labelGoodDecision12h"
  | "labelGoodDecision24h"
  | "labelSpreadAdjustedGoodDecision12h"
  | "labelRealizablePnlPositive12h"
  | "labelPositive6h"
  | "labelPositive24h"
  | "labelMissedOpportunity";

/** Horizon in hours for the target (null if N/A). */
export function getTargetHorizonHours(key: MlTargetKey): number | null {
  if (key === "labelGoodDecision6h" || key === "labelPositive6h") return 6;
  if (key === "labelGoodDecision12h" || key === "labelSpreadAdjustedGoodDecision12h" || key === "labelRealizablePnlPositive12h") return 12;
  if (key === "labelGoodDecision24h" || key === "labelPositive24h") return 24;
  return null;
}
