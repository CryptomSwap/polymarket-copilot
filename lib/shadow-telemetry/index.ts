/**
 * Shadow-mode telemetry: record every trade candidate (blocked or allowed) for post-trade evaluation.
 */

export * from "./types";
export {
  recordShadowCandidate,
  isRuntimeAutomatedShadowWriteDisabled,
  resetRuntimeAutomatedShadowWriteWindowCounters,
  getRuntimeAutomatedShadowWriteWindowSnapshot,
  logRuntimeAutomatedShadowWriteWindowAfterPaperTick,
  warnIfRuntimeAutomatedShadowWritesDisabledAtWorkerBoot,
  type RecordShadowCandidateResult,
} from "./record";
