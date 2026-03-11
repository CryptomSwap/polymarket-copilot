import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reason: z.string().optional(),
});

/**
 * POST /api/bot/approval-queue/[id]/reject
 * Set entry status to REJECTED. Optional body: { reason }.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { id } = await params;
  const funderNorm = funder.toLowerCase().trim();

  const entry = await prisma.approvalQueueEntry.findUnique({
    where: { id },
  });

  if (!entry || entry.funderAddress !== funderNorm) {
    return NextResponse.json({ error: "Entry not found." }, { status: 404 });
  }

  let body: z.infer<typeof bodySchema> = {};
  try {
    const raw = await request.json().catch(() => ({}));
    body = bodySchema.parse(raw);
  } catch {
    // optional body
  }

  const updated = await prisma.approvalQueueEntry.update({
    where: { id },
    data: {
      status: "REJECTED",
      reason: body.reason ?? entry.reason ?? null,
      updatedAt: new Date(),
    },
  });

  return NextResponse.json({
    id: updated.id,
    funderAddress: updated.funderAddress,
    idempotencyKey: updated.idempotencyKey,
    recommendationId: updated.recommendationId,
    marketId: updated.marketId,
    assetId: updated.assetId,
    outcome: updated.outcome,
    side: updated.side,
    limitPrice: updated.limitPrice,
    size: updated.size,
    marketTitle: updated.marketTitle,
    status: updated.status,
    reason: updated.reason,
    orderIntentId: updated.orderIntentId,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  });
}
