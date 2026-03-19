/**
 * Model evaluation: accuracy, precision, recall, F1, ROC-AUC.
 * No autonomous trading; metrics for baseline comparison only.
 */

/**
 * Binary classification metrics from predicted probabilities and true labels.
 */
export interface ClassificationMetrics {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  rocAuc: number;
  threshold: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

/**
 * Compute precision (when pred=1). If no positive predictions, returns 0.
 */
function precision(tp: number, fp: number): number {
  const den = tp + fp;
  return den > 0 ? tp / den : 0;
}

/**
 * Compute recall (sensitivity). If no actual positives, returns 0.
 */
function recall(tp: number, fn: number): number {
  const den = tp + fn;
  return den > 0 ? tp / den : 0;
}

/**
 * F1 score from precision and recall.
 */
function f1(p: number, r: number): number {
  if (p + r === 0) return 0;
  return (2 * p * r) / (p + r);
}

/**
 * ROC-AUC: P(random positive has higher score than random negative).
 * Positive class is y=1. Sorts by probas ascending; for each negative, counts positives ranked above it.
 */
function rocAuc(probas: number[], y: number[]): number {
  const n = probas.length;
  if (n === 0) return 0.5;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (probas[a] ?? 0) - (probas[b] ?? 0));
  let auc = 0;
  let posBelow = 0;
  const totalPos = y.filter((v) => v === 1).length;
  const totalNeg = n - totalPos;
  if (totalPos === 0 || totalNeg === 0) return 0.5;
  for (let i = 0; i < n; i++) {
    const idx = order[i];
    if (y[idx] === 1) posBelow++;
    else auc += (totalPos - posBelow) / totalPos / totalNeg;
  }
  return auc;
}

/**
 * Compute metrics at a given threshold (default 0.5).
 */
export function computeMetrics(
  probas: number[],
  y: number[],
  threshold: number = 0.5
): ClassificationMetrics {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < probas.length; i++) {
    const pred = (probas[i] ?? 0) >= threshold ? 1 : 0;
    const actual = y[i] ?? 0;
    if (pred === 1 && actual === 1) tp++;
    else if (pred === 1 && actual === 0) fp++;
    else if (pred === 0 && actual === 0) tn++;
    else fn++;
  }
  const n = probas.length;
  const acc = n > 0 ? (tp + tn) / n : 0;
  const p = precision(tp, fp);
  const r = recall(tp, fn);
  return {
    accuracy: acc,
    precision: p,
    recall: r,
    f1: f1(p, r),
    rocAuc: rocAuc(probas, y),
    threshold,
    tp,
    fp,
    tn,
    fn,
  };
}
