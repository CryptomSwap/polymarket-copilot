/**
 * Compare heuristic (priorityScore) ranking vs ML probability ranking.
 * Top-N hit rate, average forward return of top-ranked, win rate by bucket. No autonomous trading.
 */

export interface RankingComparisonInput {
  recommendationIds: string[];
  heuristicScores: number[];
  mlProbas: number[];
  labels: number[];
  forwardReturns?: number[];
}

export interface TopNResult {
  n: number;
  heuristicHitRate: number;
  mlHitRate: number;
  heuristicAvgReturn: number | null;
  mlAvgReturn: number | null;
}

export interface HeuristicVsMlComparison {
  topN: TopNResult[];
  winRateByHeuristicBucket: { bucket: string; count: number; winRate: number }[];
  winRateByMlBucket: { bucket: string; count: number; winRate: number }[];
}

/**
 * Compare heuristic vs ML ranking. Assumes arrays are aligned by index.
 */
export function compareHeuristicVsMl(
  input: RankingComparisonInput,
  topNs: number[] = [5, 10, 20],
  numBuckets: number = 5
): HeuristicVsMlComparison {
  const { recommendationIds, heuristicScores, mlProbas, labels, forwardReturns } = input;
  const len = recommendationIds.length;
  if (len === 0) {
    return {
      topN: topNs.map((n) => ({
        n,
        heuristicHitRate: 0,
        mlHitRate: 0,
        heuristicAvgReturn: null,
        mlAvgReturn: null,
      })),
      winRateByHeuristicBucket: [],
      winRateByMlBucket: [],
    };
  }

  const indices = Array.from({ length: len }, (_, i) => i);
  const byHeuristic = [...indices].sort((a, b) => (heuristicScores[b] ?? 0) - (heuristicScores[a] ?? 0));
  const byMl = [...indices].sort((a, b) => (mlProbas[b] ?? 0) - (mlProbas[a] ?? 0));

  const topN: TopNResult[] = topNs.map((n) => {
    const hTop = byHeuristic.slice(0, n);
    const mTop = byMl.slice(0, n);
    const hHits = hTop.filter((i) => labels[i] === 1).length;
    const mHits = mTop.filter((i) => labels[i] === 1).length;
    const hHitRate = n > 0 ? hHits / n : 0;
    const mHitRate = n > 0 ? mHits / n : 0;
    const hAvgReturn =
      forwardReturns && hTop.length > 0
        ? hTop.reduce((s, i) => s + (forwardReturns[i] ?? 0), 0) / hTop.length
        : null;
    const mAvgReturn =
      forwardReturns && mTop.length > 0
        ? mTop.reduce((s, i) => s + (forwardReturns[i] ?? 0), 0) / mTop.length
        : null;
    return {
      n,
      heuristicHitRate: hHitRate,
      mlHitRate: mHitRate,
      heuristicAvgReturn: hAvgReturn,
      mlAvgReturn: mAvgReturn,
    };
  });

  const bucketSize = Math.max(1, Math.floor(len / numBuckets));
  const winRateByHeuristicBucket: { bucket: string; count: number; winRate: number }[] = [];
  const winRateByMlBucket: { bucket: string; count: number; winRate: number }[] = [];

  for (let b = 0; b < numBuckets; b++) {
    const start = b * bucketSize;
    const end = b === numBuckets - 1 ? len : start + bucketSize;
    const hBucket = byHeuristic.slice(start, end);
    const mBucket = byMl.slice(start, end);
    const hWins = hBucket.filter((i) => labels[i] === 1).length;
    const mWins = mBucket.filter((i) => labels[i] === 1).length;
    winRateByHeuristicBucket.push({
      bucket: `Q${b + 1}`,
      count: hBucket.length,
      winRate: hBucket.length > 0 ? hWins / hBucket.length : 0,
    });
    winRateByMlBucket.push({
      bucket: `Q${b + 1}`,
      count: mBucket.length,
      winRate: mBucket.length > 0 ? mWins / mBucket.length : 0,
    });
  }

  return {
    topN,
    winRateByHeuristicBucket,
    winRateByMlBucket,
  };
}
