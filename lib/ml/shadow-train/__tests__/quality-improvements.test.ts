import { trainLogisticRegression, predictProbaLogistic } from "../../baseline";
import { balancedClassWeights, computeActiveFeatureIndices } from "../train";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function approxEq(a: number, b: number, eps: number = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

function run(): void {
  console.log("\n--- 1. Constant/near-constant feature filtering ---");
  {
    const xTrain = [
      [1, 10, 3, 0],
      [1, 11, 3, 1],
      [1, 12, 3, 0],
      [1, 13, 3, 1],
    ];
    const idxs = computeActiveFeatureIndices(xTrain, 1e-12);
    check(idxs.length === 2, "only varying features retained");
    check(idxs[0] === 1 && idxs[1] === 3, "retained expected feature indices");
  }

  console.log("\n--- 2. Balanced class weighting reduces prior bias ---");
  {
    const x = Array.from({ length: 10 }, () => [0]);
    const y = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
    const unweighted = trainLogisticRegression(x, y, { learningRate: 0.1, maxIter: 300, l2Lambda: 0 });
    const weighted = trainLogisticRegression(x, y, {
      learningRate: 0.1,
      maxIter: 300,
      l2Lambda: 0,
      sampleWeights: balancedClassWeights(y),
    });
    const pUnweighted = predictProbaLogistic(unweighted, [0]);
    const pWeighted = predictProbaLogistic(weighted, [0]);
    check(pUnweighted > 0.7, "unweighted model reflects strong positive prior");
    check(Math.abs(pWeighted - 0.5) < 0.1, "balanced weighting centers prior toward 0.5");
    check(pWeighted < pUnweighted, "balanced weighting lowers overconfident majority-class probability");
  }

  console.log("\n--- 3. Feature mask keeps scoring compatibility ---");
  {
    const maskedModel = {
      coefficients: [0.7, -0.2],
      intercept: 0.1,
      means: [5, 9],
      stds: [2, 4],
      activeFeatureIdxs: [1, 3],
    };
    const reducedModel = {
      coefficients: [0.7, -0.2],
      intercept: 0.1,
      means: [5, 9],
      stds: [2, 4],
    };
    const fullRow = [100, 7, 200, 13];
    const reducedRow = [7, 13];
    const pMasked = predictProbaLogistic(maskedModel, fullRow);
    const pReduced = predictProbaLogistic(reducedModel, reducedRow);
    check(approxEq(pMasked, pReduced, 1e-12), "masked model projects full feature row correctly");
  }

  console.log("\n--- All quality improvement tests passed ---");
}

run();

