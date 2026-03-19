/**
 * Portfolio engine: derive open positions from UserFill, map to markets, compute metrics.
 * Read-only; no trading. Persists into DerivedPosition via recompute flow.
 */

import { prisma } from "@/lib/db";
import { classifyCategory, deriveTheme, type MarketCategory } from "./classify";

export interface ResolvedMarket {
  id: string;
  title: string;
  slug: string | null;
  category: string | null;
  endDate: Date | null;
}

/** Canonical conditionId for matching CLOB (0x hex) with Gamma: lowercase, 0x prefix for 64-char hex. */
export function normalizeConditionId(s: string | null | undefined): string {
  if (s == null) return "";
  const t = String(s).trim().toLowerCase();
  if (!t) return "";
  if (t.startsWith("0x")) return t.length === 66 ? t : t;
  if (/^[0-9a-f]{64}$/.test(t)) return "0x" + t;
  return t;
}

/**
 * Resolve a market reference (SyncedMarket.id or conditionId) to market metadata.
 * Tries: (1) by id, (2) by conditionId (normalized for hex). Returns null if not found.
 */
export async function resolveMarketRef(marketRef: string): Promise<ResolvedMarket | null> {
  if (!marketRef?.trim()) return null;
  const ref = marketRef.trim();
  const byId = await prisma.syncedMarket.findUnique({
    where: { id: ref },
    select: { id: true, title: true, slug: true, category: true, endDate: true },
  });
  if (byId) return { id: byId.id, title: byId.title, slug: byId.slug, category: byId.category ?? null, endDate: byId.endDate ?? null };
  const condNorm = normalizeConditionId(ref);
  const byCondition = await prisma.syncedMarket.findFirst({
    where: condNorm ? { OR: [{ conditionId: ref }, { conditionId: condNorm }] } : { conditionId: ref },
    select: { id: true, title: true, slug: true, category: true, endDate: true },
  });
  if (byCondition) return { id: byCondition.id, title: byCondition.title, slug: byCondition.slug, category: byCondition.category ?? null, endDate: byCondition.endDate ?? null };
  return null;
}

export type MarketMatchType = "marketId" | "conditionId" | "assetId";

export interface ResolvedMarketWithMatch {
  market: ResolvedMarket;
  matchedBy: MarketMatchType;
}

/**
 * Resolve position to market metadata for API enrichment. Tries: (1) by marketId as id,
 * (2) by marketId as conditionId, (3) by assetId via SyncedAsset. Returns match type for diagnostics.
 */
export async function resolvePositionToMarket(
  marketId: string,
  assetId: string
): Promise<ResolvedMarketWithMatch | null> {
  if (!marketId?.trim()) return null;
  const ref = marketId.trim();
  const byId = await prisma.syncedMarket.findUnique({
    where: { id: ref },
    select: { id: true, title: true, slug: true, category: true, endDate: true },
  });
  if (byId)
    return {
      market: { id: byId.id, title: byId.title, slug: byId.slug, category: byId.category ?? null, endDate: byId.endDate ?? null },
      matchedBy: "marketId",
    };
  const condNorm = normalizeConditionId(ref);
  const byCondition = await prisma.syncedMarket.findFirst({
    where: condNorm ? { OR: [{ conditionId: ref }, { conditionId: condNorm }] } : { conditionId: ref },
    select: { id: true, title: true, slug: true, category: true, endDate: true },
  });
  if (byCondition)
    return {
      market: {
        id: byCondition.id,
        title: byCondition.title,
        slug: byCondition.slug,
        category: byCondition.category ?? null,
        endDate: byCondition.endDate ?? null,
      },
      matchedBy: "conditionId",
    };
  const assetIdNorm = String(assetId ?? "").trim();
  const byAsset = assetIdNorm
    ? await prisma.syncedAsset.findFirst({
        where: { tokenId: assetIdNorm },
        include: { syncedMarket: { select: { id: true, title: true, slug: true, category: true, endDate: true } } },
      })
    : null;
  if (byAsset?.syncedMarket)
    return {
      market: {
        id: byAsset.syncedMarket.id,
        title: byAsset.syncedMarket.title,
        slug: byAsset.syncedMarket.slug,
        category: byAsset.syncedMarket.category ?? null,
        endDate: byAsset.syncedMarket.endDate ?? null,
      },
      matchedBy: "assetId",
    };
  return null;
}

