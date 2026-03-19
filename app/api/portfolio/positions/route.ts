import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import {
  buildCanonicalPositionView,
} from "@/lib/portfolio/canonical-position-view";
import { toPositionViewFromCanonical } from "@/lib/portfolio/position-display";
import { enrichPositionsBatch, type EnrichPositionsBatchInput } from "@/lib/portfolio/enrich-positions";
import { getResolutionCounts } from "@/lib/portfolio/resolution-classifier";
import { normalizeFreshnessForApi } from "@/lib/portfolio/freshness-contract";
import { getLiveOfficialPositions, getSourceOfTruth } from "@/lib/portfolio/live-portfolio-service";
import { buildOpenPositionsFromOfficial } from "@/lib/portfolio/open-positions-from-official";

export const dynamic = "force-dynamic";

function parseNum(s: string): number {
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET /api/portfolio/positions
 * Returns derived positions for the connected funder with position decision snapshot and market enrichment.
 * Query: ?canonical=true returns positions as canonical view objects (market, token, economics, timing, quality).
 *
 * Position contract (explicit, no overloaded fields):
 * - syncedMarketId: canonical internal SyncedMarket.id, null if unresolved
 * - rawMarketRef: raw upstream market reference (CLOB/condition id from fills), null if unknown
 * - assetId, marketSlug, marketTitle, category, theme: metadata (slug/category/theme null when unresolved)
 * - resolutionSource: "marketId" | "conditionId" | "assetId" | "unresolved"
 * - quality: { isResolved, matchedBy, hasCompleteDisplayMetadata, marketEndDatePassed, warnings } (legacy mode); full quality in canonical
 * - marketId: backward-compat alias only (syncedMarketId ?? rawMarketRef); prefer syncedMarketId/rawMarketRef
 *
 * Diagnostics (stable):
 * - totalPositions, resolvedPositions, unresolvedPositions (canonical)
 * - matchedByMarketId, matchedByConditionId, matchedByAssetId
 * - total, resolved, resolvedBy* for compatibility
 */
export async function GET(request: Request) {
  try {
    const funder = await getFunderForRecompute();
    if (!funder) {
      return NextResponse.json(
        { error: "No funder address. Connect wallet and save connection." },
        { status: 400 }
      );
    }

    const url = request.url ? new URL(request.url) : null;
    const canonical = url?.searchParams.get("canonical") === "true";
    const openOnly = url?.searchParams.get("openOnly") !== "false";

    const [positionsRaw, liveOfficial] = await Promise.all([
      prisma.derivedPosition.findMany({
        where: { funderAddress: funder },
        include: {
          decisionSnapshots: true,
          positionThesis: true,
          syncedMarket: { select: { status: true } },
        },
      }),
      getLiveOfficialPositions(funder),
    ]);
    const officialResult = liveOfficial.result;
    const fetchMetadata = liveOfficial.metadata;
    const useOfficialAsOpenSet = fetchMetadata.success;
    const officialFetchFailed = !fetchMetadata.success;

    type DecisionSnapshot = NonNullable<(typeof positionsRaw)[0]["decisionSnapshots"]>;
    const decisionByAsset = new Map<string, DecisionSnapshot>();
    for (const p of positionsRaw) {
      const d = p.decisionSnapshots ?? null;
      if (d) decisionByAsset.set(p.assetId.trim(), d);
    }

    let mergedRows: Awaited<ReturnType<typeof buildOpenPositionsFromOfficial>>["rows"] = [];
    let mergeDiagnostics: Awaited<ReturnType<typeof buildOpenPositionsFromOfficial>>["diagnostics"] = {
      officialPositionsUsed: 0,
      derivedRowsMatched: 0,
      officialOnlyIncluded: 0,
      derivedOnlyExcluded: 0,
      rowsWithEstimatedBasis: 0,
      rowsWithMissingBasis: 0,
      closedOfficialExcluded: 0,
      staleOfficialExcluded: 0,
      excludedStaleOfficialRows: [],
      rowsWithInvalidDerivedBasis: 0,
      rowsWithSuppressedBasis: 0,
      rowsWithOfficialBasis: 0,
      rowsWithDerivedBasis: 0,
      rowsWithUnavailableBasis: 0,
    };

    if (useOfficialAsOpenSet) {
      const merged = buildOpenPositionsFromOfficial(
        officialResult.positions,
        positionsRaw,
        funder,
        openOnly
      );
      mergedRows = merged.rows;
      mergeDiagnostics = merged.diagnostics;
    }

    let positionsToUse = useOfficialAsOpenSet
      ? mergedRows
      : (() => {
          const positions = [...positionsRaw];
          positions.sort((a, b) => parseFloat(b.marketValue) - parseFloat(a.marketValue));
          const openIndices = openOnly
            ? positions.map((_, i) => i).filter((i) => (positions[i].syncedMarket?.status ?? "") !== "closed")
            : positions.map((_, i) => i);
          return openIndices.map((i) => positions[i]);
        })();

    let enrichInput: EnrichPositionsBatchInput[];
    if (useOfficialAsOpenSet) {
      enrichInput = mergedRows.map((r) => ({
        marketId: r.enrichMarketId,
        assetId: r.assetId,
        marketTitle: r.marketTitle,
        category: r.category,
        theme: r.theme,
      }));
    } else {
      const derivedList: (typeof positionsRaw) = positionsToUse as unknown as (typeof positionsRaw);
      enrichInput = derivedList.map((p) => ({
        marketId: p.marketId ?? "",
        assetId: p.assetId ?? "",
        marketTitle: p.marketTitle ?? null,
        category: p.category ?? null,
        theme: p.theme ?? null,
      }));
    }

    const { enriched, diagnostics } = await enrichPositionsBatch(enrichInput);
    let enrichedToUse = enriched;

    // In official-open mode with openOnly=true, exclude closed markets (by status/endDate) from the open set
    // and collect diagnostics for excluded official rows.
    let closedOfficialExcluded = 0;
    const excludedOfficialRows: {
      assetId: string;
      marketTitle: string | null;
      marketSlug: string | null;
      status: string | null;
      endDate: string | null;
      excludedReason: "status_closed" | "endDate_past";
      quantitySource: string;
      rowSource: string;
    }[] = [];
    if (useOfficialAsOpenSet && openOnly) {
      const now = Date.now();
      type PositionRow = (typeof positionsToUse)[number];
      type EnrichedRow = (typeof enrichedToUse)[number];
      const filtered: PositionRow[] = [];
      const filteredEnriched: EnrichedRow[] = [];
      for (let i = 0; i < positionsToUse.length; i++) {
        const e = enrichedToUse[i];
        const statusRaw = e.status ?? null;
        const status = (statusRaw ?? "").toLowerCase();
        const endIso = e.endDate ? (typeof e.endDate === "string" ? e.endDate : e.endDate.toISOString()) : null;
        const end = endIso ? new Date(endIso).getTime() : null;
        const isStatusClosed = status === "closed";
        const isEndPast = end != null && Number.isFinite(end) && end <= now;
        const isClosed = isStatusClosed || isEndPast;
        if (isClosed) {
          closedOfficialExcluded++;
          if (excludedOfficialRows.length < 20 && useOfficialAsOpenSet) {
            const row = positionsToUse[i] as MergedRow;
            excludedOfficialRows.push({
              assetId: row.assetId,
              marketTitle: row.marketTitle ?? null,
              marketSlug: e.marketSlug ?? null,
              status: statusRaw,
              endDate: endIso,
              excludedReason: isStatusClosed ? "status_closed" : "endDate_past",
              quantitySource: row.quantitySource,
              rowSource: row.rowSource,
            });
          }
          continue;
        }
        filtered.push(positionsToUse[i]);
        filteredEnriched.push(e);
      }
      positionsToUse = filtered as typeof positionsToUse;
      enrichedToUse = filteredEnriched;
    }

    const resolvedCount = diagnostics.matchedByMarketId + diagnostics.matchedByConditionId + diagnostics.matchedByAssetId;
    const missingDecisionCount = useOfficialAsOpenSet
      ? mergedRows.filter((r) => !decisionByAsset.has(r.assetId)).length
      : positionsToUse.filter((p: { assetId: string }) => !decisionByAsset.has(p.assetId)).length;

    let resolvedNotionalPct: number | null = null;
    let unresolvedNotionalPct: number | null = null;
    let resolvedNotional = 0;
    let unresolvedNotional = 0;
    for (let i = 0; i < positionsToUse.length; i++) {
      const mv = useOfficialAsOpenSet
        ? parseFloat((positionsToUse[i] as (typeof mergedRows)[0]).marketValue)
        : parseFloat((positionsToUse[i] as (typeof positionsRaw)[0]).marketValue);
      if (Number.isFinite(mv)) {
        if (enrichedToUse[i].matchedBy != null) resolvedNotional += mv;
        else unresolvedNotional += mv;
      }
    }
    const totalNotional = resolvedNotional + unresolvedNotional;
    if (totalNotional > 0) {
      resolvedNotionalPct = (resolvedNotional / totalNotional) * 100;
      unresolvedNotionalPct = (unresolvedNotional / totalNotional) * 100;
    }

  type MergedRow = (typeof mergedRows)[0];
  type DerivedRow = (typeof positionsRaw)[0];
  const isMerged = (p: MergedRow | DerivedRow): p is MergedRow => useOfficialAsOpenSet;
  const getSize = (p: MergedRow | DerivedRow) => (isMerged(p) ? p.size : p.size);
  const getMarketValue = (p: MergedRow | DerivedRow) => (isMerged(p) ? p.marketValue : p.marketValue);
  const getAvgEntry = (p: MergedRow | DerivedRow) => (isMerged(p) ? p.avgEntry : p.avgEntry);
  const getCostBasis = (p: MergedRow | DerivedRow) => (isMerged(p) ? (p as MergedRow).costBasis : (p as DerivedRow).costBasis);
  const getRealizedPnl = (p: MergedRow | DerivedRow) => (isMerged(p) ? p.realizedPnl : p.realizedPnl);
  const getUnrealizedPnl = (p: MergedRow | DerivedRow) => (isMerged(p) ? p.unrealizedPnl : p.unrealizedPnl);
  const getLastPrice = (p: MergedRow | DerivedRow) => (isMerged(p) ? p.lastPrice : p.lastPrice);
  const getDecision = (p: MergedRow | DerivedRow) =>
    decisionByAsset.get(p.assetId.trim()) ?? null;
  type ThesisShape = { id: string; entryThesis: string | null; currentThesisStatus: string; exitReason: string | null; notes: string | null; updatedAt: Date } | null;
  const getThesis = (p: MergedRow | DerivedRow): ThesisShape => {
    if (isMerged(p)) {
      const d = (p as MergedRow).derived as unknown as { positionThesis?: ThesisShape } | null;
      return d?.positionThesis ?? null;
    }
    const withThesis = p as unknown as { positionThesis?: ThesisShape };
    return withThesis.positionThesis ?? null;
  };
  const getQuantitySource = (p: MergedRow | DerivedRow) => (isMerged(p) ? (p as MergedRow).quantitySource : "derived" as const);
  const getPriceSource = (p: MergedRow | DerivedRow) => (isMerged(p) ? (p as MergedRow).priceSource : "derived" as const);
  const getBasisSource = (p: MergedRow | DerivedRow) => (isMerged(p) ? (p as MergedRow).basisSource : "derived" as const);
  const getPnlSource = (p: MergedRow | DerivedRow) => (isMerged(p) ? (p as MergedRow).pnlSource : "derived" as const);
  const getRowSource = (p: MergedRow | DerivedRow) => (isMerged(p) ? (p as MergedRow).rowSource : "derived_only" as const);

  if (canonical) {
    const resolvedMarketIds = Array.from(new Set(enrichedToUse.map((e) => e.marketId).filter(Boolean)));
    const newsCountByMarket = new Map<string, number>();
    if (resolvedMarketIds.length > 0) {
      const links = await prisma.marketNewsLink.groupBy({
        by: ["marketId"],
        where: { marketId: { in: resolvedMarketIds } },
        _count: { id: true },
      });
      links.forEach((r) => newsCountByMarket.set(r.marketId, r._count.id));
    }

    const canonicalPositions = positionsToUse.map((p, i) => {
      const meta = enrichedToUse[i];
      const row = p as MergedRow | DerivedRow;
      const decision = getDecision(row);
      const view = buildCanonicalPositionView(
        {
          funderAddress: row.funderAddress,
          marketId: row.marketId ?? "",
          assetId: row.assetId,
          marketTitle: row.marketTitle ?? "Unknown market",
          outcome: row.outcome,
          side: row.side,
          size: getSize(row),
          avgEntry: getAvgEntry(row),
          lastPrice: getLastPrice(row),
          costBasis: getCostBasis(row),
          marketValue: getMarketValue(row),
          unrealizedPnl: getUnrealizedPnl(row),
          realizedPnl: getRealizedPnl(row),
          reservedOrderSize: row.reservedOrderSize ?? "0",
          reservedOrderValue: row.reservedOrderValue ?? "0",
          category: row.category ?? null,
          theme: row.theme ?? null,
          openedAt: row.openedAt,
        },
        meta,
        { firstFillAt: row.openedAt }
      );
      const marketIdForNews = view.market.id ?? row.marketId;
      const newsLinkCount = marketIdForNews ? newsCountByMarket.get(marketIdForNews) ?? 0 : 0;

      const thesis = getThesis(row);
      const canonicalItem = {
        ...view,
        syncedMarketId: view.market.id,
        rawMarketRef: row.marketId ?? null,
        resolutionSource: view.quality.resolutionSource,
      };
      const positionView = toPositionViewFromCanonical({
        ...canonicalItem,
        timing: {
          ...view.timing,
          hoursToResolution: view.timing.hoursToResolution,
          lastSyncedAt: view.timing.lastSyncedAt,
        },
        quality: view.quality,
      });
      const displayedQuantity = parseNum(getSize(row));
      const rawSuggested = decision ? parseNum(decision.suggestedExitSize) : 0;
      const cappedSuggestedExitSize =
        decision && displayedQuantity >= 0
          ? String(Math.max(0, Math.min(displayedQuantity, rawSuggested)).toFixed(4))
          : decision?.suggestedExitSize;
      return {
        ...canonicalItem,
        quantitySource: getQuantitySource(row),
        priceSource: getPriceSource(row),
        basisSource: getBasisSource(row),
        pnlSource: getPnlSource(row),
        rowSource: getRowSource(row),
        positionView,
        decision: decision
          ? {
              decisionState: decision.decisionState,
              confidence: decision.confidence,
              suggestedExitSize: cappedSuggestedExitSize ?? decision.suggestedExitSize,
              reasoningJson: decision.reasoningJson,
            }
          : null,
        newsLinkCount,
        thesis: thesis
          ? {
              id: thesis.id,
              entryThesis: thesis.entryThesis,
              currentThesisStatus: thesis.currentThesisStatus,
              exitReason: thesis.exitReason,
              notes: thesis.notes,
              updatedAt: thesis.updatedAt.toISOString(),
            }
          : null,
      };
    });

    const { unresolvedCount: canonicalUnresolved, resolvedCount: canonicalResolved } = getResolutionCounts(
      canonicalPositions.map((p) => p.quality)
    );
    const posFresh = normalizeFreshnessForApi(fetchMetadata.fromCache, fetchMetadata.freshnessMs);
    const sourceOfTruth = getSourceOfTruth(fetchMetadata, officialResult.positions.length);
    return NextResponse.json({
      funderAddress: funder,
      sourceOfTruth,
      asOf: fetchMetadata.asOf.toISOString(),
      freshnessMs: posFresh.freshnessMs,
      freshnessState: posFresh.freshnessState,
      positions: canonicalPositions,
      diagnostics: {
        officialFetchFailed,
        officialFetchStatus: fetchMetadata.status,
        officialFetchError: fetchMetadata.error ?? undefined,
        totalPositions: positionsToUse.length,
        openPositionsCount: positionsToUse.length,
        closedExcluded: useOfficialAsOpenSet ? closedOfficialExcluded : positionsRaw.length - positionsToUse.length,
        resolvedPositions: canonicalResolved,
        unresolvedPositions: canonicalUnresolved,
        matchedByMarketId: diagnostics.matchedByMarketId,
        matchedByConditionId: diagnostics.matchedByConditionId,
        matchedByAssetId: diagnostics.matchedByAssetId,
        missingDecisionCount,
        resolvedNotionalPct,
        unresolvedNotionalPct,
        syncedTokenCount: diagnostics.syncedTokenCount,
        sampleUnresolvedIdentifiers: diagnostics.sampleUnresolvedIdentifiers,
        officialPositionsUsed: mergeDiagnostics.officialPositionsUsed,
        derivedRowsMatched: mergeDiagnostics.derivedRowsMatched,
        officialOnlyIncluded: mergeDiagnostics.officialOnlyIncluded,
        derivedOnlyExcluded: mergeDiagnostics.derivedOnlyExcluded,
        rowsWithEstimatedBasis: mergeDiagnostics.rowsWithEstimatedBasis,
        rowsWithMissingBasis: mergeDiagnostics.rowsWithMissingBasis,
        closedOfficialExcluded,
        staleOfficialExcluded: mergeDiagnostics.staleOfficialExcluded,
        excludedStaleOfficialRows: mergeDiagnostics.excludedStaleOfficialRows,
        rowsWithInvalidDerivedBasis: mergeDiagnostics.rowsWithInvalidDerivedBasis,
        rowsWithSuppressedBasis: mergeDiagnostics.rowsWithSuppressedBasis,
        rowsWithOfficialBasis: mergeDiagnostics.rowsWithOfficialBasis,
        rowsWithDerivedBasis: mergeDiagnostics.rowsWithDerivedBasis,
        rowsWithUnavailableBasis: mergeDiagnostics.rowsWithUnavailableBasis,
        excludedOfficialRows,
        total: positionsToUse.length,
        resolved: canonicalResolved,
        resolvedByMarketId: diagnostics.matchedByMarketId,
        resolvedByConditionId: diagnostics.matchedByConditionId,
        resolvedByAssetId: diagnostics.matchedByAssetId,
      },
    });
  }

  const positionList = positionsToUse.map((p, i) => {
    const row = p as MergedRow | DerivedRow;
    const decision = getDecision(row);
    const meta = enrichedToUse[i];
    const syncedMarketId = meta?.matchedBy != null ? meta.marketId : null;
    const rawMarketRef = row.marketId?.trim() || null;
    const resolutionSource = meta?.matchedBy ?? "unresolved";
    const isResolved = meta?.matchedBy != null;
    const endDateStr = typeof meta?.endDate === "string" ? meta.endDate : meta?.endDate?.toISOString?.() ?? null;
    const marketEndDatePassed =
      endDateStr != null && endDateStr.trim() !== "" && new Date(endDateStr).getTime() <= Date.now();
    const hasCanonicalId = isResolved && (meta?.marketId?.trim() ?? "") !== "";
    const hasTitle = ((meta?.marketTitle ?? row.marketTitle) ?? "").trim() !== "";
    const hasSlug = (meta?.marketSlug ?? "").trim() !== "";
    const hasCategory = ((meta?.category ?? row.category) ?? "").trim() !== "";
    const hasTheme = ((meta?.theme ?? row.theme) ?? "").trim() !== "";
    const hasEndDate = endDateStr != null && endDateStr.trim() !== "";
    const hasCompleteDisplayMetadata =
      !!hasCanonicalId && !!hasTitle && !!hasSlug && !!hasCategory && !!hasTheme && !!hasEndDate;
    const legacyWarnings: string[] = [];
    if (!isResolved) legacyWarnings.push("Market not resolved in catalog");
    else {
      if (!hasSlug) legacyWarnings.push("Market slug missing.");
      if (!hasCategory) legacyWarnings.push("Category missing.");
      if (!hasTheme) legacyWarnings.push("Theme missing.");
      if (!hasEndDate) legacyWarnings.push("End date missing.");
    }

    return {
      id: `${row.funderAddress}-${row.assetId}`,
      syncedMarketId,
      rawMarketRef,
      assetId: row.assetId,
      marketSlug: meta?.marketSlug ?? null,
      marketTitle: meta?.marketTitle ?? row.marketTitle ?? null,
      category: meta?.category ?? row.category ?? null,
      theme: meta?.theme ?? row.theme ?? null,
      resolutionSource,
      quantitySource: getQuantitySource(row),
      priceSource: getPriceSource(row),
      basisSource: getBasisSource(row),
      pnlSource: getPnlSource(row),
      rowSource: getRowSource(row),
      quality: {
        isResolved,
        matchedBy: meta?.matchedBy ?? null,
        hasCompleteDisplayMetadata,
        marketEndDatePassed,
        warnings: legacyWarnings,
      },
      outcome: row.outcome,
      side: row.side,
      size: getSize(row),
      avgEntry: getAvgEntry(row),
      lastPrice: getLastPrice(row),
      costBasis: getCostBasis(row),
      marketValue: getMarketValue(row),
      unrealizedPnl: getUnrealizedPnl(row),
      realizedPnl: getRealizedPnl(row),
      reservedOrderSize: row.reservedOrderSize ?? "0",
      reservedOrderValue: row.reservedOrderValue ?? "0",
      endDate: meta?.endDate ?? null,
      openedAt: row.openedAt?.toISOString() ?? null,
      decision: (() => {
        if (!decision) return null;
        const displayedQty = parseNum(getSize(row));
        const raw = parseNum(decision.suggestedExitSize);
        const capped = displayedQty >= 0 ? Math.max(0, Math.min(displayedQty, raw)) : raw;
        return {
          decisionState: decision.decisionState,
          confidence: decision.confidence,
          suggestedExitSize: String(capped.toFixed(4)),
          reasoningJson: decision.reasoningJson,
        };
      })(),
      marketId: syncedMarketId ?? rawMarketRef ?? null,
    };
  });

  const { unresolvedCount: legacyUnresolved, resolvedCount: legacyResolved } = getResolutionCounts(
    positionList.map((p) => p.quality)
  );
  const posFresh = normalizeFreshnessForApi(fetchMetadata.fromCache, fetchMetadata.freshnessMs);
  const sourceOfTruth = getSourceOfTruth(fetchMetadata, officialResult.positions.length);
  return NextResponse.json({
    funderAddress: funder,
    sourceOfTruth,
    asOf: fetchMetadata.asOf.toISOString(),
    freshnessMs: posFresh.freshnessMs,
    freshnessState: posFresh.freshnessState,
    positions: positionList,
    diagnostics: {
      officialFetchFailed,
      officialFetchStatus: fetchMetadata.status,
      officialFetchError: fetchMetadata.error ?? undefined,
      totalPositions: positionsToUse.length,
      openPositionsCount: positionsToUse.length,
      closedExcluded: useOfficialAsOpenSet ? closedOfficialExcluded : positionsRaw.length - positionsToUse.length,
      resolvedPositions: legacyResolved,
      unresolvedPositions: legacyUnresolved,
      matchedByMarketId: diagnostics.matchedByMarketId,
      matchedByConditionId: diagnostics.matchedByConditionId,
      matchedByAssetId: diagnostics.matchedByAssetId,
      missingDecisionCount,
      resolvedNotionalPct,
      unresolvedNotionalPct,
      syncedTokenCount: diagnostics.syncedTokenCount,
      sampleUnresolvedIdentifiers: diagnostics.sampleUnresolvedIdentifiers,
      officialPositionsUsed: mergeDiagnostics.officialPositionsUsed,
      derivedRowsMatched: mergeDiagnostics.derivedRowsMatched,
      officialOnlyIncluded: mergeDiagnostics.officialOnlyIncluded,
      derivedOnlyExcluded: mergeDiagnostics.derivedOnlyExcluded,
      rowsWithEstimatedBasis: mergeDiagnostics.rowsWithEstimatedBasis,
      rowsWithMissingBasis: mergeDiagnostics.rowsWithMissingBasis,
      closedOfficialExcluded,
      staleOfficialExcluded: mergeDiagnostics.staleOfficialExcluded,
      excludedStaleOfficialRows: mergeDiagnostics.excludedStaleOfficialRows,
      rowsWithInvalidDerivedBasis: mergeDiagnostics.rowsWithInvalidDerivedBasis,
      rowsWithSuppressedBasis: mergeDiagnostics.rowsWithSuppressedBasis,
      rowsWithOfficialBasis: mergeDiagnostics.rowsWithOfficialBasis,
      rowsWithDerivedBasis: mergeDiagnostics.rowsWithDerivedBasis,
      rowsWithUnavailableBasis: mergeDiagnostics.rowsWithUnavailableBasis,
      excludedOfficialRows,
      total: positionsToUse.length,
      resolved: legacyResolved,
      resolvedByMarketId: diagnostics.matchedByMarketId,
      resolvedByConditionId: diagnostics.matchedByConditionId,
      resolvedByAssetId: diagnostics.matchedByAssetId,
    },
  });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[GET /api/portfolio/positions]", message, stack);
    const canonicalParam = request.url ? new URL(request.url).searchParams.get("canonical") === "true" : false;
    return NextResponse.json(
      {
        error: "Positions route failed",
        message,
        diagnostics: { canonical: canonicalParam },
      },
      { status: 500 }
    );
  }
}
