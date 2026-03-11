import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { cancelOrderByPolymarketId } from "@/lib/polymarket/trading";
import { logOrderCancelled } from "@/lib/analytics/lifecycle";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  polymarketOrderId: z.string(),
});

/**
 * POST /api/orders/cancel
 * Cancel an existing open order by Polymarket order ID. Updates local order status when present.
 * Manual only; no autonomous cancel.
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
      { error: "Invalid body. Required: polymarketOrderId." },
      { status: 400 }
    );
  }

  let result;
  try {
    result = await cancelOrderByPolymarketId(funder, body.polymarketOrderId, {
      executionSurface: "manual_api",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("[trading-execution-policy]")) {
      return NextResponse.json(
        { success: false, error: message },
        { status: 403 }
      );
    }
    throw err;
  }

  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error },
      { status: 400 }
    );
  }

  const exec = await prisma.executedOrder.findFirst({
    where: { funderAddress: funder, polymarketOrderId: body.polymarketOrderId },
    include: { orderIntent: true },
  });
  if (exec?.orderIntent?.recommendationId) {
    void logOrderCancelled(exec.orderIntent.recommendationId, funder, {
      polymarketOrderId: body.polymarketOrderId,
    });
  }

  return NextResponse.json({ success: true });
}
