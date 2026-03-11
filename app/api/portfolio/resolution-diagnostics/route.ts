/**
 * GET /api/portfolio/resolution-diagnostics
 * Query: assetIds=id1,id2,id3 (optional) – trace why these positions failed to resolve.
 * If assetIds omitted, uses first 5 unresolved DerivedPosition assetIds for the connected funder.
 * Returns: traces with UserFill, SyncedAsset, SyncedMarket lookups and failureReason.
 */

import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { traceResolutionForAssetIds } from "@/lib/portfolio/resolution-diagnostics";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const url = request.url ? new URL(request.url) : null;
  const assetIdsParam = url?.searchParams.get("assetIds");
  let assetIds: string[] = [];
  if (assetIdsParam?.trim()) {
    assetIds = assetIdsParam.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (assetIds.length === 0) {
    const unresolved = await prisma.derivedPosition.findMany({
      where: { funderAddress: funder, syncedMarketId: null },
      select: { assetId: true },
      take: 5,
    });
    assetIds = unresolved.map((p) => p.assetId);
  }
  if (assetIds.length === 0) {
    return NextResponse.json({
      funderAddress: funder,
      message: "No assetIds to trace. Provide ?assetIds=id1,id2 or ensure there are unresolved positions.",
      traces: [],
    });
  }

  const traces = await traceResolutionForAssetIds(assetIds, funder);
  return NextResponse.json({
    funderAddress: funder,
    assetIdsRequested: assetIds.length,
    traces,
  });
}
