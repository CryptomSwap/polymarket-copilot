/**
 * Paper open attribution persistence + score-band alignment aggregates (unit tests).
 * Run: npx tsx lib/paper-trading/__tests__/paper-score-alignment-and-attribution.test.ts
 */

import assert from "assert";
import { scoreBandFromShadowProba } from "../paper-score-band";
import {
  buildPaperTradeOpenAttribution,
  mergeOpenAttributionIntoMetadata,
  parseOpenAttributionFromMetadataJson,
  resolveScoreBandForPaperTrade,
} from "../paper-trade-open-attribution";
import type { ShadowScoreResult } from "@/lib/ml/shadow-score/types";
import type { ShadowScoreInput } from "@/lib/ml/shadow-score/types";
import {
  aggregatePaperScoreBands,
  computeThresholdGrid,
  scoreMonotonicityFromBands,
  type AlignmentLabeledRow,
  type AlignmentTradeRow,
} from "../paper-score-alignment-report";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function mockShadowResult(overrides: Partial<ShadowScoreResult> = {}): ShadowScoreResult {
  return {
    shadowMlScore: 0.55,
    shadowMlLogit: 0.2,
    shadowMlScoreCalibrated: 0.55,
    shadowMlScoreBand: "medium",
    modelId: "run_test",
    modelFeatureSet: "shadow_v1",
    modelTargetLabel: "labelGoodDecision12h",
    isShadowModel: true,
    featureCompletenessWarnings: [],
    ...overrides,
  };
}

function baseInput(): ShadowScoreInput {
  return {
    spreadBps: "12",
    estimatedSlippage: "0.0005",
    blockedIndicator: false,
    qualityState: "good",
    policyState: "allow",
    executionAllow: true,
    tradable: true,
    momentum1hBps: "1.5",
    timeToCloseHours: "48",
  };
}

function run(): void {
  console.log("\n--- scoreBandFromShadowProba ---");
  check(scoreBandFromShadowProba(0.39) === "low", "low");
  check(scoreBandFromShadowProba(0.4) === "medium", "medium low edge");
  check(scoreBandFromShadowProba(0.59) === "medium", "medium high edge");
  check(scoreBandFromShadowProba(0.6) === "high", "high");

  console.log("\n--- open attribution JSON roundtrip ---");
  const sr = mockShadowResult();
  const si = baseInput();
  const attr = buildPaperTradeOpenAttribution({
    shadowResult: sr,
    thresholdUsed: 0.3,
    minScoreUsed: 0.35,
    shadowCandidateId: "sc_1",
    shadowInput: si,
  });
  check(attr.executionContext.spreadBps === 12, "spread bps");
  check(attr.executionContext.estimatedSlippageBps === 5, "slip bps");
  check(attr.pathFeatureSummary.momentum1hBps === "1.5", "path momentum");
  const merged = mergeOpenAttributionIntoMetadata({ recommendationId: "rec_a" }, attr);
  const json = JSON.stringify(merged);
  const parsed = parseOpenAttributionFromMetadataJson(json);
  check(parsed != null, "parse");
  check(parsed!.modelRunId === "run_test", "model run id");
  check(parsed!.scoreBand === "medium", "band");
  check(parsed!.executionContext.spreadBps === 12, "roundtrip spread");

  console.log("\n--- resolveScoreBandForPaperTrade fallback ---");
  check(
    resolveScoreBandForPaperTrade(0.65, JSON.stringify({ recommendationId: "x" })) === "high",
    "fallback band from score"
  );

  console.log("\n--- aggregatePaperScoreBands ---");
  const openRows: AlignmentTradeRow[] = [
    {
      id: "1",
      status: "open",
      score: 0.65,
      assetId: "a",
      side: "BUY",
      metadataJson: null,
      markout12h: null,
      pnlPct: null,
      threshold: 0.3,
      entryTime: new Date(),
    },
  ];
  const closed: AlignmentLabeledRow[] = [
    {
      id: "2",
      status: "closed",
      score: 0.65,
      assetId: "a2",
      side: "BUY",
      metadataJson: null,
      markout12h: "0.02",
      pnlPct: "0.02",
      threshold: 0.3,
      entryTime: new Date(),
      label12h: true,
    },
    {
      id: "3",
      status: "closed",
      score: 0.35,
      assetId: "a3",
      side: "BUY",
      metadataJson: null,
      markout12h: "-0.01",
      pnlPct: "-0.01",
      threshold: 0.3,
      entryTime: new Date(),
      label12h: false,
    },
  ];
  const bands = aggregatePaperScoreBands({ openRows, closedLabeledRows: closed });
  const high = bands.find((b) => b.scoreBand === "high");
  check(high != null && high.openCount === 1 && high.closedCount === 1, "high band counts");
  check(high != null && high.meanPnlPct === 0.02, "high mean pnl");
  const low = bands.find((b) => b.scoreBand === "low");
  check(low != null && low.closedCount === 1 && low.hitRatePnl === 0, "low hit");

  console.log("\n--- scoreMonotonicityFromBands ---");
  const mono = scoreMonotonicityFromBands(bands);
  check(mono.highBandMeanPnlVsLowBandMeanPnl === 0.03, "high-low diff");

  console.log("\n--- computeThresholdGrid ---");
  const gridRows: AlignmentLabeledRow[] = [
    {
      id: "g1",
      status: "closed",
      score: 0.5,
      assetId: "x",
      side: "BUY",
      metadataJson: null,
      markout12h: "0.1",
      pnlPct: "0.1",
      threshold: 0.3,
      entryTime: new Date(),
      label12h: true,
    },
    {
      id: "g2",
      status: "closed",
      score: 0.2,
      assetId: "y",
      side: "BUY",
      metadataJson: null,
      markout12h: "-0.05",
      pnlPct: "-0.05",
      threshold: 0.3,
      entryTime: new Date(),
      label12h: false,
    },
  ];
  const { slices, bestByMeanPnl } = computeThresholdGrid(gridRows, [0.15, 0.45], 1);
  check(slices.length === 2, "two slices");
  const hi = slices.find((s) => s.hypotheticalMinScore === 0.45);
  check(hi != null && hi.closedTradeCountWithScoreGte === 1 && hi.meanPnlPct === 0.1, "high threshold subset");
  check(bestByMeanPnl.hypotheticalMinScore === 0.45, "best by pnl picks stricter slice");

  console.log("\nAll paper score alignment / attribution tests passed.\n");
}

run();
