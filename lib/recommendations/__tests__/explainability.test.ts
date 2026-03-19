/**
 * Tests for recommendation explainability shaping.
 * buildRecommendationExplanation() produces normalized summary, drivers, penalties, sizing, quality, review from stored fields only.
 * Run: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/recommendations/__tests__/explainability.test.ts
 */

import { buildRecommendationExplanation } from "../explainability";

export function runExplainabilityTests(): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  function check(cond: boolean, msg: string): void {
    if (cond) {
      passed++;
      console.log("  OK:", msg);
    } else {
      failed++;
      console.error("  FAIL:", msg);
    }
  }

  console.log("\n--- buildRecommendationExplanation: minimal input ---");
  const minimal = buildRecommendationExplanation({
    recommendation: {
      id: "rec-1",
      action: "WATCH",
      primaryActionType: "monitor",
      suggestedEntryMin: null,
      suggestedEntryMax: null,
      suggestedSize: "0",
      blockedReason: null,
      priorityScore: "0.5",
      rationale: null,
      portfolioImpact: null,
      riskNote: null,
      timingNote: null,
      qualityBlocker: null,
      createdAt: "2025-01-15T10:00:00.000Z",
      updatedAt: "2025-01-15T10:00:00.000Z",
    },
    signal: {
      marketPrice: null,
      fairPrice: null,
      edge: null,
      confidence: null,
    },
  });
  check(minimal.recommendationId === "rec-1", "recommendationId set");
  check(minimal.action === "WATCH", "action set");
  check(minimal.primaryActionType === "monitor", "primaryActionType set");
  check(minimal.marketRef === null, "marketRef null when omitted");
  check(minimal.evaluationRefs.length === 0, "evaluationRefs empty when omitted");
  check(minimal.reviewRef === null, "reviewRef null when omitted");
  check(Object.keys(minimal.drivers).length === 0, "no drivers when signal values missing");
  check(Object.keys(minimal.penalties).length === 0, "no penalties when signal penalties missing");
  check(minimal.summary !== null && minimal.summary.length > 0, "summary derived from primaryActionType when no rationale");

  console.log("\n--- buildRecommendationExplanation: full signal inputs ---");
  const fullSignal = buildRecommendationExplanation({
    recommendation: {
      id: "rec-2",
      action: "STRONG_BUY",
      primaryActionType: "add",
      suggestedEntryMin: "0.45",
      suggestedEntryMax: "0.55",
      suggestedSize: "0.8",
      blockedReason: null,
      priorityScore: "0.72",
      rationale: "Edge 12%, confidence 65%. Diversifies from top concentration.",
      portfolioImpact: "Adds new theme exposure.",
      riskNote: null,
      timingNote: null,
      qualityBlocker: null,
      createdAt: "2025-01-15T10:00:00.000Z",
      updatedAt: "2025-01-15T10:00:00.000Z",
    },
    signal: {
      marketPrice: "0.48",
      fairPrice: "0.55",
      edge: "0.12",
      confidence: "0.65",
      momentumScore: "0.6",
      liquidityScore: "0.7",
      crowdingScore: "0.5",
      portfolioPenalty: "0.1",
      behaviorPenalty: "0",
      category: "Politics",
      theme: "Elections",
      thesis: "Outcome undervalued given recent data.",
    },
    marketRef: { marketId: "0xmarket", marketTitle: "Will X happen?", outcome: "Yes" },
    assetId: "0xasset",
    evaluationRefs: [],
    reviewRef: { status: "NEW", reviewerNote: null, createdAt: null, updatedAt: null },
  });
  check(fullSignal.summary === "Edge 12%, confidence 65%. Diversifies from top concentration.", "summary uses rationale when present");
  check(fullSignal.drivers.edge !== undefined && fullSignal.drivers.edge.includes("12.0%"), "drivers.edge from signal");
  check(fullSignal.drivers.confidence !== undefined, "drivers.confidence set");
  check(fullSignal.drivers.momentumScore !== undefined, "drivers.momentumScore set");
  check(fullSignal.drivers.liquidityScore !== undefined, "drivers.liquidityScore set");
  check(fullSignal.drivers.crowdingScore !== undefined, "drivers.crowdingScore set");
  check(fullSignal.penalties.portfolioPenalty !== undefined && fullSignal.penalties.portfolioPenalty.includes("10"), "penalties.portfolioPenalty set");
  check(fullSignal.sizing.suggestedSize === "0.8", "sizing.suggestedSize set");
  check(fullSignal.sizing.suggestedEntryMin === "0.45", "sizing.suggestedEntryMin set");
  check(fullSignal.marketRef?.marketId === "0xmarket", "marketRef passed through");
  check(fullSignal.assetId === "0xasset", "assetId passed through");
  check(fullSignal.review.status === "NEW", "review section has status");
  check(fullSignal.signalInputs.marketPrice === "0.48", "signalInputs.marketPrice set");
  check(fullSignal.signalInputs.edge === "0.12", "signalInputs.edge set");
  check(fullSignal.theme === "Elections", "theme set");
  check(fullSignal.category === "Politics", "category set");
  check(fullSignal.thesis === "Outcome undervalued given recent data.", "thesis set");

  console.log("\n--- buildRecommendationExplanation: quality / blocker ---");
  const withBlocker = buildRecommendationExplanation({
    recommendation: {
      id: "rec-3",
      action: "NO_TRADE",
      primaryActionType: "sync_first",
      suggestedEntryMin: null,
      suggestedEntryMax: null,
      suggestedSize: "0",
      blockedReason: "Sync portfolio to resolve positions before adding.",
      priorityScore: "0.1",
      rationale: null,
      portfolioImpact: null,
      riskNote: null,
      timingNote: null,
      qualityBlocker: "Sync portfolio to resolve positions before adding new exposure.",
      createdAt: "2025-01-15T10:00:00.000Z",
      updatedAt: "2025-01-15T10:00:00.000Z",
    },
    signal: { marketPrice: null, fairPrice: null, edge: null, confidence: null },
  });
  check(withBlocker.quality.qualityBlocker !== undefined, "quality.qualityBlocker set");
  check(withBlocker.quality.blockedReason !== undefined, "quality.blockedReason set");
  check(withBlocker.blocker !== null, "blocker field set from qualityBlocker or blockedReason");

  console.log("\n--- buildRecommendationExplanation: evaluation refs ---");
  const withEvals = buildRecommendationExplanation({
    recommendation: {
      id: "rec-4",
      action: "BUY_SMALL",
      primaryActionType: "add",
      suggestedEntryMin: null,
      suggestedEntryMax: null,
      suggestedSize: "0.4",
      blockedReason: null,
      priorityScore: "0.5",
      rationale: "Good edge.",
      portfolioImpact: null,
      riskNote: null,
      timingNote: null,
      qualityBlocker: null,
      createdAt: "2025-01-15T10:00:00.000Z",
      updatedAt: "2025-01-15T10:00:00.000Z",
    },
    signal: { marketPrice: "0.5", fairPrice: "0.55", edge: "0.1", confidence: "0.5" },
    evaluationRefs: [
      {
        id: "eval-1",
        evaluatedAt: "2025-01-15T11:00:00.000Z",
        marketPriceAtEval: "0.52",
        priceChange1h: "0.02",
        priceChange6h: null,
        priceChange24h: null,
        wasPositive: true,
      },
    ],
  });
  check(withEvals.evaluationRefs.length === 1, "evaluationRefs length 1");
  check(withEvals.evaluationRefs[0].id === "eval-1", "evaluationRef id preserved");
  check(withEvals.evaluationRefs[0].marketPriceAtEval === "0.52", "evaluationRef marketPriceAtEval preserved");

  console.log("\n--- Explainability tests result ---");
  console.log(`  Passed: ${passed}, Failed: ${failed}`);
  return { passed, failed };
}

if (require.main === module) {
  const { passed, failed } = runExplainabilityTests();
  process.exit(failed > 0 ? 1 : 0);
}
