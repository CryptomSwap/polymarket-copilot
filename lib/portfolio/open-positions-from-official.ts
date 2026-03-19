/**
 * Open portfolio source-of-truth: official positions feed defines the open set.
 * Basis/PnL: prefer official API values when present and sane, then derived, then unavailable.
 */

import type { OfficialPosition } from "@/lib/polymarket/official-positions";
import { getOfficialBasisIfSane, isOfficialPositionStaleResolved } from "@/lib/polymarket/official-positions";
import type { DerivedPosition } from "@prisma/client";

function parseNum(s: string | null | undefined): number {
  if (s == null) return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/** Parse official API value (number or string) to number; null if missing or invalid. Used so we never fall back to derived when upstream sent a valid value. */
function officialNum(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = parseFloat(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function assetKey(assetId: string): string {
  return String(assetId ?? "").trim();
}

export type RowSource = "official+derived" | "official_only" | "derived_only";
export type QuantitySource = "official" | "derived";
export type PriceSource = "official" | "derived" | "cache";
export type BasisSource = "official" | "official_only" | "derived" | "unavailable";
export type PnlSource = "official" | "derived" | "unavailable";

export interface MergedOpenRow {
  assetId: string;
  marketId: string;
  conditionId: string | null;
  funderAddress: string;
  outcome: string;
  side: string;
  size: string;
  marketValue: string;
  /** Null when basisSource is "unavailable"; do not use "0" for unknown. */
  avgEntry: string | null;
  costBasis: string | null;
  realizedPnl: string;
  /** Null when basisSource is "unavailable"; do not leak stale derived PnL. */
  unrealizedPnl: string | null;
  lastPrice: string;
  quantitySource: QuantitySource;
  priceSource: PriceSource;
  basisSource: BasisSource;
  pnlSource: PnlSource;
  rowSource: RowSource;
  official: OfficialPosition | null;
  derived: DerivedPosition | null;
  /** For enrichment: marketId (conditionId or from derived). */
  enrichMarketId: string;
  marketTitle: string;
  category: string | null;
  theme: string | null;
  openedAt: Date | null;
  reservedOrderSize: string;
  reservedOrderValue: string;
}

export interface ExcludedStaleOfficialRow {
  assetId: string;
  marketTitle: string | null;
  reason: string;
}

export interface OpenPositionsFromOfficialResult {
  rows: MergedOpenRow[];
  diagnostics: {
    officialPositionsUsed: number;
    derivedRowsMatched: number;
    officialOnlyIncluded: number;
    derivedOnlyExcluded: number;
    rowsWithEstimatedBasis: number;
    rowsWithMissingBasis: number;
    closedOfficialExcluded: number;
    /** Count of official rows excluded as stale/resolved (redeemable or zero value + blank/past-dated). */
    staleOfficialExcluded: number;
    /** Sample of excluded stale rows for API diagnostics (max 20). */
    excludedStaleOfficialRows: ExcludedStaleOfficialRow[];
    rowsWithInvalidDerivedBasis: number;
    rowsWithSuppressedBasis: number;
    rowsWithOfficialBasis: number;
    rowsWithDerivedBasis: number;
    rowsWithUnavailableBasis: number;
  };
}

/**
 * Build open position rows from official feed; optional merge with derived for basis/enrichment.
 * When openOnly=true, ONLY official positions are in the set (derived-only excluded).
 * Row math: when using derived costBasis with official quantity, avgEntry = costBasis / quantity so quantity * avgEntry = costBasis.
 */
export function buildOpenPositionsFromOfficial(
  officialPositions: OfficialPosition[],
  derivedPositions: (DerivedPosition & { syncedMarket?: { status: string | null } | null })[],
  funderAddress: string,
  openOnly: boolean
): OpenPositionsFromOfficialResult {
  const officialAssetSet = new Set(
    officialPositions.map((o) => assetKey(o.asset)).filter(Boolean)
  );
  const derivedByAsset = new Map<string, DerivedPosition & { syncedMarket?: { status: string | null } | null }>();
  for (const d of derivedPositions) {
    const k = assetKey(d.assetId);
    if (k) derivedByAsset.set(k, d);
    const kLow = k.toLowerCase();
    if (kLow !== k) derivedByAsset.set(kLow, d);
  }

  const rows: MergedOpenRow[] = [];
  let derivedRowsMatched = 0;
  let officialOnlyIncluded = 0;
  let rowsWithEstimatedBasis = 0;
  let rowsWithMissingBasis = 0;
  let rowsWithInvalidDerivedBasis = 0;
  let rowsWithSuppressedBasis = 0;
  let rowsWithOfficialBasis = 0;
  let rowsWithDerivedBasis = 0;
  let rowsWithUnavailableBasis = 0;
  let staleOfficialExcluded = 0;
  const excludedStaleOfficialRows: ExcludedStaleOfficialRow[] = [];

  for (const o of officialPositions) {
    const assetId = assetKey(o.asset);
    if (!assetId) continue;

    const staleCheck = isOfficialPositionStaleResolved(o);
    if (staleCheck.exclude && staleCheck.reason) {
      staleOfficialExcluded++;
      if (excludedStaleOfficialRows.length < 20) {
        excludedStaleOfficialRows.push({
          assetId,
          marketTitle: o.title ?? null,
          reason: staleCheck.reason,
        });
      }
      continue;
    }

    const derived =
      derivedByAsset.get(assetId) ?? derivedByAsset.get(assetId.toLowerCase()) ?? null;
    if (derived) derivedRowsMatched++;
    else officialOnlyIncluded++;

    const quantity = o.size;
    // Use officialNum so we accept number or string from API; never fall back to derived when upstream sent valid curPrice/currentValue.
    const officialPrice = officialNum(o.curPrice);
    const officialCurrentValue = officialNum(o.currentValue);
    const derivedPrice = derived ? parseNum(derived.lastPrice) || parseNum(derived.avgEntry) : 0;
    const price = officialPrice ?? derivedPrice;
    const priceSource: PriceSource = officialPrice != null ? "official" : derived ? "derived" : "derived";
    const marketValueFromPrice = quantity * price;

    const officialBasis = getOfficialBasisIfSane(o);
    // Prefer raw official currentValue so live marks match Polymarket wallet; then basis snapshot; then quantity*price.
    // When getOfficialBasisIfSane returns null (e.g. no valid basis), we still use o.currentValue when the API sends it.
    const marketValue =
      officialCurrentValue != null
        ? officialCurrentValue
        : officialBasis != null
          ? officialBasis.currentValue
          : marketValueFromPrice;

    let costBasisNum: number;
    let avgEntryNum: number;
    let basisSource: BasisSource;
    let pnlSource: PnlSource;
    let realizedPnl = "0";
    let costBasisStr: string | null;
    let unrealizedPnlValue: string | null;

    if (officialBasis != null) {
      costBasisNum = officialBasis.costBasis;
      avgEntryNum = officialBasis.avgEntry;
      costBasisStr = String(costBasisNum);
      unrealizedPnlValue = String(officialBasis.unrealizedPnl);
      basisSource = derived ? "official" : "official_only";
      pnlSource = "official";
      realizedPnl =
        typeof o.realizedPnl === "number" && Number.isFinite(o.realizedPnl)
          ? String(o.realizedPnl)
          : derived?.realizedPnl ?? "0";
      rowsWithOfficialBasis++;
    } else {
      if (derived) {
        costBasisNum = parseNum(derived.costBasis);
        realizedPnl = derived.realizedPnl ?? "0";
        if (quantity > 0 && costBasisNum >= 0) {
          avgEntryNum = costBasisNum / quantity;
          costBasisStr = String(costBasisNum);
        } else {
          avgEntryNum =
            typeof o.avgPrice === "number" && Number.isFinite(o.avgPrice) ? o.avgPrice : 0;
          costBasisStr = quantity > 0 ? String(quantity * avgEntryNum) : null;
          if (quantity <= 0 || costBasisNum < 0) rowsWithEstimatedBasis++;
        }
        const sharePayout = 1;
        const maxCostBasis = quantity * sharePayout + 1e-6;
        const invalidDerived =
          quantity <= 0 ||
          avgEntryNum < 0 ||
          avgEntryNum > 1 + 1e-6 ||
          costBasisNum < 0 ||
          costBasisNum > maxCostBasis;
        if (invalidDerived) {
          rowsWithInvalidDerivedBasis++;
          rowsWithSuppressedBasis++;
          basisSource = "unavailable";
          pnlSource = "unavailable";
          costBasisStr = null;
          avgEntryNum = 0;
          costBasisNum = 0;
          unrealizedPnlValue = null;
          rowsWithUnavailableBasis++;
        } else {
          basisSource = "derived";
          pnlSource = "derived";
          unrealizedPnlValue = String(marketValue - costBasisNum);
          rowsWithDerivedBasis++;
        }
      } else {
        basisSource = "unavailable";
        pnlSource = "unavailable";
        costBasisStr = null;
        avgEntryNum = 0;
        costBasisNum = 0;
        unrealizedPnlValue = null;
        rowsWithMissingBasis++;
        rowsWithUnavailableBasis++;
      }
    }

    const avgEntryStr: string | null =
      basisSource === "unavailable" ? null : String(avgEntryNum);

    rows.push({
      assetId,
      marketId: o.conditionId ?? derived?.marketId ?? "",
      conditionId: o.conditionId ?? null,
      funderAddress,
      outcome: o.outcome ?? derived?.outcome ?? "—",
      side: derived?.side ?? (o.outcome?.toLowerCase() === "yes" ? "YES" : o.outcome?.toLowerCase() === "no" ? "NO" : "LONG"),
      size: String(quantity),
      marketValue: String(marketValue),
      avgEntry: avgEntryStr,
      costBasis: costBasisStr,
      realizedPnl,
      unrealizedPnl: unrealizedPnlValue,
      lastPrice: String(price),
      quantitySource: "official",
      priceSource,
      basisSource,
      pnlSource,
      rowSource: derived ? "official+derived" : "official_only",
      official: o,
      derived,
      enrichMarketId: o.conditionId ?? derived?.marketId ?? "",
      marketTitle: o.title ?? derived?.marketTitle ?? "Unknown market",
      category: derived?.category ?? null,
      theme: derived?.theme ?? null,
      openedAt: derived?.openedAt ?? null,
      reservedOrderSize: derived?.reservedOrderSize ?? "0",
      reservedOrderValue: derived?.reservedOrderValue ?? "0",
    });
  }

  let derivedOnlyExcluded = 0;
  let closedOfficialExcluded = 0;
  if (openOnly) {
    for (const d of derivedPositions) {
      const k = assetKey(d.assetId);
      if (k && !officialAssetSet.has(k) && !officialAssetSet.has(k.toLowerCase()))
        derivedOnlyExcluded++;
    }
  } else {
    for (const d of derivedPositions) {
      const k = assetKey(d.assetId);
      if (!k) continue;
      if (officialAssetSet.has(k) || officialAssetSet.has(k.toLowerCase())) continue;
      const closed = (d as { syncedMarket?: { status: string | null } | null }).syncedMarket?.status === "closed";
      if (closed) continue;
      const quantity = parseNum(d.size);
      const price = parseNum(d.lastPrice) || parseNum(d.avgEntry) || 0;
      const marketValue = quantity * price;
      const costBasisNum = parseNum(d.costBasis);
      const avgEntryNum = quantity > 0 ? costBasisNum / quantity : 0;
      rows.push({
        assetId: k,
        marketId: d.marketId ?? "",
        conditionId: null,
        funderAddress: d.funderAddress,
        outcome: d.outcome ?? "—",
        side: d.side ?? "LONG",
        size: d.size,
        marketValue: String(marketValue),
        avgEntry: String(avgEntryNum),
        costBasis: String(costBasisNum),
        realizedPnl: d.realizedPnl ?? "0",
        unrealizedPnl: d.unrealizedPnl ?? String(marketValue - costBasisNum),
        lastPrice: d.lastPrice ?? "0",
        quantitySource: "derived",
        priceSource: "derived" as PriceSource,
        basisSource: "derived",
        pnlSource: "derived",
        rowSource: "derived_only",
        official: null,
        derived: d,
        enrichMarketId: d.marketId ?? "",
        marketTitle: d.marketTitle ?? "Unknown market",
        category: d.category ?? null,
        theme: d.theme ?? null,
        openedAt: d.openedAt,
        reservedOrderSize: d.reservedOrderSize ?? "0",
        reservedOrderValue: d.reservedOrderValue ?? "0",
      });
    }
  }

  return {
    rows,
    diagnostics: {
      officialPositionsUsed: officialPositions.length,
      derivedRowsMatched,
      officialOnlyIncluded,
      derivedOnlyExcluded,
      rowsWithEstimatedBasis,
      rowsWithMissingBasis,
      closedOfficialExcluded,
      staleOfficialExcluded,
      excludedStaleOfficialRows,
      rowsWithInvalidDerivedBasis,
      rowsWithSuppressedBasis,
      rowsWithOfficialBasis,
      rowsWithDerivedBasis,
      rowsWithUnavailableBasis,
    },
  };
}
