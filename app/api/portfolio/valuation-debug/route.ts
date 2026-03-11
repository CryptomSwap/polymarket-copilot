import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { derivePositionsFromFills } from "@/lib/polymarket/portfolio";

export const dynamic = "force-dynamic";

/**
 * GET /api/portfolio/valuation-debug
 * Returns per-position valuation debug for comparison with Polymarket wallet.
 * Run after recompute so positions use token-level current price (MarketPriceSnapshot or SyncedMarket.raw).
 * Includes before/after note: previously we used last fill or avgEntry as "price", inflating current value.
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }
  const { rows, valuationDebug } = await derivePositionsFromFills(funder);
  const totalCurrentValue = rows.reduce((s, p) => s + parseFloat(p.marketValue || "0"), 0);
  const totalCostBasis = rows.reduce((s, p) => s + parseFloat(p.costBasis || "0"), 0);

  const note = `Valuation: currentValue = shares × tokenCurrentPrice. Price: (1) MarketPriceSnapshot, (2) SyncedMarket.raw, (3) last fill/order, (4) avgEntry. Size: CLOB returns size in 6-decimal units (1 share = 1e6); we normalize to display shares so DerivedPosition.size matches wallet share counts (e.g. Iran YES 103.6, Crude 725).`;

  const crudeOil = valuationDebug.find(
    (r) => /crude|oil|wti|brent/i.test(r.marketTitle)
  );
  const iran = valuationDebug.find((r) => /iran/i.test(r.marketTitle));
  const beforeAfterExamples = [
    crudeOil
      ? {
          label: "Example (crude oil)",
          marketTitle: crudeOil.marketTitle,
          shares: crudeOil.shares,
          avgEntry: crudeOil.avgEntry,
          tokenCurrentPrice: crudeOil.currentPriceUsed,
          currentValue: crudeOil.currentValueComputed,
          costBasis: crudeOil.costBasis,
          maxPayout: crudeOil.maxPayout,
          unrealizedPnl: crudeOil.unrealizedPnl,
          priceSourceUsed: crudeOil.priceSourceUsed,
        }
      : null,
    iran
      ? {
          label: "Example (Iran)",
          marketTitle: iran.marketTitle,
          shares: iran.shares,
          avgEntry: iran.avgEntry,
          tokenCurrentPrice: iran.currentPriceUsed,
          currentValue: iran.currentValueComputed,
          costBasis: iran.costBasis,
          maxPayout: iran.maxPayout,
          unrealizedPnl: iran.unrealizedPnl,
          priceSourceUsed: iran.priceSourceUsed,
        }
      : null,
  ].filter(Boolean);

  return NextResponse.json({
    funderAddress: funder,
    note,
    totalPositions: rows.length,
    totalCurrentValue,
    totalCostBasis,
    valuationDebug: valuationDebug.slice(0, 10),
    beforeAfterExamples,
  });
}
