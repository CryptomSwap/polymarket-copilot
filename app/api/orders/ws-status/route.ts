import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/orders/ws-status
 * Placeholder for WebSocket connection status. When a long-lived WS process exists,
 * it can update shared state and this endpoint can return { connected: true, lastMessageAt }.
 * TODO: Live order/fill events from WS should trigger reconciliation updates.
 */
export async function GET() {
  return NextResponse.json({
    connected: false,
    message: "WebSocket runs server-side; connection status not yet exposed. Run user sync and Reconcile to refresh order state.",
  });
}
