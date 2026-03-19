/**
 * Segment support counts for training data (coarse bins).
 * Used to attach support metadata to model artifacts and at scoring time.
 */

import type { SegmentSupportSummary } from "./types";

/** Default minimum count to consider a segment "supported". */
export const DEFAULT_MIN_SUPPORT = 5;

/**
 * Build a map of segment key -> training count from labeled examples.
 * Segment key is built from segmentKeys (e.g. category, priceBand).
 */
export function buildSegmentSupportMap(
  segmentValues: Array<Record<string, string>>,
  minSupport: number = DEFAULT_MIN_SUPPORT
): Map<string, SegmentSupportSummary> {
  const countByKey = new Map<string, { count: number; positive?: number }>();
  for (const seg of segmentValues) {
    const key = Object.entries(seg)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v ?? "unknown"}`)
      .join("|");
    const cur = countByKey.get(key) ?? { count: 0 };
    cur.count++;
    countByKey.set(key, cur);
  }
  const out = new Map<string, SegmentSupportSummary>();
  for (const [segmentKey, { count, positive }] of countByKey) {
    out.set(segmentKey, { segmentKey, trainingCount: count, positiveCount: positive });
  }
  return out;
}

/**
 * Check if a candidate's segment has low support given a precomputed support map.
 */
export function isLowSupportSegment(
  segmentKey: string,
  supportMap: Map<string, SegmentSupportSummary>,
  minSupport: number = DEFAULT_MIN_SUPPORT
): boolean {
  const summary = supportMap.get(segmentKey);
  if (!summary) return true;
  return summary.trainingCount < minSupport;
}
