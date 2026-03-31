import type { ControlPlaneIssue, IssueActionDecision, IssueRecommendedAction } from "./contracts";

function requiresApproval(action: IssueRecommendedAction): boolean {
  return action === "cursor_repair" || action === "escalate";
}

export function decideIssueAction(issue: ControlPlaneIssue): IssueActionDecision {
  let action: IssueRecommendedAction = "observe";
  let policyReason = "Evidence is weak or insufficient; observe until confidence improves.";

  switch (issue.diagnosis) {
    case "negative_expectancy":
      action = issue.confidence === "high" ? "open_experiment" : "observe";
      policyReason = action === "open_experiment"
        ? "Bot expectancy is negative with sufficient sample; bounded paper experiment is safer than direct code change."
        : "Negative expectancy signal exists but confidence is not high enough.";
      break;
    case "inactive_bot":
      action = issue.severity === "high" ? "escalate" : "observe";
      policyReason = action === "escalate"
        ? "Bot inactivity has material relevance; requires operator escalation."
        : "Inactive bot has limited evidence of impact; continue observation.";
      break;
    case "low_sample_uncertain":
    case "ml_helpfulness_unclear":
      action = "observe";
      policyReason = "Insufficient sample/clarity for intervention; remain fail-closed.";
      break;
    case "weak_rank_lift":
    case "redundant_bot":
    case "band_concentration_problem":
      action = "open_experiment";
      policyReason = "Behavior issue is measurable and bounded; run paper-only experiment before repair.";
      break;
    case "no_predictive_lift":
      action = issue.confidence === "high" ? "cursor_repair" : "open_experiment";
      policyReason = action === "cursor_repair"
        ? "ML shows no predictive lift under sufficient evidence and likely requires deterministic code/path repair."
        : "Predictive lift is poor but not fully conclusive; run bounded experiment first.";
      break;
    case "weak_predictive_lift":
      action = "open_experiment";
      policyReason = "Predictive lift is weak but non-zero; prefer bounded experiment over repair.";
      break;
    case "low_label_coverage":
      action = "auto_remediate";
      policyReason = "Low label coverage is usually addressed by deterministic dataset refresh/backfill paths.";
      break;
    case "feature_health_problem":
      action = "cursor_repair";
      policyReason = "Feature health diagnostics indicate likely code/config issue needing bounded repair packet.";
      break;
    case "drift_risk":
      action = "open_experiment";
      policyReason = "Drift risk should be addressed with controlled paper experiment and re-evaluation.";
      break;
    case "challenger_not_better":
      action = "observe";
      policyReason = "Promotion guardrail is functioning; keep champion and continue observing.";
      break;
    case "runtime_unhealthy":
      action = "auto_remediate";
      policyReason = "Runtime health is degraded and should trigger deterministic operational remediation, never experiment.";
      break;
    case "validation_blocked":
      action = "escalate";
      policyReason = "Validation pipeline is blocked; requires operator escalation.";
      break;
    case "experiment_guardrail_blocked":
      action = "observe";
      policyReason = "Guardrail block is expected fail-closed behavior; observe until eligibility improves.";
      break;
    default:
      action = "observe";
      policyReason = "No explicit policy mapping; default fail-closed observe.";
      break;
  }

  return {
    issueId: issue.id,
    action,
    policyReason,
    scope: "paper_only",
    requiresApproval: requiresApproval(action),
  };
}
