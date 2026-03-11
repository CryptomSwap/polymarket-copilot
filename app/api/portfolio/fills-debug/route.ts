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
 * GET /api/portfolio/fills-debug
 * For 3 sample assets, returns all raw UserFill rows plus normalized size, signed contribution, and resulting netShares/avgEntry.
 * Use to reconcile share counts with Polymarket wallet (Iran, Crude Oil, etc.).
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
    orderBy: { syncedAt: "asc" },
  });

  const { rows } = await derivePositionsFromFills(funder);
  const normalizeAssetId = (id: string) => String(id ?? "").trim();

  // Prefer Iran and Crude Oil for reconciliation with wallet; fill with first N up to 3.
  const iran = rows.find((r) => /iran/i.test(r.marketTitle ?? ""));
  const crude = rows.find((r) => /crude|oil|wti|brent|120|130/i.test(r.marketTitle ?? ""));
  const preferred = [iran?.assetId, crude?.assetId].filter(Boolean) as string[];
  const rest = rows.map((r) => r.assetId).filter((id) => !preferred.includes(normalizeAssetId(id)));
  const assetIds = [...new Set([...preferred, ...rest])].slice(0, 5);
  const sampleAssetSet = new Set(assetIds.map(normalizeAssetId));

  const byAsset = new Map<
    string,
    {
      fills: Array<{
        tradeId: string;
        market: string;
        assetId: string;
        side: string;
        price: string;
        sizeRaw: string;
        normalizedSizeUsed: number;
        signedContribution: number;
        costContribution: number;
      }>;
      netShares: number;
      costBasisNet: number;
      avgEntry: number;
    }
  >();

  for (const f of fills) {
    const key = normalizeAssetId(f.assetId);
    if (!sampleAssetSet.has(key)) continue;
    const mult = f.side === "BUY" ? 1 : -1;
    const rawNum = parseNum(f.size);
    const normalized = sizeToShares(rawNum, f.size);
    const signed = normalized * mult;
    const price = parseNum(f.price);
    const costContribution = signed * price;

    let entry = byAsset.get(key);
    if (!entry) {
      entry = { fills: [], netShares: 0, costBasisNet: 0, avgEntry: 0 };
      byAsset.set(key, entry);
    }
    entry.fills.push({
      tradeId: f.tradeId,
      market: f.market ?? "",
      assetId: f.assetId,
      side: f.side,
      price: f.price,
      sizeRaw: f.size,
      normalizedSizeUsed: normalized,
      signedContribution: signed,
      costContribution,
    });
    entry.netShares += signed;
    entry.costBasisNet += costContribution;
  }

  for (const [, entry] of byAsset) {
    const sizeAbs = Math.abs(entry.netShares);
    entry.avgEntry = sizeAbs > 0 ? Math.abs(entry.costBasisNet) / sizeAbs : 0;
  }

  const note =
    "Size normalization: CLOB returns size in 6-decimal units (1 share = 1e6). We convert to display shares via sizeToShares (if raw >= 1e5 and no decimal, divide by 1e6).";

  const samples = Array.from(byAsset.entries()).map(([assetId, data]) => ({
    assetId,
    fillCount: data.fills.length,
    fills: data.fills,
    resultingNetShares: data.netShares,
    resultingAvgEntry: data.avgEntry,
    costBasisNet: data.costBasisNet,
  }));

  const positionByAssetId = new Map(rows.map((r) => [normalizeAssetId(r.assetId), r]));
  const reconciliation = samples.map((s) => {
    const pos = positionByAssetId.get(normalizeAssetId(s.assetId));
    return {
      assetId: s.assetId,
      marketTitle: pos?.marketTitle ?? null,
      outcome: pos?.outcome ?? null,
      debugNetShares: s.resultingNetShares,
      derivedPositionSize: pos ? parseNum(pos.size) : null,
      derivedAvgEntry: pos ? parseNum(pos.avgEntry) : null,
      match: pos != null && Math.abs(s.resultingNetShares - parseNum(pos.size)) < 1e-6,
    };
  });

  return NextResponse.json({
    funderAddress: funder,
    note,
    totalFills: fills.length,
    sampleAssetIds: assetIds,
    samples,
    reconciliation,
    targetExamples: {
      iran: iran ? { assetId: iran.assetId, marketTitle: iran.marketTitle, outcome: iran.outcome, size: iran.size, avgEntry: iran.avgEntry } : null,
      crudeOil: crude ? { assetId: crude.assetId, marketTitle: crude.marketTitle, outcome: crude.outcome, size: crude.size, avgEntry: crude.avgEntry } : null,
    },
  });
}
