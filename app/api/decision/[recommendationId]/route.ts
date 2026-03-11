import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/decision/[recommendationId]
 * Returns decision snapshot for a recommendation (policy state, blended score, size guidance, reasoning).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ recommendationId: string }> }
) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { recommendationId } = await params;

  const snapshot = await prisma.decisionPolicySnapshot.findUnique({
    where: {
      recommendationId_funderAddress: { recommendationId, funderAddress: funder },
    },
    include: {
      recommendation: {
        include: {
          marketSignal: true,
          review: true,
        },
      },
    },
  });

  if (!snapshot || !snapshot.recommendation || snapshot.recommendation.marketSignal.funderAddress !== funder) {
    return NextResponse.json({ error: "Decision not found for this recommendation." }, { status: 404 });
  }

  let reasoning: unknown = null;
  if (snapshot.reasoningJson) {
    try {
      reasoning = JSON.parse(snapshot.reasoningJson);
    } catch {
      reasoning = { raw: snapshot.reasoningJson };
    }
  }

  return NextResponse.json({
    recommendationId: snapshot.recommendationId,
    funderAddress: snapshot.funderAddress,
    policyState: snapshot.policyState,
    blendedScore: snapshot.blendedScore,
    sizeMultiplier: snapshot.sizeMultiplier,
    finalSuggestedSize: snapshot.finalSuggestedSize,
    reasoning,
    recommendation: {
      action: snapshot.recommendation.action,
      blockedReason: snapshot.recommendation.blockedReason,
      priorityScore: snapshot.recommendation.priorityScore,
      mlScore: snapshot.recommendation.mlScore,
      suggestedSize: snapshot.recommendation.suggestedSize,
      marketTitle: snapshot.recommendation.marketSignal.marketTitle,
      outcome: snapshot.recommendation.marketSignal.outcome,
      signalType: snapshot.recommendation.marketSignal.signalType,
      reviewStatus: snapshot.recommendation.review?.status ?? "NEW",
    },
    createdAt: snapshot.createdAt.toISOString(),
    updatedAt: snapshot.updatedAt.toISOString(),
  });
}
