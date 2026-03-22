/**
 * Paper-only helpers for daily-cap overflow routing (score/exploration resolution on alternate bots).
 * Shared with tests; admission semantics must match engine threshold/exploration order.
 * `admissionScore` must be the same value as `paperShadowAdmissionScore(result, config)` in engine.ts.
 */

import type { PaperDecisionRejectReasonCode } from "./decision-trace-types";

export function paperAdmissionExplorationResolveForDailyCapOverflow(params: {
  admissionScore: number;
  effectiveMinScore: number;
  explorationEnabledForBot: boolean;
  explorationBandBelowMinScore: number;
  explorationMinScore: number;
  explorationMaxPerTick: number;
  explorationMaxPerDay: number;
  explorationOpenedForBot: number;
  explorationCreatedToday: number;
}):
  | { ok: true; mode: "threshold" | "exploration"; withinExplorationBandOnReject: boolean }
  | { ok: false; reject: PaperDecisionRejectReasonCode; withinExplorationBandOnReject: boolean } {
  const {
    admissionScore,
    effectiveMinScore,
    explorationEnabledForBot,
    explorationBandBelowMinScore,
    explorationMinScore,
    explorationMaxPerTick,
    explorationMaxPerDay,
    explorationOpenedForBot,
    explorationCreatedToday,
  } = params;

  if (admissionScore >= effectiveMinScore) {
    return { ok: true, mode: "threshold", withinExplorationBandOnReject: false };
  }

  const withinExplorationBand =
    explorationEnabledForBot &&
    explorationBandBelowMinScore > 0 &&
    admissionScore >= explorationMinScore &&
    admissionScore < effectiveMinScore;
  const underPerTickCap =
    explorationMaxPerTick > 0 ? explorationOpenedForBot < explorationMaxPerTick : false;
  const underPerDayCap =
    explorationMaxPerDay > 0
      ? explorationCreatedToday + explorationOpenedForBot < explorationMaxPerDay
      : true;

  if (withinExplorationBand && underPerTickCap && underPerDayCap) {
    return { ok: true, mode: "exploration", withinExplorationBandOnReject: true };
  }

  const reject: PaperDecisionRejectReasonCode = !withinExplorationBand
    ? "outside_exploration_band"
    : !underPerTickCap
      ? "exploration_cap_tick"
      : "exploration_cap_day";
  return { ok: false, reject, withinExplorationBandOnReject: withinExplorationBand };
}
