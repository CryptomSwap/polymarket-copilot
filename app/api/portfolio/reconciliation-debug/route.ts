import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import {
  derivePositionsFromFills,
  sizeToShares,
  OPEN_POSITION_DUST_THRESHOLD,
} from "@/lib/polymarket/portfolio";

export const dynamic = "force-dynamic";

function parseNum(s: string): number {
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET /api/portfolio/reconciliation-debug
 * Reconciles portfolio derivation against CSV-style trade logic. For each sample asset (Crude 120/130/180, Iran March 6/10):
 * raw fill aggregation (BUY=+size, SELL=-size, by assetId), netShares, retained vs filtered as dust, and resulting DerivedPosition.
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const fills = await prisma.userFill.findMany({
    where: { funderAddress: funder },
    orderBy: [{ matchTime: "asc" }, { tradeId: "asc" }],
  });

  const normalizeAssetId = (id: string) => String(id ?? "").trim();
  const seenFillSignature = new Set<string>();

  // CSV-style aggregation: BUY = +size, SELL = -size, by assetId. Dedupe by (assetId, matchTime, size, side) to match derivation.
  const byAsset = new Map<
    string,
    { netShares: number; costBasisNet: number; fillCount: number; marketId: string; outcome: string }
  >();
  for (const f of fills) {
    const matchTime = f.matchTime ? new Date(f.matchTime) : null;
    const timeKey = matchTime ? String(Math.floor(matchTime.getTime() / 1000)) : "";
    const fillSignature = `${normalizeAssetId(f.assetId)}|${timeKey}|${String(f.size).trim()}|${String(f.side).trim()}`;
    if (seenFillSignature.has(fillSignature)) continue;
    seenFillSignature.add(fillSignature);

    const mult = f.side === "BUY" ? 1 : -1;
    const sizeShares = sizeToShares(parseNum(f.size), f.size) * mult;
    const price = parseNum(f.price);
    const cost = sizeShares * price;
    const key = normalizeAssetId(f.assetId);
    const existing = byAsset.get(key);
    if (!existing) {
      byAsset.set(key, {
        netShares: sizeShares,
        costBasisNet: cost,
        fillCount: 1,
        marketId: (f.market ?? "").trim(),
        outcome: f.outcome ?? "—",
      });
    } else {
      existing.netShares += sizeShares;
      existing.costBasisNet += cost;
      existing.fillCount += 1;
    }
  }

  const assetIds = Array.from(byAsset.keys());
  const assets =
    assetIds.length > 0
      ? await prisma.syncedAsset.findMany({
          where: { tokenId: { in: assetIds } },
          include: { syncedMarket: { select: { id: true, title: true } } },
        })
      : [];
  const metaByAssetId = new Map(
    assets.map((a) => [
      normalizeAssetId(a.tokenId),
      { marketTitle: a.syncedMarket.title, outcome: a.outcome },
    ])
  );

  const { rows: derivedRows } = await derivePositionsFromFills(funder);
  const derivedByAssetId = new Map(derivedRows.map((r) => [normalizeAssetId(r.assetId), r]));

  const dustThreshold = OPEN_POSITION_DUST_THRESHOLD;

  const samplePatterns = [
    /crude.*120|120.*crude|oil.*120/i,
    /crude.*130|130.*crude|oil.*130/i,
    /crude.*180|180.*crude|oil.*180/i,
    /iran.*march\s*10|march\s*10.*iran/i,
    /iran.*march\s*6|march\s*6.*iran/i,
  ];

  const reconciliation: Array<{
    assetId: string;
    marketTitle: string;
    outcome: string;
    netShares: number;
    costBasisNet: number;
    avgEntry: number;
    fillCount: number;
    retained: boolean;
    filteredReason: string | null;
    derivedSize: string | null;
    derivedAvgEntry: string | null;
    derivedCurrentValue: string | null;
  }> = [];

  for (const assetId of assetIds) {
    const agg = byAsset.get(assetId)!;
    const meta = metaByAssetId.get(assetId);
    const marketTitle = meta?.marketTitle ?? agg.marketId ?? "—";
    const outcome = meta?.outcome ?? agg.outcome ?? "—";
    const avgEntry =
      Math.abs(agg.netShares) > 1e-9
        ? Math.abs(agg.costBasisNet) / Math.abs(agg.netShares)
        : 0;
    const retained = agg.netShares > dustThreshold;
    let filteredReason: string | null = null;
    if (!retained) {
      if (agg.netShares <= 0) filteredReason = "negative_net";
      else if (agg.netShares <= dustThreshold) filteredReason = "dust";
    }
    const derived = derivedByAssetId.get(assetId);

    reconciliation.push({
      assetId,
      marketTitle,
      outcome,
      netShares: agg.netShares,
      costBasisNet: agg.costBasisNet,
      avgEntry,
      fillCount: agg.fillCount,
      retained,
      filteredReason,
      derivedSize: derived?.size ?? null,
      derivedAvgEntry: derived?.avgEntry ?? null,
      derivedCurrentValue: derived?.marketValue ?? null,
    });
  }

  const sample = reconciliation.filter((r) =>
    samplePatterns.some((p) => p.test(r.marketTitle))
  );
  const dustFiltered = reconciliation.filter((r) => r.filteredReason === "dust");
  const negativeFiltered = reconciliation.filter((r) => r.filteredReason === "negative_net");

  return NextResponse.json({
    funderAddress: funder,
    note: "CSV-style: BUY=+size, SELL=-size, aggregate by assetId. Retained only if netShares > dust threshold. Dust and negative-net are not open positions.",
    dustThreshold,
    totalFills: fills.length,
    totalAssetsInAggregation: byAsset.size,
    retainedCount: reconciliation.filter((r) => r.retained).length,
    dustFilteredCount: dustFiltered.length,
    negativeFilteredCount: negativeFiltered.length,
    sample,
    allReconciliation: reconciliation,
    dustFilteredSample: dustFiltered.slice(0, 10),
    negativeFilteredSample: negativeFiltered.slice(0, 10),
  });
}
