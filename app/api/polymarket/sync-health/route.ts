import { NextResponse } from "next/server";
import { getLastSyncJob } from "@/lib/polymarket/sync-job";

/**
 * GET /api/polymarket/sync-health
 * Returns last market sync and user sync time/status and latest error if any.
 */
export async function GET() {
  try {
    const [lastMarketSync, lastUserSync] = await Promise.all([
      getLastSyncJob("market_sync"),
      getLastSyncJob("user_sync"),
    ]);

    return NextResponse.json({
      lastMarketSync: lastMarketSync
        ? {
            status: lastMarketSync.status,
            startedAt: lastMarketSync.startedAt.toISOString(),
            finishedAt: lastMarketSync.finishedAt?.toISOString() ?? null,
            errorMessage: lastMarketSync.errorMessage ?? null,
            metadata: lastMarketSync.metadata ?? undefined,
          }
        : null,
      lastUserSync: lastUserSync
        ? {
            status: lastUserSync.status,
            startedAt: lastUserSync.startedAt.toISOString(),
            finishedAt: lastUserSync.finishedAt?.toISOString() ?? null,
            errorMessage: lastUserSync.errorMessage ?? null,
            metadata: lastUserSync.metadata ?? undefined,
          }
        : null,
    });
  } catch (error) {
    console.error("[GET /api/polymarket/sync-health]", error);
    return NextResponse.json(
      { error: "Failed to get sync health" },
      { status: 500 }
    );
  }
}
