/**
 * Calibration: compare predicted probability buckets to actual positive rate.
 * No autonomous trading; for model diagnostics only.
 */

export interface CalibrationBucket {
  bucketIndex: number;
  minProb: number;
  maxProb: number;
  count: number;
  positiveCount: number;
  actualRate: number;
  meanPredictedProb: number;
}

/**
 * Split predictions into buckets by predicted probability and compute actual positive rate per bucket.
 */
export function calibrationSummary(
  probas: number[],
  y: number[],
  numBuckets: number = 10
): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  for (let b = 0; b < numBuckets; b++) {
    const minP = b / numBuckets;
    const maxP = (b + 1) / numBuckets;
    const indices: number[] = [];
    for (let i = 0; i < probas.length; i++) {
      const p = probas[i] ?? 0;
      if (p >= minP && (b === numBuckets - 1 ? p <= maxP : p < maxP)) indices.push(i);
    }
    const count = indices.length;
    const positiveCount = indices.filter((i) => y[i] === 1).length;
    const actualRate = count > 0 ? positiveCount / count : 0;
    const meanPredictedProb =
      count > 0 ? indices.reduce((s, i) => s + (probas[i] ?? 0), 0) / count : 0;
    buckets.push({
      bucketIndex: b,
      minProb: minP,
      maxProb: maxP,
      count,
      positiveCount,
      actualRate,
      meanPredictedProb,
    });
  }
  return buckets;
}

export interface CalibrationSummaryReport {
  buckets: CalibrationBucket[];
  mae: number; // mean absolute error between meanPredictedProb and actualRate (over non-empty buckets)
}

/**
 * Calibration report with MAE (mean absolute error) between predicted and actual rates.
 */
export function calibrationReport(
  probas: number[],
  y: number[],
  numBuckets: number = 10
): CalibrationSummaryReport {
  const buckets = calibrationSummary(probas, y, numBuckets);
  const nonEmpty = buckets.filter((b) => b.count > 0);
  const mae =
    nonEmpty.length > 0
      ? nonEmpty.reduce((s, b) => s + Math.abs(b.meanPredictedProb - b.actualRate), 0) / nonEmpty.length
      : 0;
  return { buckets, mae };
}
