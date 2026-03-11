import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { logReviewStatus } from "@/lib/analytics/lifecycle";
import { z } from "zod";

export const dynamic = "force-dynamic";

const REVIEW_STATUSES = ["NEW", "REVIEWED", "APPROVED", "REJECTED", "ARCHIVED"] as const;
const bodySchema = z.object({
  recommendationId: z.string(),
  status: z.enum(REVIEW_STATUSES),
  reviewerNote: z.string().optional(),
});

/**
 * POST /api/recommendations/review
 * Set review status and optional reviewer note. Creates or updates RecommendationReview.
 * Read-only: no order placement. TODO: Future manual execution approval can gate on status === APPROVED.
 */
export async function POST(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const raw = await request.json().catch(() => ({}));
    body = bodySchema.parse(raw);
  } catch (e) {
    return NextResponse.json(
      { error: "Invalid body. Required: recommendationId, status (NEW|REVIEWED|APPROVED|REJECTED|ARCHIVED). Optional: reviewerNote." },
      { status: 400 }
    );
  }

  const rec = await prisma.recommendation.findUnique({
    where: { id: body.recommendationId },
    include: { marketSignal: true },
  });
  if (!rec || rec.marketSignal.funderAddress !== funder) {
    return NextResponse.json({ error: "Recommendation not found" }, { status: 404 });
  }

  const updated = await prisma.recommendationReview.upsert({
    where: { recommendationId: body.recommendationId },
    create: {
      recommendationId: body.recommendationId,
      status: body.status,
      reviewerNote: body.reviewerNote ?? undefined,
    },
    update: {
      status: body.status,
      reviewerNote: body.reviewerNote ?? undefined,
    },
  });

  void logReviewStatus(body.recommendationId, funder, body.status);

  return NextResponse.json({
    review: {
      id: updated.id,
      recommendationId: updated.recommendationId,
      status: updated.status,
      reviewerNote: updated.reviewerNote,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}