export interface DerivedPositionRow {
  funderAddress: string;
  /** Raw upstream market reference (from fills; may be conditionId). Kept for traceability. */
  marketId: string;
  /** Canonical internal id (SyncedMarket.id) when resolution succeeded; null if unresolved. */
  syncedMarketId: string | null;
  assetId: string;
  marketTitle: string;
  outcome: string;
  side: string;
  size: string;
  avgEntry: string;
  lastPrice: string;
  costBasis: string;
  /** Current mark-to-market value = netShares * currentMarkPrice (Polymarket wallet "Value"). */
  marketValue: string;
  unrealizedPnl: string;
  realizedPnl: string;
  /** Max payout if outcome wins = netShares * 1.00 (Polymarket wallet "To win"). */
  maxPayout: string;
  reservedOrderSize: string;
  reservedOrderValue: string;
  category: string | null;
  theme: string | null;
  openedAt: Date | null;
}

/** CLOB returns size in raw units (6 decimals). 1 share = 1e6. Normalize to display shares for aggregation. */
const POLYMARKET_SIZE_DECIMALS = 1e6;

/** Minimum net shares to treat as an open long position. Below this we drop the row (no fake NO/dust positions; CSV shows residuals like 0.005–0.008). */
export const OPEN_POSITION_DUST_THRESHOLD = 0.01;

