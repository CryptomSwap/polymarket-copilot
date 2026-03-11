import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  alertId: z.string(),
  resolved: z.boolean().default(true),
});

/**
 * POST /api/live/alerts/resolve
 * Mark a drift alert as resolved or unresolved.
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
  } catch {
    return NextResponse.json(
      { error: "Invalid body. Required: alertId. Optional: resolved (default true)." },
      { status: 400 }
    );
  }

  const alert = await prisma.driftAlert.findFirst({
    where: { id: body.alertId, funderAddress: funder.toLowerCase() },
  });

  if (!alert) {
    return NextResponse.json({ error: "Alert not found." }, { status: 404 });
  }

  await prisma.driftAlert.update({
    where: { id: body.alertId },
    data: { resolved: body.resolved },
  });

  return NextResponse.json({ success: true, resolved: body.resolved });
}
