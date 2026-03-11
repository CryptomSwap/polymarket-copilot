import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { executionKey, type BotCandidate } from "@/lib/bot/types";
import { z } from "zod";

export const dynamic = "force-dynamic";

const APPROVAL_QUEUE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "EXECUTED", "FAILED"] as const;

function toEntryJson(entry: {
  id: string;
  funderAddress: string;
  idempotencyKey: string;
  recommendationId: string;
  marketId: string;
  assetId: string;
  outcome: string;
  side: string;
  limitPrice: string;
  size: string;
  marketTitle: string | null;
  status: string;
  reason: string | null;
  orderIntentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: entry.id,
    funderAddress: entry.funderAddress,
    idempotencyKey: entry.idempotencyKey,
    recommendationId: entry.recommendationId,
    marketId: entry.marketId,
    assetId: entry.assetId,
    outcome: entry.outcome,
    side: entry.side,
    limitPrice: entry.limitPrice,
    size: entry.size,
    marketTitle: entry.marketTitle,
    status: entry.status,
    reason: entry.reason,
    orderIntentId: entry.orderIntentId,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

/**
 * GET /api/bot/approval-queue
 * List entries for the connected funder. Query: ?status=PENDING|APPROVED|REJECTED|... (optional).
 */
export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const url = request.url ? new URL(request.url) : null;
  const statusParam = url?.searchParams.get("status")?.toUpperCase();

  const where: { funderAddress: string; status?: string } = {
    funderAddress: funder.toLowerCase().trim(),
  };
  if (statusParam && APPROVAL_QUEUE_STATUSES.includes(statusParam as (typeof APPROVAL_QUEUE_STATUSES)[number])) {
    where.status = statusParam;
  }

  const entries = await prisma.approvalQueueEntry.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }],
  });

  return NextResponse.json({
    entries: entries.map(toEntryJson),
  });
}

const postBodySchema = z.object({
  recommendationId: z.string(),
  marketId: z.string(),
  assetId: z.string(),
  outcome: z.string(),
  side: z.enum(["BUY", "SELL"]),
  limitPrice: z.string(),
  size: z.string(),
  marketTitle: z.string().nullable().optional(),
});

/**
 * POST /api/bot/approval-queue
 * Create or update queue entry from a bot candidate. Idempotency by (funderAddress, idempotencyKey).
 * If entry exists: reset status to PENDING and update marketTitle. No order placed.
 */
export async function POST(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  let body: z.infer<typeof postBodySchema>;
  try {
    const raw = await request.json().catch(() => ({}));
    body = postBodySchema.parse(raw);
  } catch {
    return NextResponse.json(
      { error: "Invalid body. Required: recommendationId, marketId, assetId, outcome, side, limitPrice, size." },
      { status: 400 }
    );
  }

  const candidate: BotCandidate = {
    recommendationId: body.recommendationId,
    marketId: body.marketId,
    assetId: body.assetId,
    outcome: body.outcome,
    side: body.side,
    limitPrice: body.limitPrice,
    size: body.size,
    primaryActionType: null,
    policyState: "",
    finalSuggestedSize: body.size,
    marketTitle: body.marketTitle ?? null,
  };
  const idempotencyKey = executionKey(candidate);
  const funderNorm = funder.toLowerCase().trim();

  const existing = await prisma.approvalQueueEntry.findUnique({
    where: {
      funderAddress_idempotencyKey: { funderAddress: funderNorm, idempotencyKey },
    },
  });

  if (existing) {
    const updated = await prisma.approvalQueueEntry.update({
      where: { id: existing.id },
      data: {
        status: "PENDING",
        marketTitle: body.marketTitle ?? existing.marketTitle,
        reason: null,
        updatedAt: new Date(),
      },
    });
    return NextResponse.json(toEntryJson(updated));
  }

  const created = await prisma.approvalQueueEntry.create({
    data: {
      funderAddress: funderNorm,
      idempotencyKey,
      recommendationId: body.recommendationId,
      marketId: body.marketId,
      assetId: body.assetId,
      outcome: body.outcome,
      side: body.side,
      limitPrice: body.limitPrice,
      size: body.size,
      marketTitle: body.marketTitle ?? null,
      status: "PENDING",
    },
  });

  return NextResponse.json(toEntryJson(created));
}
