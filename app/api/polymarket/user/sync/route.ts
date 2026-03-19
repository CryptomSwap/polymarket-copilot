import { NextResponse } from "next/server";
import { syncUser } from "@/lib/polymarket/user-sync";
import { recordSyncJobStart, recordSyncJobFinish } from "@/lib/polymarket/sync-job";
import { recomputePortfolio, getFunderForRecompute } from "@/lib/polymarket/recompute";
import { backfillHeldMarkets } from "@/lib/polymarket/markets";

/**
 * POST /api/polymarket/user/sync
 * Fetches open orders and all trades (fills, paginated) and builds position snapshots; upserts to DB.
 * After sync: backfills SyncedMarket + SyncedAsset for condition IDs the user holds (so portfolio resolution works), then recomputes portfolio.
 * Body: { fullResync?: boolean } — if true, clears UserFill for funder before fetching (full history resync).
 */
export async function POST(request: Request) {
  const jobId = await recordSyncJobStart("user_sync");
  let fullResync = false;
  try {
    const body = await request.json().catch(() => ({}));
    fullResync = body?.fullResync === true;
  } catch {
    // ignore
  }
  try {
    const result = await syncUser({ fullResync });
    const status = result.errors.length > 0 ? "failure" : "success";
    await recordSyncJobFinish(jobId, status, {
      errorMessage: result.errors.length > 0 ? result.errors.join("; ") : undefined,
      metadata: {
        ordersSynced: result.ordersSynced,
        fillsSynced: result.fillsSynced,
        positionsSynced: result.positionsSynced,
        fillsPagesFetched: result.fillsPagesFetched,
        totalFillsInDb: result.totalFillsInDb,
        fullResync,
        ordersFetchedRaw: result.ordersFetchedRaw,
        ordersAfterNormalization: result.ordersAfterNormalization,
        ordersPersisted: result.ordersPersisted,
        ordersSkipped: result.ordersSkipped,
        credentialsAvailable: result.credentialsAvailable,
        ordersFetchMethod: result.ordersFetchMethod,
        ordersFetchSkippedReason: result.ordersFetchSkippedReason,
        ordersFetchHelper: result.ordersFetchHelper,
        ordersRequestPath: result.ordersRequestPath,
        ordersStatus: result.ordersStatus,
        fillsFetchHelper: result.fillsFetchHelper,
        fillsEndpoint: result.fillsEndpoint,
        fillsRequestPath: result.fillsRequestPath,
        fillsStatus: result.fillsStatus,
        fillsBodySnippet: result.fillsBodySnippet,
        fillsPaginationAttempted: result.fillsPaginationAttempted,
        fillsPagesFetched: result.fillsPagesFetched,
        fillsClassification: result.fillsClassification,
        fillsPaginationTerminatedNormally: result.fillsPaginationTerminatedNormally,
        fillsLastNextCursorSeen: result.fillsLastNextCursorSeen,
        errors: result.errors,
      },
    });
    if (status === "success") {
      try {
        const funder = await getFunderForRecompute();
        if (funder) {
          const backfill = await backfillHeldMarkets(funder);
          if (backfill.stillMissing > 0 || backfill.errors.length > 0) {
            console.warn("[POST /api/polymarket/user/sync] backfill held markets", {
              distinctHeldConditionIds: backfill.distinctHeldConditionIds,
              upsertedMarkets: backfill.upsertedMarkets,
              upsertedAssets: backfill.upsertedAssets,
              stillMissing: backfill.stillMissing,
              errors: backfill.errors,
            });
          }
        }
        await recomputePortfolio();
      } catch (recomputeErr) {
        console.warn("[POST /api/polymarket/user/sync] recompute after sync failed:", recomputeErr);
      }
    }
    return NextResponse.json({
      success: result.errors.length === 0,
      ordersSynced: result.ordersSynced,
      fillsSynced: result.fillsSynced,
      positionsSynced: result.positionsSynced,
      fillsPagesFetched: result.fillsPagesFetched,
      totalFillsInDb: result.totalFillsInDb,
      fullResync,
      errors: result.errors,
      ordersFetchedRaw: result.ordersFetchedRaw,
      ordersAfterNormalization: result.ordersAfterNormalization,
      ordersPersisted: result.ordersPersisted,
      ordersSkipped: result.ordersSkipped,
      credentialsAvailable: result.credentialsAvailable,
      ordersFetchMethod: result.ordersFetchMethod,
      ordersFetchSkippedReason: result.ordersFetchSkippedReason,
      ordersFetchHelper: result.ordersFetchHelper,
      ordersRequestPath: result.ordersRequestPath,
      ordersStatus: result.ordersStatus,
      fillsFetchHelper: result.fillsFetchHelper,
      fillsEndpoint: result.fillsEndpoint,
      fillsRequestPath: result.fillsRequestPath,
      fillsStatus: result.fillsStatus,
      fillsBodySnippet: result.fillsBodySnippet,
      fillsPaginationAttempted: result.fillsPaginationAttempted,
      fillsClassification: result.fillsClassification,
      fillsPaginationTerminatedNormally: result.fillsPaginationTerminatedNormally,
      fillsLastNextCursorSeen: result.fillsLastNextCursorSeen,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await recordSyncJobFinish(jobId, "failure", { errorMessage: message });
    console.error("[POST /api/polymarket/user/sync]", error);
    return NextResponse.json(
      { error: "User sync failed", details: message },
      { status: 500 }
    );
  }
}
