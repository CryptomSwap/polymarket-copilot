/**
 * Lightweight Platt scaling on model probabilities:
 * calibrated = sigmoid(a * logit(score) + b)
 */

import { probaToLogit } from "@/lib/paper-trading/paper-shadow-logit-calibration";

const EPS = 1e-9;

export interface PlattCalibrator {
  a: number;
  b: number;
}

function clampProb(p: number): number {
  return Math.min(1 - EPS, Math.max(EPS, p));
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

/**
 * Train Platt parameters via simple gradient descent on log-loss.
 * scores must be in [0,1], labels in {0,1}.
 */
export function trainPlattCalibrator(
  scores: number[],
  labels: number[],
  opts?: { learningRate?: number; maxIter?: number; l2?: number }
): PlattCalibrator {
  if (scores.length !== labels.length || scores.length === 0) {
    return { a: 1, b: 0 };
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]!;
    const y = labels[i]!;
    if (!Number.isFinite(s)) continue;
    if (!(y === 0 || y === 1)) continue;
    const lg = probaToLogit(clampProb(s));
    if (lg == null || !Number.isFinite(lg)) continue;
    xs.push(lg);
    ys.push(y);
  }
  if (xs.length < 10) {
    return { a: 1, b: 0 };
  }

  const lr = opts?.learningRate ?? 0.05;
  const maxIter = opts?.maxIter ?? 1200;
  const l2 = opts?.l2 ?? 1e-4;

  let a = 1;
  let b = 0;
  let prevLoss = Number.POSITIVE_INFINITY;

  for (let iter = 0; iter < maxIter; iter++) {
    let ga = 0;
    let gb = 0;
    let loss = 0;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!;
      const y = ys[i]!;
      const z = a * x + b;
      const p = clampProb(sigmoid(z));
      const err = p - y;
      ga += err * x;
      gb += err;
      loss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    }
    ga = ga / xs.length + l2 * a;
    gb = gb / xs.length;
    loss = loss / xs.length + 0.5 * l2 * a * a;

    a -= lr * ga;
    b -= lr * gb;

    if (!Number.isFinite(a) || !Number.isFinite(b)) return { a: 1, b: 0 };
    if (Math.abs(prevLoss - loss) < 1e-9) break;
    prevLoss = loss;
  }
  return { a, b };
}

export function applyPlattCalibrator(score: number, params: PlattCalibrator): number {
  if (!Number.isFinite(score)) return score;
  if (!Number.isFinite(params.a) || !Number.isFinite(params.b)) return score;
  const lg = probaToLogit(clampProb(score));
  if (lg == null) return score;
  return clampProb(sigmoid(params.a * lg + params.b));
}

