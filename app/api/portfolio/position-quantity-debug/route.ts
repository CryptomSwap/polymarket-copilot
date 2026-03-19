import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { derivePositionsFromFills, sizeToShares } from "@/lib/polymarket/portfolio";

export const dynamic = "force-dynamic";

function parseNum(s: string): number {
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET /api/portfolio/position-quantity-debug?assetIds=id1,id2
 * For each given assetId (or sample from derived positions), returns fills in chronological order,
 * signed quantity contribution per fill, running net quantity, cost contribution, and final derived size.
 * Use to reconcile position quantities with Polymarket UI.
 */
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
  const normalizeAssetId = (id: string) => String(id ?? "").trim();

  let assetIds: string[] = [];
  if (assetIdsParam) {
    assetIds = assetIdsParam.split(",").map((s) => normalizeAssetId(s)).filter(Boolean);
  }
  if (assetIds.length === 0) {
    const { rows } = await derivePositionsFromFills(funder);
    assetIds = rows.slice(0, 3).map((r) => r.assetId);
  }

  const fills = await prisma.userFill.findMany({
    where: { funderAddress: funder, assetId: { in: assetIds } },
    orderBy: [{ matchTime: "asc" }, { tradeId: "asc" }],
  });

  const seenFillSignature = new Set<string>();
  const byAsset = new Map<
    string,
    {
      rawFillCount: number;
      keptCount: number;
      skippedCount: number;
      fills: Array<{
        tradeId: string;
        matchTime: string | null;
        side: string;
        sizeRaw: string;
        sizeShares: number;
        signedQuantity: number;
        price: number;
        costContribution: number;
        runningNetQuantity: number;
        runningCostNet: number;
        kept: boolean;
        skipReason: string | null;
      }>;
      finalNetQuantity: number;
      finalCostNet: number;
    }
  >();

  for (const f of fills) {
    const key = normalizeAssetId(f.assetId);
    const matchTime = f.matchTime ? new Date(f.matchTime) : null;
    const timeKey = matchTime ? String(Math.floor(matchTime.getTime() / 1000)) : "";
    const fillSignature = `${key}|${timeKey}|${String(f.size).trim()}|${String(f.side).trim()}`;
    const isDuplicate = seenFillSignature.has(fillSignature);
    if (!isDuplicate) seenFillSignature.add(fillSignature);

    const mult = f.side === "BUY" ? 1 : -1;
    const sizeShares = sizeToShares(parseNum(f.size), f.size) * mult;
    const price = parseNum(f.price);
    const costContribution = sizeShares * price;

    let entry = byAsset.get(key);
    if (!entry) {
      entry = { rawFillCount: 0, keptCount: 0, skippedCount: 0, fills: [], finalNetQuantity: 0, finalCostNet: 0 };
      byAsset.set(key, entry);
    }
    entry.rawFillCount++;
    if (isDuplicate) {
      entry.skippedCount++;
      entry.fills.push({
        tradeId: f.tradeId,
        matchTime: matchTime?.toISOString() ?? null,
        side: f.side,
        sizeRaw: f.size,
        sizeShares: sizeToShares(parseNum(f.size), f.size),
        signedQuantity: sizeShares,
        price,
        costContribution,
        runningNetQuantity: entry.fills.length > 0 ? entry.fills[entry.fills.length - 1].runningNetQuantity : 0,
        runningCostNet: entry.fills.length > 0 ? entry.fills[entry.fills.length - 1].runningCostNet : 0,
        kept: false,
        skipReason: "duplicate (same assetId, timeBucket=1s, size, side)",
      });
      continue;
    }
    entry.keptCount++;
    const runningNetBefore = entry.fills.length === 0 ? 0 : entry.fills[entry.fills.length - 1].runningNetQuantity;
    const runningCostBefore = entry.fills.length === 0 ? 0 : entry.fills[entry.fills.length - 1].runningCostNet;
    entry.fills.push({
      tradeId: f.tradeId,
      matchTime: matchTime?.toISOString() ?? null,
      side: f.side,
      sizeRaw: f.size,
      sizeShares: sizeToShares(parseNum(f.size), f.size),
      signedQuantity: sizeShares,
      price,
      costContribution,
      runningNetQuantity: runningNetBefore + sizeShares,
      runningCostNet: runningCostBefore + costContribution,
      kept: true,
      skipReason: null,
    });
    entry.finalNetQuantity = runningNetBefore + sizeShares;
    entry.finalCostNet = runningCostBefore + costContribution;
  }

  const { rows: derivedRows } = await derivePositionsFromFills(funder);
  const derivedByAsset = new Map(derivedRows.map((r) => [normalizeAssetId(r.assetId), r]));

  const traces = Array.from(byAsset.entries()).map(([assetId, data]) => {
    const derived = derivedByAsset.get(assetId);
    return {
      assetId,
      rawFillCount: data.rawFillCount,
      keptCount: data.keptCount,
      skippedCount: data.skippedCount,
      fills: data.fills,
      finalNetQuantity: data.finalNetQuantity,
      finalCostNet: data.finalCostNet,
      derivedPositionSize: derived ? parseNum(derived.size) : null,
      derivedCostBasis: derived ? parseNum(derived.costBasis) : null,
      match: derived != null && Math.abs(data.finalNetQuantity - parseNum(derived.size)) < 1e-6,
    };
  });

  return NextResponse.json({
    funderAddress: funder,
    assetIdsRequested: assetIds,
    note: "Fills in matchTime order. BUY=+quantity, SELL=-quantity. Dedupe by (assetId, timeBucket=1s, size, side). Kept vs skipped per fill.",
    traces,
  });
}
