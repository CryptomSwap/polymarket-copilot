export interface NullFieldReason {
  field: string;
  reason: string;
}

export interface BotScorecard {
  botId: string;
  status: "active" | "inactive" | "degraded";
  sampleSize: number;
  avgMarkout: number | null;
  hitRate: number | null;
  byBand: Record<string, { sampleSize: number; avgMarkout: number | null; hitRate: number | null }>;
  bySpreadQuartile: Record<string, { sampleSize: number; avgMarkout: number | null; hitRate: number | null }> | null;
  rankLift: number | null;
  inactivityFlag: boolean;
  redundancyFlag: boolean;
  primaryFailureMode: string | null;
  recommendedAction: string | null;
  nullFieldReasons: NullFieldReason[];
}

export interface MlScorecard {
  modelVersion: string | null;
  scope: string | null;
  botId: string | null;
  influenceRate: number | null;
  scoreCorrelation: number | null;
  bucketLift: { topQuartileHitRate: number | null; bottomQuartileHitRate: number | null; delta: number | null } | null;
  featureHealth: Record<string, unknown> | null;
  labelHealth: Record<string, unknown> | null;
  driftStatus: Record<string, unknown> | null;
  challengerVsChampion: Record<string, unknown> | null;
  isHelping: boolean | null;
  primaryFailureMode: string | null;
  recommendedAction: string | null;
  nullFieldReasons: NullFieldReason[];
}

export interface RepairPacket {
  issueId: string;
  severity: "low" | "medium" | "high" | "critical";
  affectedBotOrModel: string | null;
  diagnosisSummary: string;
  failingMetrics: Array<{ name: string; observed: number | string | boolean | null; expected: string }>;
  evidenceRefs: string[];
  suspectedModules: string[];
  allowedModifications: string[];
  forbiddenModifications: string[];
  validationCommands: string[];
  successCriteria: string[];
  deploymentScope: "paper_only";
  rollbackReference: string | null;
}

export interface ValidationCheckResult {
  name: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export type IssueType = "bot_productivity" | "ml_effectiveness" | "operational_guardrail";
export type IssueSeverity = "low" | "medium" | "high" | "critical";
export type IssueConfidence = "low" | "medium" | "high";
export type IssueStatus = "open";
export type IssueRecommendedAction = "observe" | "auto_remediate" | "open_experiment" | "cursor_repair" | "escalate";

export interface ControlPlaneIssue {
  id: string;
  type: IssueType;
  severity: IssueSeverity;
  confidence: IssueConfidence;
  status: IssueStatus;
  botId: string | null;
  modelVersion: string | null;
  diagnosis: string;
  reason: string;
  evidence: Record<string, unknown>;
  recommendedAction: IssueRecommendedAction;
  scope: "paper_only";
  nullFieldReasons: NullFieldReason[];
}

export interface IssueActionDecision {
  issueId: string;
  action: IssueRecommendedAction;
  policyReason: string;
  scope: "paper_only";
  requiresApproval: boolean;
}
