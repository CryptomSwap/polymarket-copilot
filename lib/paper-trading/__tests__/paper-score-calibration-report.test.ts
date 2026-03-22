/**
 * Paper score calibration report helpers (unit tests).
 * Run: npx tsx lib/paper-trading/__tests__/paper-score-calibration-report.test.ts
 */

import assert from "assert";
import {
  summarizeScores,
  suggestMinScoreFromCalibratedDistribution,
} from "../paper-score-calibration-report";
import {
  buildPaperTradeOpenAttribution,
  mergeOpenAttributionIntoMetadata,
  parseOpenAttributionFromMetadataJson,
} from "../paper-trade-open-attribution";
import type { ShadowScoreInput, ShadowScoreResult } from "@/lib/ml/shadow-score/types";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

const s = summarizeScores([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]);
check(s.n === 10 && s.countGte095 === 1 && s.countGte09 === 2, "summarizeScores counts");
check(s.p50 != null && s.p50 >= 0.54 && s.p50 <= 0.56, "p50 linear quantile ~0.55 for 0.1..0.95");

const sug = suggestMinScoreFromCalibratedDistribution(
  [0.5, 0.51, 0.52, 0.53, 0.54, 0.55, 0.56, 0.57, 0.58, 0.59],
  0.35
);
check(sug != null && sug >= 0.5 && sug <= 0.59, "suggestMinScore returns order stat");

check(suggestMinScoreFromCalibratedDistribution([0.1, 0.2], 0.35) == null, "short array returns null");

const shadow: ShadowScoreResult = {
  shadowMlScore: 0.991,
  shadowMlLogit: 12.5,
  shadowMlScoreCalibrated: 0.82,
  shadowMlScoreBand: "high",
  modelId: "m1",
  modelFeatureSet: "fs",
  modelTargetLabel: "lbl",
  isShadowModel: true,
  featureCompletenessWarnings: [],
};

const shadowInput: ShadowScoreInput = {
  spreadBps: "80",
  estimatedSlippage: "0.001",
  blockedIndicator: false,
  qualityState: "good",
  policyState: "allow",
  executionAllow: true,
  tradable: true,
};

const attr = buildPaperTradeOpenAttribution({
  shadowResult: shadow,
  thresholdUsed: 0.3,
  minScoreUsed: 0.95,
  shadowInput,
  paperRoiAdmission: null,
  paperShadowScoreCalibration: {
    shadowMlScoreRaw: shadow.shadowMlScore,
    shadowMlLogit: shadow.shadowMlLogit,
    shadowMlScoreCalibrated: shadow.shadowMlScoreCalibrated,
    logitTemperature: 4,
    usedCalibratedForAdmission: true,
    admissionScore: shadow.shadowMlScoreCalibrated,
  },
});

check(attr.paperShadowScoreCalibration?.shadowMlScoreRaw === 0.991, "raw preserved in attribution");
check(attr.paperShadowScoreCalibration?.shadowMlScoreCalibrated === 0.82, "calibrated stored");

const meta = JSON.stringify(mergeOpenAttributionIntoMetadata({}, attr));
const round = parseOpenAttributionFromMetadataJson(meta);
check(
  round?.paperShadowScoreCalibration?.shadowMlScoreRaw === 0.991 &&
    round.paperShadowScoreCalibration.shadowMlLogit === 12.5,
  "parse roundtrip preserves raw + logit"
);

import * as fs from "fs";
import * as path from "path";

const omPath = path.join(process.cwd(), "lib/runtime/order-manager/paper-order-manager.ts");
const om = fs.readFileSync(omPath, "utf8");
check(!om.includes("shadowMlScoreCalibrated"), "live paper order manager does not reference calibrated score");

console.log("paper-score-calibration-report.test.ts OK");