function parseNum(s: string): number {
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convert CLOB size to display shares. CLOB uses 6 decimals (1 share = 1e6).
 * If value is already in display range (< 1e5 or has decimal), use as-is to support both formats.
 * Exported for fills debug endpoint.
 */
export function sizeToShares(rawSize: number, rawStr: string): number {
  const str = String(rawStr ?? "").trim();
  if (!Number.isFinite(rawSize)) return 0;
  if (rawSize >= 1e5 && !str.includes(".")) return rawSize / POLYMARKET_SIZE_DECIMALS;
  return rawSize;
}

function toStr(n: number): string {
  return String(Number.isFinite(n) ? n : 0);
}

/** Resolution counts for canonical market linkage (recompute/backfill diagnostics). */
export interface ResolutionDiagnostics {
  total: number;
  resolvedByMarketId: number;
  resolvedByConditionId: number;
  resolvedByAssetId: number;
  unresolved: number;
}

/** Source of token current price used for valuation (priority order). */
export type ValuationPriceSource =
  | "MarketPriceSnapshot"
  | "SyncedMarketRaw"
  | "LastFillOrOrder"
  | "AvgEntry";

/** Per-position valuation debug (for comparison with Polymarket wallet). */
export interface ValuationDebugRow {
  marketTitle: string;
  assetId: string;
  side: string;
  shares: number;
  avgEntry: number;
  priceSourceUsed: ValuationPriceSource;
  currentPriceUsed: number;
  currentValueComputed: number;
  costBasis: number;
  maxPayout: number;
  unrealizedPnl: number;
}

/**
 * Aggregate fills by assetId: net size, cost basis (for realized), weighted avg entry.
 * Resolves each position to SyncedMarket when possible; returns rows and resolution diagnostics.
 * currentValue = netShares * tokenCurrentPrice where tokenCurrentPrice is resolved in priority order:
 * 1) MarketPriceSnapshot (latest per assetId), 2) SyncedMarket.raw outcomePrices[outcomeIndex], 3) last fill/order price, 4) avgEntry.
 * Size: CLOB returns fill/order size in 6-decimal units (1 share = 1e6); we normalize via sizeToShares() so DerivedPosition.size matches wallet share counts.
 * Unresolved positions have syncedMarketId = null (no ambiguous ids stored).
 */
export async function derivePositionsFromFills(funderAddress: string): Promise<{
  rows: DerivedPositionRow[];
  diagnostics: ResolutionDiagnostics;
  valuationDebug: ValuationDebugRow[];
}> {
  const fills = await prisma.userFill.findMany({
    where: { funderAddress },
    orderBy: [
      { matchTime: "asc" },
      { tradeId: "asc" },
    ],
  });

  const byAsset = new Map<
    string,
    {
      size: number;
      costBasisNet: number; // net cash spent (signed)
      marketId: string;
      outcome: string;
      firstAt: Date | null;
      lastAt: Date | null;
    }
  >();

  const normalizeAssetId = (id: string) => String(id ?? "").trim();
  const seenFillSignature = new Set<string>();
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
        size: sizeShares,
        costBasisNet: cost,
        marketId: (f.market ?? "").trim(),
        outcome: f.outcome ?? "—",
        firstAt: matchTime,
        lastAt: matchTime,
      });
    } else {
      existing.size += sizeShares;
      existing.costBasisNet += cost;
      if (matchTime) {
        if (!existing.firstAt || matchTime < existing.firstAt) existing.firstAt = matchTime;
        if (!existing.lastAt || matchTime > existing.lastAt) existing.lastAt = matchTime;
      }
    }
  }

  // Only open long positions: net shares > dust. Do not create rows for negative-net or near-zero (avoids fake NO positions).
  const assetIds = Array.from(byAsset.keys()).filter(
    (id) => byAsset.get(id)!.size > OPEN_POSITION_DUST_THRESHOLD
  );
  const assetMeta = new Map<
    string,
    { marketId: string; marketTitle: string; outcome: string; category?: string | null; matchedBy: MarketMatchType; outcomeIndex?: number | null; rawJson?: string | null }
  >();

  const assets = await prisma.syncedAsset.findMany({
    where: { tokenId: { in: assetIds } },
    include: { syncedMarket: { select: { id: true, title: true, raw: true } } },
  });
  for (const a of assets) {
    const tokenKey = normalizeAssetId(a.tokenId);
    assetMeta.set(tokenKey, {
      marketId: a.syncedMarket.id,
      marketTitle: a.syncedMarket.title,
      outcome: a.outcome,
      matchedBy: "assetId",
      outcomeIndex: a.outcomeIndex ?? null,
      rawJson: a.syncedMarket.raw ?? null,
    });
  }

  const missingMetaAssetIds = assetIds.filter((id) => !assetMeta.has(id));
  for (const assetId of missingMetaAssetIds) {
    const agg = byAsset.get(assetId)!;
    const resolvedWithMatch = await resolvePositionToMarket(agg.marketId, assetId);
    if (resolvedWithMatch) {
      assetMeta.set(assetId, {
        marketId: resolvedWithMatch.market.id,
        marketTitle: resolvedWithMatch.market.title,
        outcome: "—",
        category: resolvedWithMatch.market.category ?? null,
        matchedBy: resolvedWithMatch.matchedBy,
      });
    }
  }

  // Token-level current price for valuation (must match Polymarket wallet "Value" = shares × current price).
  // Before fix: we used last fill price or avgEntry as "lastPrice", inflating currentValue (e.g. 725×0.59=$427 instead of 725×0.25=$181).
  // After: 1) MarketPriceSnapshot (latest per assetId), 2) SyncedMarket.raw outcomePrices[outcomeIndex], 3) last fill/order, 4) avgEntry.
  const snapshotRows =
    assetIds.length > 0
      ? await prisma.marketPriceSnapshot.findMany({
          where: { assetId: { in: assetIds } },
          orderBy: { capturedAt: "desc" },
        })
      : [];
  const priceByAssetFromSnapshot = new Map<string, number>();
  for (const s of snapshotRows) {
    const key = normalizeAssetId(s.assetId);
    if (!priceByAssetFromSnapshot.has(key)) priceByAssetFromSnapshot.set(key, parseNum(s.price));
  }

  const rawPriceByAsset = new Map<string, number>();
  for (const assetId of assetIds) {
    const meta = assetMeta.get(assetId);
    if (!meta?.rawJson || meta.outcomeIndex == null) continue;
    try {
      const raw = JSON.parse(meta.rawJson) as Record<string, unknown>;
      const prices = raw.outcomePrices ?? raw.prices;
      const arr = Array.isArray(prices) ? prices : typeof prices === "string" ? (JSON.parse(prices) as unknown[]) : [];
      const p = arr[meta.outcomeIndex];
      if (p != null) rawPriceByAsset.set(assetId, parseNum(String(p)));
    } catch {
      // ignore
    }
  }

  const openOrders = await prisma.userOrder.findMany({
    where: { funderAddress },
  });
  const reservedByAsset = new Map<string, { size: number; value: number }>();
  for (const o of openOrders) {
    const origShares = sizeToShares(parseNum(o.originalSize), o.originalSize);
    const matchedShares = sizeToShares(parseNum(o.sizeMatched), o.sizeMatched);
    const rem = origShares - matchedShares;
    if (rem <= 0) continue;
    const price = parseNum(o.price);
    const key = normalizeAssetId(o.assetId);
    const existing = reservedByAsset.get(key) ?? { size: 0, value: 0 };
    existing.size += rem;
    existing.value += rem * price;
    reservedByAsset.set(key, existing);
  }

  const lastPriceByAsset = new Map<string, number>();
  for (const f of fills) {
    const p = parseNum(f.price);
    const key = normalizeAssetId(f.assetId);
    const cur = lastPriceByAsset.get(key);
    if (cur === undefined || p > 0) lastPriceByAsset.set(key, p);
  }
  for (const o of openOrders) {
    const p = parseNum(o.price);
    const key = normalizeAssetId(o.assetId);
    const cur = lastPriceByAsset.get(key);
    if (cur === undefined || p > 0) lastPriceByAsset.set(key, p);
  }

  const rows: DerivedPositionRow[] = [];
  const valuationDebug: ValuationDebugRow[] = [];
  const diagnostics: ResolutionDiagnostics = {
    total: 0,
    resolvedByMarketId: 0,
    resolvedByConditionId: 0,
    resolvedByAssetId: 0,
    unresolved: 0,
  };

  for (const assetId of assetIds) {
    const agg = byAsset.get(assetId)!;
    if (agg.size <= OPEN_POSITION_DUST_THRESHOLD) continue;

    const meta = assetMeta.get(assetId);
    const marketId = meta?.marketId ?? agg.marketId;
    const marketTitle = meta?.marketTitle ?? "Unknown market";
    const outcome = meta?.outcome ?? agg.outcome;
    const side = outcome.toLowerCase() === "yes" ? "YES" : outcome.toLowerCase() === "no" ? "NO" : "LONG";
    const size = agg.size;
    const costBasisAbs = Math.abs(agg.costBasisNet);
    const avgEntry = size > 0 ? costBasisAbs / size : 0;
    const lastFillOrOrderPrice = lastPriceByAsset.get(assetId);

    const snapshotPrice = priceByAssetFromSnapshot.get(assetId);
    const rawPrice = rawPriceByAsset.get(assetId);
    let tokenCurrentPrice: number;
    let priceSource: ValuationPriceSource;
    if (snapshotPrice != null && Number.isFinite(snapshotPrice)) {
      tokenCurrentPrice = snapshotPrice;
      priceSource = "MarketPriceSnapshot";
    } else if (rawPrice != null && Number.isFinite(rawPrice)) {
      tokenCurrentPrice = rawPrice;
      priceSource = "SyncedMarketRaw";
    } else if (lastFillOrOrderPrice != null && Number.isFinite(lastFillOrOrderPrice)) {
      tokenCurrentPrice = lastFillOrOrderPrice;
      priceSource = "LastFillOrOrder";
    } else {
      tokenCurrentPrice = avgEntry;
      priceSource = "AvgEntry";
    }

    const costBasis = costBasisAbs;
    const currentValue = size * tokenCurrentPrice;
    const unrealizedPnl = currentValue - costBasis;
    const maxPayout = size * 1;
    const reserved = reservedByAsset.get(assetId) ?? { size: 0, value: 0 };

    const category = (meta?.category ?? classifyCategory(marketTitle)) as MarketCategory;
    const theme = deriveTheme(marketTitle, category);

    // Canonical id only when resolved; unresolved stay null (no ambiguous ids).
    const syncedMarketId = meta?.marketId ?? null;

    if (meta?.matchedBy === "marketId") diagnostics.resolvedByMarketId++;
    else if (meta?.matchedBy === "conditionId") diagnostics.resolvedByConditionId++;
    else if (meta?.matchedBy === "assetId") diagnostics.resolvedByAssetId++;
    else diagnostics.unresolved++;
    diagnostics.total++;

    rows.push({
      funderAddress,
      marketId,
      syncedMarketId,
      assetId,
      marketTitle,
      outcome,
      side,
      size: toStr(size),
      avgEntry: toStr(avgEntry),
      lastPrice: toStr(tokenCurrentPrice),
      costBasis: toStr(costBasis),
      marketValue: toStr(currentValue),
      unrealizedPnl: toStr(unrealizedPnl),
      maxPayout: toStr(maxPayout),
      realizedPnl: "0",
      reservedOrderSize: toStr(reserved.size),
      reservedOrderValue: toStr(reserved.value),
      category,
      theme,
      openedAt: agg.firstAt,
    });

    valuationDebug.push({
      marketTitle,
      assetId,
      side,
      shares: size,
      avgEntry,
      priceSourceUsed: priceSource,
      currentPriceUsed: tokenCurrentPrice,
      currentValueComputed: currentValue,
      costBasis,
      maxPayout,
      unrealizedPnl,
    });
  }

  return { rows, diagnostics, valuationDebug };
}

