import { computeBootstrapActivationPreview, computeShadowPromotionPreview } from "@/lib/ops/self-improvement-loop";

export interface NextEligibleExperiment {
  id: string;
  eligible: boolean;
  reason: string;
  scope: "paper_only";
  recommendedAction: string;
}

export async function getNextEligibleExperiments(): Promise<{
  generatedAt: string;
  experiments: NextEligibleExperiment[];
}> {
  const [bootstrap, promotion] = await Promise.all([
    computeBootstrapActivationPreview(),
    computeShadowPromotionPreview(),
  ]);

  const experiments: NextEligibleExperiment[] = [
    {
      id: "ml_shadow_bootstrap_activate",
      eligible: bootstrap.wouldApprove,
      reason: bootstrap.reason,
      scope: "paper_only",
      recommendedAction: bootstrap.wouldApprove
        ? "run bounded bootstrap approval path"
        : "keep fail-closed and satisfy bootstrap guardrails",
    },
    {
      id: "ml_shadow_promote",
      eligible: promotion.wouldPromote,
      reason: promotion.outcomeReason,
      scope: "paper_only",
      recommendedAction: promotion.wouldPromote
        ? "run bounded promotion path with rollback guard"
        : "hold champion and gather more holdout evidence",
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    experiments,
  };
}
