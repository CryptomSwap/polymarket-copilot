/**
 * Shadow-mode telemetry: input for recording a trade candidate (blocked or allowed).
 */

export interface RecordShadowCandidateInput {
  funderAddress: string;
  recommendationId?: string | null;
  orderIntentId?: string | null;
  assetId: string;
  marketId?: string | null;
  side: string;
  intendedPrice: number;
  intendedSize: number;
  candidateSource?: string;
  decisionSnapshotJson?: string | null;
  executionPolicySnapshotJson?: string | null;
  executionQualitySnapshotJson?: string | null;
  portfolioRiskSnapshotJson?: string | null;
  runtimeSafetySnapshotJson?: string | null;
  wasBlocked: boolean;
  blockingReasons?: string[];
  wasSubmitted?: boolean;
  wasFilled?: boolean | null;
}
