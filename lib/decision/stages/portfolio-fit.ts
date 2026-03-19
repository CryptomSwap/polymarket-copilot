/**
 * Portfolio fit stage: concentration, behavior, portfolio penalty.
 * Uses structured thresholds; outputs state and penalty for sizing. Does not change edge.
 */

import type { PortfolioFitResult, PortfolioFitState, StagedDecisionInput } from "./types";

const THEME_EXPOSURE_BLOCK = 30;
const TOP_CONC_BLOCK = 50;
const THEME_WARN = 15;
const TOP_CONC_WARN = 25;
const BEHAVIOR_PENALTY_BLOCK = 0.25;
const PORTFOLIO_PENALTY_BLOCK = 0.3;

export function evaluatePortfolioFit(input: StagedDecisionInput): PortfolioFitResult {
  const reasons: string[] = [];
  let penalty = 0;
  let state: PortfolioFitState = "ok";

  if (input.themeExposurePct > THEME_EXPOSURE_BLOCK) {
    reasons.push("High theme exposure.");
    penalty += Math.min(0.15, (input.themeExposurePct / 100) * 0.5);
  } else if (input.themeExposurePct > THEME_WARN) {
    reasons.push("Moderate theme exposure.");
  }
  if (input.topThemeConcentrationPct >= TOP_CONC_BLOCK) {
    reasons.push("High concentration.");
    penalty += Math.min(0.2, (input.topThemeConcentrationPct / 100) * 0.3);
  } else if (input.topThemeConcentrationPct < TOP_CONC_WARN && input.topThemeConcentrationPct > 0) {
    reasons.push("Low concentration.");
  }
  if (input.behaviorPenalty >= BEHAVIOR_PENALTY_BLOCK) {
    reasons.push("Behavior flags.");
    penalty += Math.min(0.15, input.behaviorPenalty);
  }
  if (input.portfolioPenalty >= PORTFOLIO_PENALTY_BLOCK) {
    reasons.push("Portfolio overconcentrated.");
    penalty += Math.min(0.15, input.portfolioPenalty);
  }

  if (input.topThemeConcentrationPct >= TOP_CONC_BLOCK || input.behaviorPenalty >= BEHAVIOR_PENALTY_BLOCK || input.portfolioPenalty >= PORTFOLIO_PENALTY_BLOCK) {
    state = "block";
  } else if (penalty > 0 || reasons.length > 0) {
    state = "caution";
  }

  penalty = Math.min(0.5, penalty);
  return { portfolioFitState: state, portfolioFitPenalty: penalty, reasons };
}
