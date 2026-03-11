import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * GET /api/decision/top
 * Returns top recommendations by blended score with decision snapshot. Query: limit (default 20).
 */
export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit")) || 20, 100);

  const snapshots = await prisma.decisionPolicySnapshot.findMany({
    where: { funderAddress: funder },
    include: {
      recommendation: {
        include: {
          marketSignal: true,
          review: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: limit * 2,
  });

  const sorted = [...snapshots]
    .filter((s) => s.recommendation != null)
    .sort((a, b) => parseFloat(b.blendedScore) - parseFloat(a.blendedScore))
    .slice(0, limit);

  return NextResponse.json({
    items: sorted.map((s) => ({
      recommendationId: s.recommendationId,
      policyState: s.policyState,
      blendedScore: s.blendedScore,
      sizeMultiplier: s.sizeMultiplier,
      finalSuggestedSize: s.finalSuggestedSize,
      reasoningJson: s.reasoningJson,
      marketTitle: s.recommendation!.marketSignal.marketTitle,
      outcome: s.recommendation!.marketSignal.outcome,
      action: s.recommendation!.action,
      reviewStatus: s.recommendation!.review?.status ?? "NEW",
      updatedAt: s.updatedAt.toISOString(),
    })),
  });
}
