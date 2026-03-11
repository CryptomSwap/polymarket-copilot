import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/markets
 * Returns list of synced markets (id, slug, title, status, category) for linking to detail pages.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? undefined;
  const limit = Math.min(Number(searchParams.get("limit")) || 100, 500);
  const activeOnlyParam = searchParams.get("activeOnly");
  const includeClosed = searchParams.get("includeClosed") === "true";
  const now = new Date();
  const cutoffDays = 30;
  const cutoff = new Date(now.getTime() - cutoffDays * 24 * 60 * 60 * 1000);

  const where: Record<string, unknown> = {};
  if (status) {
    where.status = status;
  } else if (!includeClosed) {
    where.status = { not: "closed" };
  }
  if (!includeClosed && !status && activeOnlyParam !== "false") {
    (where as any).OR = [{ endDate: null }, { endDate: { gte: cutoff } }];
  }

  const markets = await prisma.syncedMarket.findMany({
    where,
    orderBy: [
      { status: "asc" },
      { endDate: "asc" },
      { liquidityNum: "desc" },
    ],
    take: limit,
    select: { id: true, slug: true, title: true, status: true, category: true, endDate: true },
  });

  return NextResponse.json({
    markets: markets.map((m) => ({
      id: m.id,
      slug: m.slug,
      title: m.title,
      status: m.status,
      category: m.category,
      endDate: m.endDate?.toISOString() ?? null,
    })),
  });
}
