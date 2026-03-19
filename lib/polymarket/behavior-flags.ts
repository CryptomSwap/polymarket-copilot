/**
 * BehaviorFlag source scoping: which policy layers a row informs.
 *
 * - automation / runtime → counted toward automation behaviorPenalty (paper + live signal gating).
 * - manual → discretionary account activity; must NOT poison automation behaviorPenalty.
 * - portfolio → account concentration / stacking from positions; portfolio-fit still uses
 *   DerivedPosition / theme exposure (topThemeConcentrationPct, etc.); these flags are auditable mirrors.
 */

export const BEHAVIOR_FLAG_SOURCE_SCOPES = [
  "automation",
  "manual",
  "portfolio",
  "runtime",
] as const;

export type BehaviorFlagSourceScope = (typeof BEHAVIOR_FLAG_SOURCE_SCOPES)[number];

export const AUTOMATION_BEHAVIOR_PENALTY_SCOPES: readonly BehaviorFlagSourceScope[] = [
  "automation",
  "runtime",
];

export function scopeCountsTowardAutomationBehaviorPenalty(
  sourceScope: string | null | undefined
): boolean {
  if (!sourceScope) return false;
  return (AUTOMATION_BEHAVIOR_PENALTY_SCOPES as readonly string[]).includes(sourceScope);
}

/** Same thresholds as signals.ts behaviorPenalty (last N flags in window). */
export function penaltyFromSeverityCounts(high: number, medium: number): number {
  if (high >= 2) return 0.3;
  if (high >= 1 || medium >= 2) return 0.15;
  return 0;
}

export function deriveBehaviorPenaltyFromRows(
  rows: { severity: string }[]
): number {
  const high = rows.filter((f) => f.severity === "high").length;
  const medium = rows.filter((f) => f.severity === "medium").length;
  return penaltyFromSeverityCounts(high, medium);
}

export function deriveAutomationBehaviorPenaltyFromRows(
  rows: { severity: string; sourceScope: string | null }[]
): number {
  const scoped = rows.filter((r) => scopeCountsTowardAutomationBehaviorPenalty(r.sourceScope));
  return deriveBehaviorPenaltyFromRows(scoped);
}
