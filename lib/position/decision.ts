/**
 * Position exit decision logic: HOLD, TRIM, REDUCE, EXIT, TAKE_PROFIT, THESIS_BROKEN.
 * Uses unrealized PnL, entry vs price, recommendation state, concentration, time, behavior, setup history.
 * Advisory only; no autonomous exits.
 */

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export type PositionDecisionState =
  | "HOLD"
  | "TRIM"
  | "REDUCE"
  | "EXIT"
  | "TAKE_PROFIT"
  | "THESIS_BROKEN";

export interface PositionContext {
  funderAddress: string;
  assetId: string;
  marketId: string;
  size: string;
  avgEntry: string;
  lastPrice: string;
  unrealizedPnl: string;
  marketValue: string;
  category: string | null;
  theme: string | null;
  /** Top concentration % for this position's theme or asset */
  concentrationPct: number;
  /** Days to market end (null if no end date) */
  daysToResolution: number | null;
  /** Latest recommendation policy state for this market/outcome if any */
  recommendationPolicyState: string | null;
  /** Whether any behavior flag applies (e.g. OVERCONCENTRATION) */
  hasBehaviorFlag: boolean;
  /** Setup profile acted win rate for this theme/category (0-1 or null) */
  setupActedWinRate: number | null;
  /** News link count for this market (saturation proxy) */
  linkedNewsCount: number;
  /** Unrealized PnL as fraction of cost basis (e.g. 0.2 = 20% profit) */
  unrealizedPnlFraction: number;
}

export interface PositionDecisionResult {
  decisionState: PositionDecisionState;
  confidence: number;
  suggestedExitSize: string;
  reasoning: string[];
}

/**
 * Compute exit decision for a position from context. Pure heuristic; no side effects.
 */
export function computePositionDecision(ctx: PositionContext): PositionDecisionResult {
  const size = parseNum(ctx.size);
  const avgEntry = parseNum(ctx.avgEntry);
  const lastPrice = parseNum(ctx.lastPrice);
  const unrealizedPnl = parseNum(ctx.unrealizedPnl);
  const costBasis = Math.abs(parseNum(ctx.size) * parseNum(ctx.avgEntry));
  const reasoning: string[] = [];

  if (size <= 0) {
    return {
      decisionState: "HOLD",
      confidence: 0,
      suggestedExitSize: "0",
      reasoning: ["No position size."],
    };
  }

  const pnlFraction = costBasis > 0 ? unrealizedPnl / costBasis : 0;
  const priceDeterioration = avgEntry > 0 ? (avgEntry - lastPrice) / avgEntry : 0; // positive if price fell

  // Strong profit → consider TAKE_PROFIT
  if (pnlFraction >= 0.25) {
    reasoning.push(`Unrealized profit ${(pnlFraction * 100).toFixed(0)}% of cost.`);
  }
  // Strong loss with thesis at risk → THESIS_BROKEN or EXIT
  if (pnlFraction <= -0.15 && (ctx.recommendationPolicyState === "EXIT" || ctx.recommendationPolicyState === "BLOCK")) {
    reasoning.push("Loss and recommendation suggests exit or block.");
  }

  // Concentration pressure → TRIM or REDUCE
  if (ctx.concentrationPct >= 35) {
    reasoning.push(`High concentration (${ctx.concentrationPct.toFixed(0)}%).`);
  }
  if (ctx.hasBehaviorFlag) {
    reasoning.push("Behavior flag (e.g. overconcentration) applies.");
  }

  // Time to resolution
  if (ctx.daysToResolution != null && ctx.daysToResolution <= 1) {
    reasoning.push("Near resolution.");
  }

  // News saturation
  if (ctx.linkedNewsCount >= 5) {
    reasoning.push("High news link count; possible saturation.");
  }

  // Setup underperformance
  if (ctx.setupActedWinRate != null && ctx.setupActedWinRate < 0.4) {
    reasoning.push("Historical setup win rate below 40%.");
  }

  let decisionState: PositionDecisionState = "HOLD";
  let confidence = 0.5;
  let exitFraction = 0;

  // THESIS_BROKEN: recommendation says EXIT/BLOCK and we're in loss
  if (
    (ctx.recommendationPolicyState === "EXIT" || ctx.recommendationPolicyState === "BLOCK") &&
    pnlFraction <= -0.1
  ) {
    decisionState = "THESIS_BROKEN";
    confidence = Math.min(0.95, 0.6 + Math.abs(pnlFraction));
    exitFraction = 1;
    reasoning.push("Decision: THESIS_BROKEN (recommendation exit/block + loss).");
  }
  // TAKE_PROFIT: strong profit, lock in
  else if (pnlFraction >= 0.3) {
    decisionState = "TAKE_PROFIT";
    confidence = 0.6 + Math.min(0.25, pnlFraction - 0.3);
    exitFraction = pnlFraction >= 0.5 ? 1 : 0.5;
    reasoning.push("Decision: TAKE_PROFIT (strong unrealized profit).");
  }
  // EXIT: full exit recommended (e.g. policy EXIT or very high concentration)
  else if (ctx.concentrationPct >= 40 && ctx.hasBehaviorFlag) {
    decisionState = "EXIT";
    confidence = 0.7;
    exitFraction = 1;
    reasoning.push("Decision: EXIT (concentration + behavior flag).");
  }
  else if (ctx.recommendationPolicyState === "EXIT" && pnlFraction <= 0) {
    decisionState = "EXIT";
    confidence = 0.65;
    exitFraction = 1;
    reasoning.push("Decision: EXIT (recommendation policy EXIT).");
  }
  // REDUCE: meaningful loss or deterioration, or weak setup
  else if (priceDeterioration >= 0.15 || (ctx.setupActedWinRate != null && ctx.setupActedWinRate < 0.4) || pnlFraction <= -0.1) {
    decisionState = "REDUCE";
    confidence = 0.6;
    exitFraction = 0.5;
    reasoning.push("Decision: REDUCE (deterioration or weak setup or loss).");
  }
  // TRIM: concentration or saturation
  else if (ctx.concentrationPct >= 25 || ctx.linkedNewsCount >= 5) {
    decisionState = "TRIM";
    confidence = 0.55;
    exitFraction = 0.25;
    reasoning.push("Decision: TRIM (concentration or news saturation).");
  }
  else {
    reasoning.push("Decision: HOLD (no exit signal).");
    exitFraction = 0;
    confidence = 0.5;
  }

  const suggestedExitSize = Math.max(0, Math.min(size, size * exitFraction));
  return {
    decisionState,
    confidence,
    suggestedExitSize: suggestedExitSize.toFixed(4),
    reasoning,
  };
}
