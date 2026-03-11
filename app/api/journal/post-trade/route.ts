import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { z } from "zod";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  recommendationId: z.string().optional().nullable(),
  orderIntentId: z.string().optional().nullable(),
  executedOrderId: z.string().optional().nullable(),
  marketId: z.string(),
  assetId: z.string(),
  note: z.string().min(1),
  tag: z.string().default("manual"),
});

/**
 * POST /api/journal/post-trade
 * Create a post-trade journal entry. Manual only.
 */
export async function POST(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  let body: z.infer<typeof postSchema>;
  try {
    const raw = await request.json().catch(() => ({}));
    body = postSchema.parse(raw);
  } catch {
    return NextResponse.json(
      { error: "Invalid body. Required: marketId, assetId, note. Optional: recommendationId, orderIntentId, executedOrderId, tag." },
      { status: 400 }
    );
  }

  const entry = await prisma.postTradeJournalEntry.create({
    data: {
      funderAddress: funder.toLowerCase(),
      recommendationId: body.recommendationId ?? undefined,
      orderIntentId: body.orderIntentId ?? undefined,
      executedOrderId: body.executedOrderId ?? undefined,
      marketId: body.marketId,
      assetId: body.assetId,
      note: body.note,
      tag: body.tag,
    },
  });

  return NextResponse.json({
    id: entry.id,
    createdAt: entry.createdAt.toISOString(),
  });
}

/**
 * GET /api/journal/post-trade
 * List recent post-trade journal entries. Query: limit (default 50), recommendationId, executedOrderId.
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
  const limit = Math.min(Number(searchParams.get("limit")) || 50, 100);
  const recommendationId = searchParams.get("recommendationId") ?? undefined;
  const executedOrderId = searchParams.get("executedOrderId") ?? undefined;

  const where = {
    funderAddress: funder.toLowerCase(),
    ...(recommendationId && { recommendationId }),
    ...(executedOrderId && { executedOrderId }),
  };

  const entries = await prisma.postTradeJournalEntry.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return NextResponse.json({
    entries: entries.map((e) => ({
      id: e.id,
      recommendationId: e.recommendationId,
      orderIntentId: e.orderIntentId,
      executedOrderId: e.executedOrderId,
      marketId: e.marketId,
      assetId: e.assetId,
      note: e.note,
      tag: e.tag,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    })),
  });
}
