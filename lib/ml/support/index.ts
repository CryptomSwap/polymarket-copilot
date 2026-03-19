/**
 * ML support and uncertainty helpers.
 * Segment support, scoring-time support metrics, low-support flags.
 */

export type { SegmentSupportSummary, ScoringSupportInput, SupportSegmentKey } from "./types";
export { buildSegmentSupportMap, isLowSupportSegment, DEFAULT_MIN_SUPPORT } from "./segment-support";
export { computeScoringSupportMetrics } from "./scoring-support";
export type {
  ShadowSupportDiagnostic,
  ShadowSupportDiagnosticsReport,
  SupportBucket,
  SupportProvenance,
  SupportReasonCode,
} from "./shadow-support-diagnostics";
export {
  buildSupportDiagnosticForCandidate,
  getShadowSupportDiagnosticsReport,
} from "./shadow-support-diagnostics";
