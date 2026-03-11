import { NextRequest, NextResponse } from "next/server";
import { syncMarkets } from "@/lib/polymarket/markets";
import { recordSyncJobStart, recordSyncJobFinish } from "@/lib/polymarket/sync-job";

/**
 * POST /api/polymarket/markets/sync
 * Fetches markets from Gamma API and upserts SyncedMarket + SyncedAsset.
 * Query or body: activeOnly (default true), maxPages (default 5), limit (default 100).
 * Use activeOnly=false and maxPages=50 for broad sync including closed/resolved markets.
 */
export async function POST(request: NextRequest) {
  const jobId = await recordSyncJobStart("market_sync");
  const url = request.url ? new URL(request.url) : null;
  let activeOnly = url?.searchParams.get("activeOnly") !== "false";
  let maxPages = 5;
  let limit = 100;
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body?.activeOnly === "boolean") activeOnly = body.activeOnly;
    if (typeof body?.activeOnly === "string") activeOnly = body.activeOnly !== "false";
    if (typeof body?.maxPages === "number" && body.maxPages > 0) maxPages = Math.min(body.maxPages, 100);
    if (typeof body?.pages === "number" && body.pages > 0) maxPages = Math.min(body.pages, 100);
  } catch {
    // ignore body parse
  }
  if (url?.searchParams.get("maxPages")) {
    const n = parseInt(url.searchParams.get("maxPages") ?? "", 10);
    if (Number.isFinite(n) && n > 0) maxPages = Math.min(n, 100);
  }
  if (url?.searchParams.get("pages")) {
    const n = parseInt(url.searchParams.get("pages") ?? "", 10);
    if (Number.isFinite(n) && n > 0) maxPages = Math.min(n, 100);
  }

  try {
    const result = await syncMarkets({ limit, maxPages, activeOnly });
    await recordSyncJobFinish(jobId, "success", {
      metadata: { synced: result.synced, errors: result.errors, diagnostics: result.diagnostics },
    });
    return NextResponse.json({
      success: true,
      synced: result.synced,
      errors: result.errors,
      diagnostics: result.diagnostics,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await recordSyncJobFinish(jobId, "failure", { errorMessage: message });
    console.error("[POST /api/polymarket/markets/sync]", error);
    return NextResponse.json(
      { error: "Market sync failed", details: message },
      { status: 500 }
    );
  }
}