/** Backfill result: how many positions were updated and resolution counts. */
export interface BackfillSyncedMarketIdsResult {
  funderAddress: string;
  processed: number;
  updated: number;
  resolvedByMarketId: number;
  resolvedByConditionId: number;
  resolvedByAssetId: number;
  stillUnresolved: number;
  errors: string[];
}

/**
 * Backfill syncedMarketId on existing DerivedPosition rows where it is null.
 * Uses resolvePositionToMarket; only sets syncedMarketId when resolution succeeds (unresolved stay null).
 */
export async function backfillSyncedMarketIds(funderAddress: string): Promise<BackfillSyncedMarketIdsResult> {
  const funder = funderAddress.trim().toLowerCase();
  const errors: string[] = [];
  const result: BackfillSyncedMarketIdsResult = {
    funderAddress: funder,
    processed: 0,
    updated: 0,
    resolvedByMarketId: 0,
    resolvedByConditionId: 0,
    resolvedByAssetId: 0,
    stillUnresolved: 0,
    errors: [],
  };

  const positions = await prisma.derivedPosition.findMany({
    where: { funderAddress: funder, syncedMarketId: null },
  });
  result.processed = positions.length;

  for (const p of positions) {
    const resolved = await resolvePositionToMarket(p.marketId, p.assetId);
    if (!resolved) {
      result.stillUnresolved++;
      continue;
    }
    if (resolved.matchedBy === "marketId") result.resolvedByMarketId++;
    else if (resolved.matchedBy === "conditionId") result.resolvedByConditionId++;
    else if (resolved.matchedBy === "assetId") result.resolvedByAssetId++;

    try {
      await prisma.derivedPosition.update({
        where: { funderAddress_assetId: { funderAddress: funder, assetId: p.assetId } },
        data: { syncedMarketId: resolved.market.id },
      });
      result.updated++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : `Update failed for ${p.assetId}`);
    }
  }

  result.errors = errors;
  return result;
}
