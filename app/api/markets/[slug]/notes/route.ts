import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { z } from "zod";

export const dynamic = "force-dynamic";

const noteBodySchema = z.object({
  note: z.string().min(1),
  tag: z.enum(["news", "thesis", "warning", "catalyst", "manual"]).default("manual"),
  marketId: z.string().optional(),
});

/**
 * GET /api/markets/[slug]/notes
 * Returns notes for the market (by slug or marketId).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { slug } = await params;
  const slugDecoded = decodeURIComponent(slug);

  const market = await prisma.syncedMarket.findUnique({
    where: { slug: slugDecoded },
  });
  if (!market) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  const notes = await prisma.marketNote.findMany({
    where: { funderAddress: funder, marketId: market.id },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    notes: notes.map((n) => ({
      id: n.id,
      note: n.note,
      tag: n.tag,
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
    })),
  });
}

/**
 * POST /api/markets/[slug]/notes
 * Add a note for the market. Body: { note, tag? }.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const { slug } = await params;
  const slugDecoded = decodeURIComponent(slug);

  const market = await prisma.syncedMarket.findUnique({
    where: { slug: slugDecoded },
  });
  if (!market) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  let body: z.infer<typeof noteBodySchema>;
  try {
    const raw = await request.json().catch(() => ({}));
    body = noteBodySchema.parse(raw);
  } catch (e) {
    return NextResponse.json(
      { error: "Invalid body. Required: note (string). Optional: tag (news|thesis|warning|catalyst|manual)." },
      { status: 400 }
    );
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
      createdAt: created.createdAt.toISOString(),
    },
  });
}
