import { NextResponse } from "next/server";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { fetchOfficialPositions, officialPositionsByAsset } from "@/lib/polymarket/official-positions";
import { prisma } from "@/lib/db";
import { derivePositionsFromFills } from "@/lib/polymarket/portfolio";

export const dynamic = "force-dynamic";

const TOLERANCE = 0.01;

function parseNum(s: string): number {
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET /api/portfolio/positions-source-of-truth-debug
 * Compares Polymarket Data API current positions (source of truth) vs our trade-derived positions.
 * Returns per-asset: official quantity, derived quantity, delta, match flag, market title/slug when resolvable.
 * Address used for the API is the app's funder (stored credentials or connected wallet).
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  if (!funder) {
    return NextResponse.json(
      { error: "No funder address. Connect wallet and save connection." },
      { status: 400 }
    );
  }

  const [officialResult, derived] = await Promise.all([
    fetchOfficialPositions(funder),
    derivePositionsFromFills(funder),
  ]);

  const officialByAsset = officialPositionsByAsset(officialResult.positions);
  const derivedByAsset = new Map(derived.rows.map((r) => [r.assetId.trim(), r]));
  const officialAssetIdSet = new Set(
    officialResult.positions.map((p) => String(p.asset ?? "").trim()).filter(Boolean)
  );

  const allAssetIds = new Set<string>([
    ...officialAssetIdSet,
    ...derivedByAsset.keys(),
  ]);
  const comparison: Array<{
    assetId: string;
    marketTitle: string | null;
    marketSlug: string | null;
    officialQuantity: number | null;
    derivedQuantity: number | null;
    quantityDelta: number | null;
    matches: boolean;
    quantitySource: "official" | "derived" | "both_match" | "derived_only" | "official_only";
  }> = [];

  for (const assetId of allAssetIds) {
    const off = officialByAsset.get(assetId) ?? officialByAsset.get(assetId.toLowerCase());
    const der = derivedByAsset.get(assetId) ?? derivedByAsset.get(assetId.toLowerCase());
    const officialQ = off ? off.size : null;
    const derivedQ = der ? parseNum(der.size) : null;
    let quantityDelta: number | null = null;
    let matches = false;
    let quantitySource: "official" | "derived" | "both_match" | "derived_only" | "official_only" = "derived_only";
    if (officialQ != null && derivedQ != null) {
      quantityDelta = officialQ - derivedQ;
      matches = Math.abs(quantityDelta) <= TOLERANCE;
      quantitySource = matches ? "both_match" : "official";
    } else if (officialQ != null) quantitySource = "official_only";
    else if (derivedQ != null) quantitySource = "derived_only";

    comparison.push({
      assetId,
      marketTitle: off?.title ?? der?.marketTitle ?? null,
      marketSlug: off?.slug ?? null,
      officialQuantity: officialQ ?? null,
      derivedQuantity: derivedQ ?? null,
      quantityDelta,
      matches,
      quantitySource,
    });
  }

  const withMismatch = comparison.filter((c) => c.quantitySource === "official" && !c.matches);
  const matchCount = comparison.filter((c) => c.matches).length;
  const officialOnlyCount = comparison.filter((c) => c.quantitySource === "official_only").length;
  const derivedOnlyCount = comparison.filter((c) => c.quantitySource === "derived_only").length;

  return NextResponse.json({
    funderAddress: funder,
    addressUsedForApi: officialResult.addressUsed,
    note: "Official = Polymarket Data API GET /positions?user=<address>. Derived = our UserFill aggregation. Prefer official for open quantity.",
    officialFetchStatus: officialResult.status,
    officialFetchError: officialResult.error,
    officialPositionsCount: officialResult.positions.length,
    derivedPositionsCount: derived.rows.length,
    matchCount,
    mismatchCount: withMismatch.length,
    officialOnlyCount,
    derivedOnlyCount,
    tolerance: TOLERANCE,
    comparison,
    mismatches: withMismatch,
  });
}
