import { NextRequest, NextResponse } from "next/server";
import { getActiveOrApprovedShadowModel, scoreShadowCandidate } from "@/lib/ml/shadow-score";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/ml-shadow-score
 *
 * Inspect latest shadow model (ACTIVE or APPROVED). Advisory only.
 */
export async function GET(_request: NextRequest) {
  try {
    const model = await getActiveOrApprovedShadowModel();
    if (!model) {
      return NextResponse.json({
        hasShadowModel: false,
        message: "No ACTIVE or APPROVED shadow model. Train and approve/activate one first.",
      });
    }
    return NextResponse.json({
      hasShadowModel: true,
      modelId: model.run.id,
      featureSetName: model.run.featureSetName,
      targetLabel: model.run.targetLabel,
      isShadowModel: true,
    });
  } catch (error) {
    console.error("[GET /api/ops/ml-shadow-score]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Shadow score failed" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/ops/ml-shadow-score
 *
 * Score a candidate payload. Body: ShadowScoreInput (candidate context). Returns advisory output only.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const input = typeof body === "object" && body !== null ? body : {};
    const result = await scoreShadowCandidate({
      policyState: input.policyState ?? null,
      sizeMultiplier: input.sizeMultiplier ?? null,
      finalSuggestedSize: input.finalSuggestedSize ?? null,
      eligibilityBlockersCount: input.eligibilityBlockersCount ?? 0,
      reducedSizeIndicator: input.reducedSizeIndicator ?? false,
      blockedIndicator: input.blockedIndicator ?? false,
      executionAllow: input.executionAllow ?? null,
      executionWarningCount: input.executionWarningCount ?? 0,
      qualityState: input.qualityState ?? null,
      spreadBps: input.spreadBps ?? null,
      estimatedSlippage: input.estimatedSlippage ?? null,
      tradable: input.tradable ?? null,
      grossExposure: input.grossExposure ?? null,
      totalOpenExposure: input.totalOpenExposure ?? null,
      maxSingleMarketConcentrationPct: input.maxSingleMarketConcentrationPct ?? null,
      maxSingleThemeConcentrationPct: input.maxSingleThemeConcentrationPct ?? null,
      portfolioRiskFlagsCount: input.portfolioRiskFlagsCount ?? 0,
      runtimeWarningCount: input.runtimeWarningCount ?? 0,
      runtimeBlockingCount: input.runtimeBlockingCount ?? 0,
      intendedPrice: input.intendedPrice ?? "0",
      intendedSize: input.intendedSize ?? "0",
      recommendationPresent: input.recommendationPresent ?? false,
      side: input.side ?? "BUY",
    });
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }
    return NextResponse.json({ success: true, ...result.result });
  } catch (error) {
    console.error("[POST /api/ops/ml-shadow-score]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Shadow score failed" },
      { status: 500 }
    );
  }
}
