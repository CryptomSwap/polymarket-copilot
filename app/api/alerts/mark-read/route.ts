import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";

export const dynamic = "force-dynamic";

/**
 * POST /api/alerts/mark-read
 * Mark one or more Copilot alerts as read. Body: { ids?: string[], markAll?: boolean }.
 * Only alerts for the connected funder are updated.
 */
export async function POST(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  let body: { ids?: string[]; markAll?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body. Use { ids?: string[], markAll?: boolean }." },
      { status: 400 }
    );
  }

  const funderLower = funder.toLowerCase();
  const where = { funderAddress: funderLower };

  if (body.markAll) {
    const result = await prisma.copilotAlert.updateMany({
      where: { ...where, isRead: false },
      data: { isRead: true },
    });
    return NextResponse.json({
      ok: true,
      markedCount: result.count,
    });
  }

  if (Array.isArray(body.ids) && body.ids.length > 0) {
    const ids = body.ids.slice(0, 100);
    const result = await prisma.copilotAlert.updateMany({
      where: { id: { in: ids }, funderAddress: funderLower },
      data: { isRead: true },
    });
    return NextResponse.json({
      ok: true,
      markedCount: result.count,
    });
  }

  return NextResponse.json(
    { error: "Provide ids (string[]) or markAll: true." },
    { status: 400 }
  );
}
