import type { ControlPlaneIssue, RepairPacket } from "./contracts";

export interface RepairPacketInput {
  severity?: "low" | "medium" | "high" | "critical";
  affectedBotOrModel?: string | null;
  diagnosisSummary?: string | null;
  failingMetrics?: Array<{ name: string; observed: number | string | boolean | null; expected: string }>;
  evidenceRefs?: string[];
  suspectedModules?: string[];
}

export function buildRepairPacket(issueId: string, input: RepairPacketInput): RepairPacket {
  const severity = input.severity ?? "medium";
  const diagnosisSummary =
    input.diagnosisSummary?.trim() ||
    "Issue requires bounded repair in paper-only control plane. Missing fields must be resolved with evidence-first diagnostics before code changes.";

  return {
    issueId,
    severity,
    affectedBotOrModel: input.affectedBotOrModel ?? null,
    diagnosisSummary,
    failingMetrics: input.failingMetrics ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
    suspectedModules: input.suspectedModules ?? [],
    allowedModifications: [
      "paper-only logic changes in audit/control-plane routes and supporting libs",
      "deterministic validation wiring and diagnostics references",
      "additive test updates for modified code paths",
    ],
    forbiddenModifications: [
      "live trading execution behavior changes",
      "autonomous promotion or self-editing workflows",
      "schema/data model migration unless explicitly approved",
      "broad refactors outside suspected modules",
    ],
    validationCommands: [
      "npm run lint",
      "npx tsc --noEmit",
      "npm run dump:post-boot-runtime-validation-report",
      "npm run dump:current-paper-blocker-report",
    ],
    successCriteria: [
      "validation commands pass deterministically",
      "runtime health remains fail-closed and paper-only",
      "issue-specific failing metrics move to target ranges",
    ],
    deploymentScope: "paper_only",
    rollbackReference: null,
  };
}

function suspectedModulesForDiagnosis(diagnosis: string): string[] {
  if (diagnosis.startsWith("ml_") || diagnosis.includes("predictive") || diagnosis.includes("label")) {
    return ["lib/control-plane/audit.ts", "lib/ops/self-improvement-loop.ts", "lib/ml/"];
  }
  if (diagnosis.startsWith("runtime_") || diagnosis.includes("guardrail") || diagnosis.includes("validation")) {
    return ["app/api/ops/runtime/health/route.ts", "lib/runtime/", "lib/control-plane/validation.ts"];
  }
  return ["lib/control-plane/audit.ts", "lib/paper-trading/analytics.ts"];
}

export function buildRepairPacketFromIssue(
  issue: ControlPlaneIssue,
  input: RepairPacketInput = {}
): RepairPacket {
  const evidenceMetrics = Object.entries(issue.evidence)
    .filter(([_, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean" || v == null)
    .slice(0, 6)
    .map(([name, observed]) => ({
      name,
      observed: observed as number | string | boolean | null,
      expected: "improve_from_current_baseline",
    }));

  return buildRepairPacket(issue.id, {
    severity: input.severity ?? issue.severity,
    affectedBotOrModel: input.affectedBotOrModel ?? issue.botId ?? issue.modelVersion ?? null,
    diagnosisSummary:
      input.diagnosisSummary ??
      `${issue.diagnosis}: ${issue.reason}`,
    failingMetrics: input.failingMetrics ?? evidenceMetrics,
    evidenceRefs: input.evidenceRefs ?? [`/api/audit/issues`, `/api/issues/${issue.id}/action`],
    suspectedModules: input.suspectedModules ?? suspectedModulesForDiagnosis(issue.diagnosis),
  });
}
