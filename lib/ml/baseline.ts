/**
 * Baseline ML models: logistic regression (and optional tree stub).
 * Training and inference only; no autonomous trading. TODO: Future blended ranking if model quality is good.
 */

function sigmoid(z: number): number {
  const capped = Math.max(-20, Math.min(20, z));
  return 1 / (1 + Math.exp(-capped));
}

/**
 * Normalize features to zero mean, unit variance per column (in-place). Returns means and stds for inference.
 */
export function normalizeFeatures(X: number[][]): { means: number[]; stds: number[] } {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const means: number[] = [];
  const stds: number[] = [];
  for (let j = 0; j < d; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += X[i][j] ?? 0;
    const mean = n > 0 ? sum / n : 0;
    means.push(mean);
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const v = (X[i][j] ?? 0) - mean;
      sq += v * v;
    }
    const std = n > 1 && sq > 0 ? Math.sqrt(sq / (n - 1)) : 1;
    stds.push(std);
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) {
      const std = stds[j];
      X[i][j] = std > 1e-8 ? ((X[i][j] ?? 0) - means[j]) / std : (X[i][j] ?? 0) - means[j];
    }
  }
  return { means, stds };
}

export interface LogisticRegressionParams {
  learningRate?: number;
  maxIter?: number;
  l2Lambda?: number;
  tol?: number;
  sampleWeights?: number[];
  featureIndices?: number[];
}

export interface LogisticRegressionModel {
  coefficients: number[];
  intercept: number;
  means: number[];
  stds: number[];
  featureNames?: string[];
  activeFeatureIdxs?: number[];
}

/**
 * Train logistic regression with gradient descent. Binary classification.
 */
export function trainLogisticRegression(
  X: number[][],
  y: number[],
  params: LogisticRegressionParams = {}
): LogisticRegressionModel {
  const learningRate = params.learningRate ?? 0.1;
  const maxIter = params.maxIter ?? 500;
  const l2Lambda = params.l2Lambda ?? 0.01;
  const tol = params.tol ?? 1e-6;
  const n = X.length;
  const sampleWeights = params.sampleWeights;
  const weightSum = sampleWeights && sampleWeights.length === y.length
    ? sampleWeights.reduce((a, b) => a + (Number.isFinite(b) ? Math.max(0, b) : 0), 0)
    : n;
  const norm = weightSum > 0 ? weightSum : Math.max(1, n);
  const numFeatures = X[0]?.length ?? 0;
  const d = numFeatures + 1;
  const XCopy = X.map((row) => [1, ...row]);
  const featureCols = XCopy.map((r) => r.slice(1));
  const { means, stds } = normalizeFeatures(featureCols);
  for (let i = 0; i < XCopy.length; i++) {
    for (let j = 1; j < d; j++) {
      XCopy[i][j] = featureCols[i][j - 1] ?? 0;
    }
  }

  const w = new Array<number>(d).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let gradNorm = 0;
    for (let j = 0; j < d; j++) {
      let g = 0;
      for (let i = 0; i < n; i++) {
        const pred = sigmoid(w.reduce((s, wj, k) => s + wj * (XCopy[i][k] ?? 0), 0));
        const wi = sampleWeights && sampleWeights.length === y.length
          ? (Number.isFinite(sampleWeights[i]) ? Math.max(0, sampleWeights[i] as number) : 0)
          : 1;
        g += wi * (pred - y[i]) * (XCopy[i][j] ?? 0);
      }
      g /= norm;
      if (j > 0) g += l2Lambda * w[j];
      gradNorm += g * g;
      w[j] -= learningRate * g;
    }
    if (Math.sqrt(gradNorm) < tol) break;
  }

  return {
    coefficients: w.slice(1),
    intercept: w[0],
    means,
    stds,
    activeFeatureIdxs: params.featureIndices,
  };
}

/**
 * Linear score z before sigmoid: sigmoid(z) === predictProbaLogistic(model, row) (up to float error).
 * Useful for diagnosing saturation (very large |z| ⇒ probability near 0 or 1).
 */
export function logisticLinearTerm(
  model: LogisticRegressionModel,
  row: number[],
  options?: { alreadyNormalized?: boolean }
): number {
  const projected = Array.isArray(model.activeFeatureIdxs)
    ? model.activeFeatureIdxs.map((idx) => row[idx] ?? 0)
    : row;
  const normalized = options?.alreadyNormalized
    ? projected
    : projected.map((v, j) => {
        const std = model.stds[j];
        return std > 1e-8 ? (v - model.means[j]) / std : v - model.means[j];
      });
  return model.intercept + normalized.reduce((s, v, j) => s + (model.coefficients[j] ?? 0) * v, 0);
}

/**
 * Predict probability for one row (already normalized with model's means/stds) or raw row.
 */
export function predictProbaLogistic(
  model: LogisticRegressionModel,
  row: number[],
  options?: { alreadyNormalized?: boolean }
): number {
  const z = logisticLinearTerm(model, row, options);
  return sigmoid(z);
}

/**
 * Predict for many rows. Returns array of probabilities.
 */
export function predictBatchLogistic(model: LogisticRegressionModel, X: number[][]): number[] {
  return X.map((row) => predictProbaLogistic(model, row));
}

/**
 * Feature importance from logistic regression coefficients (absolute value).
 */
export function getLogisticFeatureImportance(
  model: LogisticRegressionModel,
  featureNames: string[]
): Array<{ name: string; coefficient: number; absCoefficient: number }> {
  return model.coefficients.map((coef, i) => ({
    name: featureNames[i] ?? `f${i}`,
    coefficient: coef,
    absCoefficient: Math.abs(coef),
  })).sort((a, b) => b.absCoefficient - a.absCoefficient);
}
