import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  slug: z.string().optional(),
  marketId: z.string().optional(),
  note: z.string().min(1),
  tag: z.enum(["news", "thesis", "warning", "catalyst", "manual"]).default("manual"),
}).refine((d) => d.slug ?? d.marketId, { message: "Provide slug or marketId" });

/**
 * POST /api/markets/note
 * Add a note for a market. Body: { slug? or marketId?, note, tag? }.
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
      { error: "Invalid body. Provide slug or marketId, and note. Optional: tag." },
      { status: 400 }
    );
  }

  const market = body.marketId
    ? await prisma.syncedMarket.findUnique({ where: { id: body.marketId } })
    : await prisma.syncedMarket.findUnique({ where: { slug: body.slug! } });
  if (!market) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  const created = await prisma.marketNote.create({
    data: {
      funderAddress: funder,
      marketId: market.id,
      slug: market.slug,
      note: body.note,
      tag: body.tag,
    },
  });

  return NextResponse.json({
    note: {
      id: created.id,
      note: created.note,
      tag: created.tag,
      marketId: market.id,
      createdAt: created.createdAt.toISOString(),
    },
  });
}
