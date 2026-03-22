/**
 * Paper-only logit temperature (unit tests).
 * Run: npx tsx lib/paper-trading/__tests__/paper-shadow-logit-calibration.test.ts
 */

import assert from "assert";
import {
  applyPaperShadowLogitTemperature,
  probaToLogit,
} from "../paper-shadow-logit-calibration";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

const high = 0.9999999979;

check(applyPaperShadowLogitTemperature(0.7, 1) === 0.7, "T=1 is identity (exact === branch)");
check(approx(applyPaperShadowLogitTemperature(high, 4), 1 / (1 + Math.exp(-Math.min(20, probaToLogit(high)! / 4)))), "T=4 matches sigmoid(logit/T) clipped");

const cal = applyPaperShadowLogitTemperature(high, 5);
check(cal < high && cal > 0.5, "T>1 pulls saturated prob down toward midrange");

const spread =
  applyPaperShadowLogitTemperature(0.99, 3) - applyPaperShadowLogitTemperature(0.999, 3);
const spreadRaw = 0.999 - 0.99;
check(Math.abs(spread) > Math.abs(spreadRaw) * 0.5, "temperature increases separation vs tiny raw gap (heuristic)");

const z = probaToLogit(0.75);
check(z != null && z > 0, "probaToLogit interior");
check(probaToLogit(NaN) == null, "non-finite proba");

console.log("paper-shadow-logit-calibration.test.ts OK");
