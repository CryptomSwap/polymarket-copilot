import { NextResponse } from "next/server";
import {
  getOrderLifecycleHistory,
  getLatestJournalStateForOrder,
} from "@/lib/runtime/journal/order-lifecycle-journal";

export const dynamic = "force-dynamic";

/**
 * GET /api/orders/lifecycle-history?funderAddress=0x...&clientOrderId=...&exchangeOrderId=...&limit=500&state=1
 * Inspect order lifecycle journal (secondary operator trace) by clientOrderId or exchangeOrderId.
 * Returns entries in chronological order and optionally the reconstructed state from journal replay.
 * For authoritative lifecycle use the execution ledger (OrderIntent, ExecutedOrder, timeline APIs).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const funderAddress = searchParams.get("funderAddress")?.trim();
  const clientOrderId = searchParams.get("clientOrderId")?.trim() || undefined;
  const exchangeOrderId = searchParams.get("exchangeOrderId")?.trim() || undefined;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "500", 10) || 500, 2000);
  const includeState = searchParams.get("state") === "1" || searchParams.get("state") === "true";

  if (!funderAddress) {
    return NextResponse.json(
      { error: "funderAddress is required" },
      { status: 400 }
    );
  }
  if (!clientOrderId && !exchangeOrderId) {
    return NextResponse.json(
      { error: "At least one of clientOrderId or exchangeOrderId is required" },
      { status: 400 }
    );
  }

  try {
    const entries = await getOrderLifecycleHistory({
      funderAddress,
      clientOrderId: clientOrderId || null,
      exchangeOrderId: exchangeOrderId || null,
      limit,
    });

    const result: {
      funderAddress: string;
      clientOrderId?: string;
      exchangeOrderId?: string;
      entries: Array<{
        id: string;
        eventType: string;
        occurredAt: string;
        createdAt: string;
        payloadJson: string | null;
        clientOrderId: string | null;
        exchangeOrderId: string | null;
      }>;
      reconstructedState?: unknown;
    } = {
      funderAddress,
      clientOrderId,
      exchangeOrderId,
      entries: entries.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        occurredAt: e.occurredAt.toISOString(),
        createdAt: e.createdAt.toISOString(),
        payloadJson: e.payloadJson,
        clientOrderId: e.clientOrderId,
        exchangeOrderId: e.exchangeOrderId,
      })),
    };

    if (includeState) {
      const state = await getLatestJournalStateForOrder({
        funderAddress,
        clientOrderId: clientOrderId || null,
        exchangeOrderId: exchangeOrderId || null,
      });
      result.reconstructedState = state
        ? {
            ...state,
            createdAt: state.createdAt.toISOString(),
            updatedAt: state.updatedAt.toISOString(),
            lastAckAt: state.lastAckAt?.toISOString() ?? null,
            lastFillAt: state.lastFillAt?.toISOString() ?? null,
          }
        : null;
    }

    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
