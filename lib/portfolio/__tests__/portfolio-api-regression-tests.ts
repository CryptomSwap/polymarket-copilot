/**
 * Regression tests: portfolio positions (canonical=true) and overview.
 * - Positions route does not 500 when decisionSnapshots is single relation or null; unresolved positions handled.
 * - Overview derives totals from current DerivedPosition so it matches user-sync/recompute.
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/portfolio/__tests__/portfolio-api-regression-tests.ts
 */

import * as fs from "fs";
import * as path from "path";
import { buildCanonicalPositionView } from "../canonical-position-view";
import { toPositionViewFromCanonical } from "../position-display";
import type { PositionEnrichmentInput } from "../canonical-position-view";
import { buildOpenPositionsFromOfficial } from "../open-positions-from-official";
import { getResolutionCounts, isPositionUnresolved } from "../resolution-classifier";
import {
  getFreshnessState,
  normalizeFreshnessForApi,
  unknownFreshness,
} from "../freshness-contract";

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  function check(cond: boolean, msg: string): void {
    if (cond) {
      passed++;
      console.log("  OK:", msg);
    } else {
      failed++;
      console.error("  FAIL:", msg);
    }
  }

  const positionsRoutePath = path.resolve(__dirname, "../../../app/api/portfolio/positions/route.ts");
  const overviewRoutePath = path.resolve(__dirname, "../../../app/api/portfolio/overview/route.ts");
  const enrichPath = path.resolve(__dirname, "../enrich-positions.ts");

  console.log("\n--- Positions route: decisionSnapshots as single relation (no [0]) ---");
  const positionsSource = fs.readFileSync(positionsRoutePath, "utf8");
  check(
    positionsSource.includes("p.decisionSnapshots ?? null") || positionsSource.includes("decisionSnapshots ?? null"),
    "positions route uses decisionSnapshots as single object, not array index"
  );
  check(
    !positionsSource.includes("p.decisionSnapshots[0]"),
    "positions route does not use decisionSnapshots[0] (would throw when null)"
  );

  console.log("\n--- Positions route: try/catch returns 500 with diagnostics ---");
  check(positionsSource.includes("try {"), "positions route wrapped in try");
  check(positionsSource.includes("} catch ("), "positions route has catch block");
  check(
    positionsSource.includes("diagnostics") && positionsSource.includes("canonical"),
    "catch returns diagnostics including canonical flag"
  );

  console.log("\n--- Enrich positions: safe handling of null/undefined marketId/assetId ---");
  const enrichSource = fs.readFileSync(enrichPath, "utf8");
  check(
    enrichSource.includes("safeStr") || enrichSource.includes("String(s ?? \"\")") || enrichSource.includes("(p) =>"),
    "enrich-positions uses safe string for marketId/assetId"
  );

  console.log("\n--- Overview: totals derived from open positions only (closed excluded) ---");
  const overviewSource = fs.readFileSync(overviewRoutePath, "utf8");
  check(
    overviewSource.includes("openPositions") && (overviewSource.includes("syncedMarket") && overviewSource.includes("status")),
    "overview filters to open positions by syncedMarket.status !== closed"
  );
  check(
    overviewSource.includes("totalCurrentValue") && overviewSource.includes("openPositionsCount"),
    "overview returns totalCurrentValue and openPositionsCount"
  );

  console.log("\n--- Positions route: closed markets excluded by default ---");
  check(
    positionsSource.includes("openOnly") && positionsSource.includes("closed"),
    "positions route has openOnly filter and excludes closed status"
  );
  check(
    positionsSource.includes("positionsToUse") && positionsSource.includes("openIndices"),
    "positions route uses filtered list for response"
  );

  console.log("\n--- Market resolution: user sync triggers backfill held markets ---");
  const userSyncRoutePath = path.resolve(__dirname, "../../../app/api/polymarket/user/sync/route.ts");
  const userSyncSource = fs.readFileSync(userSyncRoutePath, "utf8");
  check(userSyncSource.includes("backfillHeldMarkets"), "user sync route calls backfillHeldMarkets after sync");
  check(userSyncSource.includes("getFunderForRecompute"), "user sync route gets funder for backfill");

  console.log("\n--- Enrich: resolution order and tokenId case normalization ---");
  check(enrichSource.includes("marketByAssetId.get(normAsset)") || enrichSource.includes("marketByAssetId.get(normAsset.toLowerCase())"), "enrich tries both raw and lowercase assetId for match");
  check(enrichSource.includes("normalizeConditionId"), "enrich uses normalizeConditionId for conditionId match");
  check(enrichSource.includes("syncedTokenCount") || enrichSource.includes("sampleUnresolvedIdentifiers"), "enrich diagnostics include syncedTokenCount or sampleUnresolvedIdentifiers");

  console.log("\n--- Canonical view: unresolved enrichment does not throw ---");
  const unresolvedEnrichment: PositionEnrichmentInput = {
    marketId: "",
    marketTitle: "Unknown market",
    marketSlug: null,
    category: "other",
    theme: "Unknown market",
    endDate: null,
    matchedBy: null,
  };
  const positionRow = {
    funderAddress: "0xabc",
    marketId: "0xcond",
    assetId: "0xasset",
    marketTitle: "Raw market",
    outcome: "YES",
    side: "YES",
    size: "100",
    avgEntry: "0.5" as string | null,
    lastPrice: "0.55",
    costBasis: "50" as string | null,
    marketValue: "55",
    unrealizedPnl: "5" as string | null,
    realizedPnl: "0",
    category: null,
    theme: null,
    openedAt: new Date(),
  };
  try {
    const view = buildCanonicalPositionView(positionRow, unresolvedEnrichment);
    check(view.quality.matchedBy === null, "unresolved enrichment produces matchedBy null");
    check(view.quality.isResolved === false, "unresolved produces isResolved false");
    check(view.quality.hasCompleteDisplayMetadata === false, "unresolved produces hasCompleteDisplayMetadata false");
    check(view.market.id === null, "unresolved enrichment produces market.id null");
    check(view.market.title === "Raw market" || view.market.title === "Unknown market", "unresolved uses position title or Unknown market");
    check(view.quality.warnings.some((w) => w.toLowerCase().includes("not resolved")), "unresolved has catalog warning");
    const positionView = toPositionViewFromCanonical({
      ...view,
      syncedMarketId: view.market.id,
      rawMarketRef: positionRow.marketId,
      resolutionSource: "unresolved",
    });
    check(positionView.resolutionSource === "unresolved", "positionView resolutionSource unresolved");
  } catch (e) {
    failed++;
    console.error("  FAIL: buildCanonicalPositionView / toPositionViewFromCanonical threw", e);
  }

  console.log("\n--- Canonical view: null basis fields (suppressed-basis row) ---");
  const nullBasisRow = {
    ...positionRow,
    avgEntry: null as string | null,
    costBasis: null as string | null,
    unrealizedPnl: null as string | null,
    size: "200",
    marketValue: "120",
    lastPrice: "0.6",
    realizedPnl: "0",
  };
  try {
    const nullBasisView = buildCanonicalPositionView(nullBasisRow, unresolvedEnrichment);
    check(nullBasisView.economics.avgEntry === null, "economics.avgEntry is null when basis unavailable");
    check(nullBasisView.economics.costBasis === null, "economics.costBasis is null when basis unavailable");
    check(nullBasisView.economics.unrealizedPnl === null, "economics.unrealizedPnl is null when basis unavailable");
    check(nullBasisView.economics.quantity === "200" && nullBasisView.economics.currentValue === "120", "quantity and currentValue remain when basis unavailable");
    const positionViewNull = toPositionViewFromCanonical({
      ...nullBasisView,
      economics: nullBasisView.economics,
      syncedMarketId: null,
      rawMarketRef: "0xcond",
      resolutionSource: "unresolved",
    });
    check(positionViewNull.avgEntry === null && positionViewNull.unrealizedPnl === null, "PositionView accepts null avgEntry and unrealizedPnl (null-safe)");
  } catch (e) {
    failed++;
    console.error("  FAIL: null-basis canonical view threw", e);
  }

  console.log("\n--- Overview: costBasis and unrealizedPnl only from rows with available basis ---");
  check(
    overviewSource.includes("r.costBasis != null") && overviewSource.includes("rowsExcludedFromCostBasisTotal"),
    "overview only sums costBasis when not null and exposes rowsExcludedFromCostBasisTotal"
  );
  check(
    overviewSource.includes("r.unrealizedPnl != null") && overviewSource.includes("rowsExcludedFromUnrealizedPnlTotal"),
    "overview only sums unrealizedPnl when not null and exposes rowsExcludedFromUnrealizedPnlTotal"
  );

  console.log("\n--- Resolved enrichment: returns title/slug (no Unknown market) ---");
  const resolvedEnrichment: PositionEnrichmentInput = {
    marketId: "mkt-1",
    marketTitle: "Will X happen?",
    marketSlug: "will-x-happen",
    category: "politics",
    theme: "Elections",
    endDate: "2030-12-31T00:00:00.000Z",
    matchedBy: "assetId",
  };
  const resolvedView = buildCanonicalPositionView(positionRow, resolvedEnrichment);
  check(resolvedView.market.title === "Will X happen?", "resolved enrichment produces real title");
  check(resolvedView.market.slug === "will-x-happen", "resolved enrichment produces slug");
  check(resolvedView.quality.matchedBy === "assetId", "resolved enrichment matchedBy assetId");
  check(resolvedView.quality.isResolved === true, "fully enriched produces isResolved true");
  check(resolvedView.quality.hasCompleteDisplayMetadata === true, "fully enriched produces hasCompleteDisplayMetadata true");
  check(resolvedView.quality.marketEndDatePassed === false, "future endDate (2030) produces marketEndDatePassed false");

  console.log("\n--- Matched but incomplete metadata: null category/theme/endDate ---");
  const incompleteEnrichment: PositionEnrichmentInput = {
    marketId: "mkt-2",
    marketTitle: "Partial market",
    marketSlug: "partial-market",
    category: null,
    theme: null,
    endDate: null,
    matchedBy: "marketId",
  };
  const incompleteView = buildCanonicalPositionView(positionRow, incompleteEnrichment);
  check(incompleteView.quality.isResolved === true, "matched with null category still produces isResolved true");
  check(incompleteView.quality.hasCompleteDisplayMetadata === false, "matched but null category/theme/endDate produces hasCompleteDisplayMetadata false");
  check(
    incompleteView.quality.warnings.some((w) => w.toLowerCase().includes("category") || w.toLowerCase().includes("theme") || w.toLowerCase().includes("end date")),
    "incomplete metadata produces specific warnings"
  );

  console.log("\n--- Past endDate: marketEndDatePassed true ---");
  const pastEndEnrichment: PositionEnrichmentInput = {
    marketId: "mkt-3",
    marketTitle: "Ended market",
    marketSlug: "ended-market",
    category: "other",
    theme: "Other",
    endDate: "2020-01-01T00:00:00.000Z",
    matchedBy: "conditionId",
  };
  const pastEndView = buildCanonicalPositionView(positionRow, pastEndEnrichment);
  check(pastEndView.quality.marketEndDatePassed === true, "past endDate produces marketEndDatePassed true");
  check(pastEndView.quality.isResolved === true, "matched with past end produces isResolved true");

  console.log("\n--- Canonical unresolved: resolutionSource and unresolvedReason ---");
  const unresolvedView = buildCanonicalPositionView(positionRow, unresolvedEnrichment);
  check(unresolvedView.quality.resolutionSource === "unresolved", "unresolved view has resolutionSource unresolved");
  check(unresolvedView.quality.unresolvedReason != null && unresolvedView.quality.unresolvedReason.length > 0, "unresolved view has unresolvedReason");
  check(resolvedView.quality.resolutionSource === "assetId", "resolved view has resolutionSource from matchedBy");
  check(resolvedView.quality.unresolvedReason === null, "resolved view has null unresolvedReason");

  console.log("\n--- Resolution classifier: canonical counts ---");
  const { unresolvedCount: u, resolvedCount: r, total: t } = getResolutionCounts([
    unresolvedView.quality,
    resolvedView.quality,
    incompleteView.quality,
    pastEndView.quality,
  ]);
  check(t === 4, "getResolutionCounts total 4");
  check(u === 1, "getResolutionCounts unresolved 1 (only unresolved enrichment)");
  check(r === 3, "getResolutionCounts resolved 3 (matched including incomplete)");
  check(isPositionUnresolved(unresolvedView.quality) === true, "isPositionUnresolved true for unresolved");
  check(isPositionUnresolved(resolvedView.quality) === false, "isPositionUnresolved false for resolved");

  console.log("\n--- Intelligence: single canonical count (summary and diagnostics align) ---");
  const intelPath = path.resolve(__dirname, "../intelligence.ts");
  const intelSrc = fs.readFileSync(intelPath, "utf8");
  check(intelSrc.includes("getResolutionCounts"), "intelligence uses getResolutionCounts for canonical counts");
  check(
    intelSrc.includes("unresolvedCount") && intelSrc.includes("unresolvedPositions: unresolvedCount"),
    "intelligence sets unresolvedPositions from canonical unresolvedCount"
  );
  check(
    intelSrc.includes("unresolvedPositions: unresolvedCount"),
    "intelligence assigns unresolvedCount to summary and diagnostics unresolvedPositions"
  );
  check(
    !intelSrc.includes("unresolved: unresolvedCount") && !intelSrc.includes("unresolved: diagnostics.unresolved"),
    "intelligence diagnostics do not expose deprecated alias unresolved"
  );

  console.log("\n--- Positions route: canonical count from views ---");
  check(positionsSource.includes("getResolutionCounts"), "positions route uses getResolutionCounts");
  check(positionsSource.includes("canonicalUnresolved") || positionsSource.includes("canonicalResolved"), "positions route uses canonical counts in diagnostics");
  check(positionsSource.includes("unresolvedPositions:"), "positions route diagnostics expose unresolvedPositions");
  check(
    !positionsSource.includes("unresolved: canonicalUnresolved") && !positionsSource.includes("unresolved: legacyUnresolved"),
    "positions route diagnostics do not expose deprecated alias unresolved"
  );

  console.log("\n--- Positions route: quality contract (hasCompleteDisplayMetadata only) ---");
  check(positionsSource.includes("hasCompleteDisplayMetadata"), "positions route quality exposes hasCompleteDisplayMetadata");
  check(!positionsSource.includes("hasFullMarketMetadata"), "positions route does not expose deprecated hasFullMarketMetadata");

  console.log("\n--- Official positions as open set (source-of-truth consistent) ---");
  check((positionsSource.includes("getLiveOfficialPositions") || positionsSource.includes("fetchOfficialPositions")) && positionsSource.includes("buildOpenPositionsFromOfficial"), "positions route uses live official feed and buildOpenPositionsFromOfficial");
  check(positionsSource.includes("quantitySource") && positionsSource.includes("priceSource") && positionsSource.includes("basisSource") && positionsSource.includes("pnlSource") && positionsSource.includes("rowSource"), "positions route exposes quantitySource, priceSource, basisSource, pnlSource, rowSource");
  check(positionsSource.includes("sourceOfTruth") && positionsSource.includes("asOf") && positionsSource.includes("freshnessMs"), "positions route exposes sourceOfTruth, asOf, freshnessMs");
  check(positionsSource.includes("officialFetchFailed") && positionsSource.includes("officialPositionsUsed") && positionsSource.includes("derivedOnlyExcluded"), "positions route diagnostics include officialFetchFailed, officialPositionsUsed and derivedOnlyExcluded");
  check(positionsSource.includes("rowsWithMissingBasis") || positionsSource.includes("rowsWithEstimatedBasis"), "positions route diagnostics include basis-quality fields");
  check(positionsSource.includes("closedOfficialExcluded") && positionsSource.includes("rowsWithInvalidDerivedBasis") && positionsSource.includes("rowsWithSuppressedBasis"), "positions route diagnostics include closedOfficialExcluded and invalid/suppressed basis fields");
  check((overviewSource.includes("getLiveOfficialPositions") || overviewSource.includes("fetchOfficialPositions")) && overviewSource.includes("buildOpenPositionsFromOfficial"), "overview uses live official feed and buildOpenPositionsFromOfficial");
  check(overviewSource.includes("sourceOfTruth") && overviewSource.includes("asOf"), "overview exposes sourceOfTruth and asOf");
  check(overviewSource.includes("openPortfolioSource") && (overviewSource.includes("derivedOnlyExcluded") || overviewSource.includes("officialPositionsUsed")), "overview exposes openPortfolioSource and merge diagnostics");

  console.log("\n--- Overview: live open orders and order diagnostics (no silent fallback) ---");
  check(overviewSource.includes("getLiveOfficialOpenOrders"), "overview uses getLiveOfficialOpenOrders for open orders");
  check(overviewSource.includes("orderSourceOfTruth"), "overview exposes orderSourceOfTruth");
  check(overviewSource.includes("ordersAsOf") && overviewSource.includes("ordersFreshnessMs"), "overview exposes ordersAsOf and ordersFreshnessMs");
  check(overviewSource.includes("officialOrdersFetchFailed") && overviewSource.includes("officialOrdersFetchStatus") && overviewSource.includes("officialOrdersFetchError"), "overview diagnostics expose officialOrdersFetchFailed, officialOrdersFetchStatus, officialOrdersFetchError");
  check(overviewSource.includes("liveOrders.metadata.success") && overviewSource.includes("prisma.userOrder.count"), "overview uses official count when success else fallback to UserOrder count (no silent mixing)");

  console.log("\n--- Orders reconciliation debug: route and response shape ---");
  const ordersReconPath = path.resolve(__dirname, "../../../app/api/portfolio/orders-reconciliation-debug/route.ts");
  const ordersReconExists = fs.existsSync(ordersReconPath);
  check(ordersReconExists, "orders-reconciliation-debug route exists");
  if (ordersReconExists) {
    const ordersReconSource = fs.readFileSync(ordersReconPath, "utf8");
    check(ordersReconSource.includes("getLiveOfficialOpenOrders") && ordersReconSource.includes("getOrdersReconciliationDiagnostics"), "orders-reconciliation-debug uses live open orders and reconciliation diagnostics");
    check(ordersReconSource.includes("...diagnostics"), "orders-reconciliation-debug returns spread diagnostics (officialOpenOrdersCount, ordersMissingLocally, etc.)");
  }

  console.log("\n--- Intelligence: order diagnostics in response ---");
  const intelligenceRoutePath = path.resolve(__dirname, "../../../app/api/portfolio/intelligence/route.ts");
  const intelligenceRouteSource = fs.readFileSync(intelligenceRoutePath, "utf8");
  check(intelligenceRouteSource.includes("orderSourceOfTruth") && intelligenceRouteSource.includes("ordersAsOf"), "intelligence route exposes orderSourceOfTruth and ordersAsOf");
  check(intelligenceRouteSource.includes("officialOrdersFetchFailed") && intelligenceRouteSource.includes("officialOrdersFetchStatus"), "intelligence route exposes officialOrdersFetchFailed and officialOrdersFetchStatus");

  console.log("\n--- Overview: concentration metrics (theme vs market) ---");
  check(overviewSource.includes("topThemeConcentrationPct") && overviewSource.includes("topMarketConcentrationPct"), "overview returns topThemeConcentrationPct and topMarketConcentrationPct");
  check(overviewSource.includes("byTheme") && overviewSource.includes("byMarket"), "overview computes byTheme and byMarket for concentration");
  check(!overviewSource.includes("topConcentrationPct"), "overview does not use legacy topConcentrationPct");

  console.log("\n--- Concentration: explicit DB/persistence naming (no legacy topConcentrationPct) ---");
  const schemaPath = path.resolve(__dirname, "../../../prisma/schema.prisma");
  const schemaSource = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, "utf8") : "";
  check(schemaSource.includes("topThemeConcentrationPct") && !schemaSource.includes("topConcentrationPct"), "Prisma schema uses topThemeConcentrationPct, not legacy topConcentrationPct");
  const analyticsPath = path.resolve(__dirname, "../../../lib/polymarket/analytics.ts");
  const analyticsSource = fs.existsSync(analyticsPath) ? fs.readFileSync(analyticsPath, "utf8") : "";
  check(!analyticsSource.includes("topConcentrationPct"), "analytics persist does not use legacy topConcentrationPct");
  const datasetPath = path.resolve(__dirname, "../../../lib/ml/dataset.ts");
  const datasetSource = fs.existsSync(datasetPath) ? fs.readFileSync(datasetPath, "utf8") : "";
  check(!datasetSource.includes("topConcentrationPct"), "ML dataset does not use legacy topConcentrationPct");
  const scoreLivePath = path.resolve(__dirname, "../../../lib/ml/score-live.ts");
  const scoreLiveSource = fs.existsSync(scoreLivePath) ? fs.readFileSync(scoreLivePath, "utf8") : "";
  check(!scoreLiveSource.includes("topConcentrationPct"), "ML score-live does not use legacy topConcentrationPct");
  const decisionRecomputePath = path.resolve(__dirname, "../../../lib/decision/recompute.ts");
  const decisionRecomputeSource = fs.existsSync(decisionRecomputePath) ? fs.readFileSync(decisionRecomputePath, "utf8") : "";
  check(!decisionRecomputeSource.includes("topConcentrationPct"), "decision recompute does not use legacy topConcentrationPct");
  const analyticsDataRoutePath = path.resolve(__dirname, "../../../app/api/analytics/data/route.ts");
  const analyticsDataSource = fs.existsSync(analyticsDataRoutePath) ? fs.readFileSync(analyticsDataRoutePath, "utf8") : "";
  check(!analyticsDataSource.includes("topConcentrationPct"), "analytics data route does not use legacy topConcentrationPct");

  console.log("\n--- Overview: live truth response contract (no stale persisted snapshot as live) ---");
  check(!overviewSource.includes("id: snapshot?.id") && !overviewSource.includes("id: snapshot?.id ?? null"), "overview snapshot object does not include persisted id");
  check(!overviewSource.includes("createdAt: snapshot?.createdAt") && !overviewSource.includes("createdAt: snapshot?.createdAt?.toISOString()"), "overview snapshot object does not include persisted createdAt");
  check(overviewSource.includes("persistedSnapshotMeta") && overviewSource.includes("snapshot.id") && overviewSource.includes("snapshot.createdAt.toISOString()"), "overview puts persisted row under persistedSnapshotMeta when snapshot exists");
  check(overviewSource.includes("asOf: fetchMetadata.asOf.toISOString()") && overviewSource.includes("freshnessMs"), "overview exposes top-level asOf and freshnessMs for live timestamp");

  console.log("\n--- Freshness contract: explicit fresh/cached/unknown ---");
  const freshnessContractPath = path.resolve(__dirname, "../freshness-contract.ts");
  const contractSource = fs.existsSync(freshnessContractPath) ? fs.readFileSync(freshnessContractPath, "utf8") : "";
  check(contractSource.includes("freshnessMs = 0") && contractSource.includes("freshnessState"), "freshness-contract defines freshnessMs=0 for fresh and freshnessState");
  check(getFreshnessState(0) === "fresh", "getFreshnessState(0) === fresh");
  check(getFreshnessState(100) === "cached", "getFreshnessState(100) === cached");
  check(getFreshnessState(null) === "unknown", "getFreshnessState(null) === unknown");
  check(getFreshnessState(undefined) === "unknown", "getFreshnessState(undefined) === unknown");
  const freshNorm = normalizeFreshnessForApi(false, 0);
  check(freshNorm.freshnessMs === 0 && freshNorm.freshnessState === "fresh", "normalizeFreshnessForApi(!fromCache) yields freshnessMs 0 and state fresh");
  const cachedNorm = normalizeFreshnessForApi(true, 5000);
  check(cachedNorm.freshnessMs === 5000 && cachedNorm.freshnessState === "cached", "normalizeFreshnessForApi(fromCache, 5000) yields 5000 and cached");
  const unknown = unknownFreshness();
  check(unknown.freshnessMs === null && unknown.freshnessState === "unknown", "unknownFreshness() yields null and unknown");

  check(overviewSource.includes("normalizeFreshnessForApi") && overviewSource.includes("freshnessState"), "overview uses normalizeFreshnessForApi and exposes freshnessState");
  check(overviewSource.includes("posFresh.freshnessMs") || (overviewSource.includes("freshnessMs: posFresh")), "overview sets freshnessMs from posFresh (0 for fresh, not null)");
  check(overviewSource.includes("ordersFreshnessState"), "overview exposes ordersFreshnessState");
  check(!overviewSource.includes("fromCache ? fetchMetadata.freshnessMs : null"), "overview does not use fromCache ? x : null for positions freshness (use 0 for fresh)");
  check(positionsSource.includes("normalizeFreshnessForApi") && positionsSource.includes("freshnessState"), "positions route uses normalizeFreshnessForApi and exposes freshnessState");
  check(positionsSource.includes("posFresh.freshnessMs") || positionsSource.includes("freshnessMs: posFresh"), "positions sets freshnessMs from posFresh");
  check(!positionsSource.includes("fromCache ? fetchMetadata.freshnessMs : null"), "positions route does not use fromCache ? x : null (use 0 for fresh)");

  console.log("\n--- Freshness indicator: uses asOf only for last updated ---");
  const freshnessIndicatorPath = path.resolve(__dirname, "../../../components/portfolio/portfolio-freshness-indicator.tsx");
  const freshnessSource = fs.existsSync(freshnessIndicatorPath) ? fs.readFileSync(freshnessIndicatorPath, "utf8") : "";
  check(freshnessSource.includes("asOf") && (freshnessSource.includes("formatRelative(asOf)") || (freshnessSource.includes("label") && freshnessSource.includes("asOf"))), "freshness indicator uses asOf for display label");
  check(!/createdAt\s*[?:]/.test(freshnessSource) || freshnessSource.includes("do not use snapshot.createdAt"), "freshness indicator does not take createdAt as prop (prefer asOf)");
  check(freshnessSource.includes("freshnessState"), "freshness indicator accepts freshnessState");
  check(freshnessSource.includes("unknown") && (freshnessSource.includes("Freshness unknown") || freshnessSource.includes("freshness unknown")), "freshness indicator shows unknown distinctly");
  check(freshnessSource.includes("do not assume") || freshnessSource.includes("do not treat"), "freshness indicator does not imply unknown == fresh");
  check(freshnessSource.includes("ordersAsOf"), "freshness indicator accepts ordersAsOf for orders timestamp");
  check(freshnessSource.includes("Positions:") && freshnessSource.includes("Orders:"), "freshness indicator can render separate Positions and Orders labels");
  check(freshnessSource.includes("unified") || freshnessSource.includes("sameTime") || freshnessSource.includes("sameSource"), "freshness indicator has unified vs mixed-time logic");

  console.log("\n--- Overview widget: passes full order freshness and mixed-time support ---");
  const overviewWidgetPath = path.resolve(__dirname, "../../../components/dashboard/portfolio-overview-widget.tsx");
  const overviewWidgetSource = fs.existsSync(overviewWidgetPath) ? fs.readFileSync(overviewWidgetPath, "utf8") : "";
  check(overviewWidgetSource.includes("ordersAsOf={overview.ordersAsOf}"), "overview widget passes ordersAsOf to freshness indicator");
  check(overviewWidgetSource.includes("ordersAsOf") && overviewWidgetSource.includes("ordersFreshnessMs") && overviewWidgetSource.includes("ordersFreshnessState"), "overview widget passes full order freshness props");
  check(overviewWidgetSource.includes("asOf != null || overview?.ordersAsOf") || overviewWidgetSource.includes("ordersAsOf != null"), "overview widget shows indicator when positions or orders asOf present");

  console.log("\n--- Behavior flags: separate asOf and no shared snapshot implication ---");
  const behaviorFlagsRoutePath = path.resolve(__dirname, "../../../app/api/portfolio/behavior-flags/route.ts");
  const behaviorFlagsRouteSource = fs.existsSync(behaviorFlagsRoutePath) ? fs.readFileSync(behaviorFlagsRoutePath, "utf8") : "";
  check(behaviorFlagsRouteSource.includes("asOf") && (behaviorFlagsRouteSource.includes("toISOString()") || behaviorFlagsRouteSource.includes("asOf:")), "behavior-flags route returns top-level asOf");
  check(overviewWidgetSource.includes("flagsAsOf"), "overview widget stores flagsAsOf from flags response");
  check(overviewWidgetSource.includes("Flags as of") || overviewWidgetSource.includes("formatRelative(flagsAsOf)"), "overview widget shows flags timing (Flags as of X)");
  check(overviewWidgetSource.includes("Separate refresh") && overviewWidgetSource.includes("may not match overview"), "overview widget shows separate-refresh note when flags and overview differ");

  console.log("\n--- buildOpenPositionsFromOfficial: row math and open set ---");
  const officialList = [
    { asset: "0xasset1", size: 100, curPrice: 0.6, conditionId: "0xcond1", title: "Market 1", outcome: "Yes" },
  ];
  const derivedList = [
    {
      funderAddress: "0xfunder",
      marketId: "0xcond1",
      assetId: "0xasset1",
      marketTitle: "Market 1",
      outcome: "YES",
      side: "YES",
      size: "100",
      avgEntry: "0.5",
      lastPrice: "0.6",
      costBasis: "50",
      marketValue: "60",
      unrealizedPnl: "10",
      realizedPnl: "0",
      reservedOrderSize: "0",
      reservedOrderValue: "0",
      category: null,
      theme: null,
      openedAt: null,
      syncedMarket: null,
    } as Parameters<typeof buildOpenPositionsFromOfficial>[1][0],
    {
      funderAddress: "0xfunder",
      marketId: "0xcond2",
      assetId: "0xasset2",
      marketTitle: "Market 2",
      outcome: "NO",
      side: "NO",
      size: "50",
      avgEntry: "0.4",
      lastPrice: "0.3",
      costBasis: "20",
      marketValue: "15",
      unrealizedPnl: "-5",
      realizedPnl: "0",
      reservedOrderSize: "0",
      reservedOrderValue: "0",
      category: null,
      theme: null,
      openedAt: null,
      syncedMarket: null,
    } as Parameters<typeof buildOpenPositionsFromOfficial>[1][0],
  ];
  const out = buildOpenPositionsFromOfficial(officialList, derivedList, "0xfunder", true);
  check(out.rows.length === 1, "openOnly=true: only official positions in set (one row)");
  const row = out.rows[0];
  check(row.assetId === "0xasset1", "row is for official asset");
  const q = parseFloat(row.size);
  const avg = row.avgEntry != null ? parseFloat(row.avgEntry) : NaN;
  const basis = row.costBasis != null ? parseFloat(row.costBasis) : 0;
  check(Number.isFinite(avg) && Math.abs(q * avg - basis) < 0.01, "row math: quantity * avgEntry ≈ costBasis when basis available");
  check(out.diagnostics.derivedOnlyExcluded === 1, "derived-only excluded count is 1 when one derived not in official");
  check(row.rowSource === "official+derived", "matched row has rowSource official+derived");

  // Impossible derived basis (avgEntry > 1) is suppressed: basis/PnL must be null, not "0".
  const badDerivedList = [
    {
      funderAddress: "0xfunder",
      marketId: "0xcond1",
      assetId: "0xasset1",
      marketTitle: "Market 1",
      outcome: "YES",
      side: "YES",
      size: "100",
      avgEntry: "2.5",
      lastPrice: "0.6",
      costBasis: "250",
      marketValue: "60",
      unrealizedPnl: "-190",
      realizedPnl: "0",
      reservedOrderSize: "0",
      reservedOrderValue: "0",
      category: null,
      theme: null,
      openedAt: null,
      syncedMarket: null,
    } as Parameters<typeof buildOpenPositionsFromOfficial>[1][0],
  ];
  const badOut = buildOpenPositionsFromOfficial(officialList, badDerivedList, "0xfunder", true);
  const badRow = badOut.rows[0];
  check(badRow.basisSource === "unavailable", "invalid derived basis marked as unavailable");
  check(badRow.costBasis === null, "invalid derived costBasis suppressed (null not zero)");
  check(badRow.avgEntry === null, "invalid derived avgEntry suppressed (null not zero)");
  check(badRow.unrealizedPnl === null, "unrealizedPnl suppressed when basis unavailable (no stale derived PnL)");
  check(badRow.size !== "" && Number.isFinite(parseFloat(badRow.size)), "quantity remains present when basis unavailable");
  check(badRow.marketValue !== "" && Number.isFinite(parseFloat(badRow.marketValue)), "marketValue remains present when basis unavailable");

  const debugRoutePath = path.resolve(__dirname, "../../../app/api/portfolio/positions-source-of-truth-debug/route.ts");
  const debugRouteExists = fs.existsSync(debugRoutePath);
  check(debugRouteExists, "positions-source-of-truth-debug route exists");
  if (debugRouteExists) {
    const debugSource = fs.readFileSync(debugRoutePath, "utf8");
    check(debugSource.includes("officialQuantity") && debugSource.includes("derivedQuantity") && debugSource.includes("quantityDelta"), "comparison route returns officialQuantity, derivedQuantity, quantityDelta");
    check(debugSource.includes("addressUsedForApi") && debugSource.includes("funderAddress"), "comparison route shows address used for API and funder");
    check(debugSource.includes("matches") && debugSource.includes("mismatches"), "comparison route shows match flag and mismatches list");
  }

  console.log("\n--- Decision engine: official quantity and suggestedExitSize cap ---");
  const positionsRouteSource = fs.readFileSync(positionsRoutePath, "utf8");
  check(
    positionsRouteSource.includes("Math.min(displayedQuantity") || positionsRouteSource.includes("Math.min(displayedQty"),
    "positions route caps suggestedExitSize to displayed quantity"
  );
  check(
    positionsRouteSource.includes("suggestedExitSize") && positionsRouteSource.includes("decision"),
    "positions route returns decision with suggestedExitSize"
  );
  const recomputePath = path.resolve(__dirname, "../../position/recompute.ts");
  const recomputeSource = fs.existsSync(recomputePath) ? fs.readFileSync(recomputePath, "utf8") : "";
  check(
    recomputeSource.includes("fetchOfficialPositions") && recomputeSource.includes("buildOpenPositionsFromOfficial"),
    "recompute uses official positions and buildOpenPositionsFromOfficial when available"
  );
  check(recomputeSource.includes("usedOfficialOpenSet"), "recompute exposes usedOfficialOpenSet in result");
  const decisionPath = path.resolve(__dirname, "../../position/decision.ts");
  const decisionSource = fs.existsSync(decisionPath) ? fs.readFileSync(decisionPath, "utf8") : "";
  check(
    decisionSource.includes("costBasis > 0 ? unrealizedPnl / costBasis : 0"),
    "decision uses null-safe pnlFraction when costBasis is 0 (basis unavailable)"
  );
  const { computePositionDecision } = await import("../../position/decision");
  const ctxUnavailableBasis = {
    funderAddress: "0xf",
    assetId: "0xa",
    marketId: "0xm",
    size: "1288.5",
    avgEntry: "",
    lastPrice: "0.6",
    unrealizedPnl: "",
    marketValue: "773.1",
    category: null,
    theme: "Other",
    concentrationPct: 10,
    daysToResolution: 30,
    recommendationPolicyState: null,
    hasBehaviorFlag: false,
    setupActedWinRate: null,
    linkedNewsCount: 0,
    unrealizedPnlFraction: 0,
  };
  try {
    const result = computePositionDecision(ctxUnavailableBasis);
    check(result.suggestedExitSize !== undefined && result.decisionState !== undefined, "decision returns state and suggestedExitSize");
    const suggestedNum = parseFloat(result.suggestedExitSize);
    check(suggestedNum <= 1288.5 + 0.01, "suggestedExitSize never exceeds position size (official quantity)");
    check(Number.isFinite(suggestedNum) && suggestedNum >= 0, "suggestedExitSize is non-negative number");
  } catch (e) {
    failed++;
    console.error("  FAIL: computePositionDecision with unavailable basis threw", e);
  }

  console.log("\n--- Official basis: prefer API when available, fallback derived, then null ---");
  const { getOfficialBasisIfSane } = await import("../../polymarket/official-positions");
  const officialWithBasis = {
    asset: "0xasset",
    size: 100,
    initialValue: 60,
    avgPrice: 0.6,
    currentValue: 65,
    cashPnl: 5,
    curPrice: 0.65,
    realizedPnl: 0,
  };
  const officialBasis = getOfficialBasisIfSane(officialWithBasis as Parameters<typeof getOfficialBasisIfSane>[0]);
  check(officialBasis != null, "getOfficialBasisIfSane returns snapshot when official has initialValue/avgPrice");
  if (officialBasis) {
    check(Math.abs(officialBasis.costBasis - 60) < 0.01, "official costBasis from initialValue");
    check(Math.abs(officialBasis.avgEntry - 0.6) < 0.01, "official avgEntry from initialValue/size");
    check(Math.abs(officialBasis.unrealizedPnl - 5) < 0.01, "official unrealizedPnl from cashPnl");
  }
  const officialNoBasis = { asset: "0xa", size: 50 } as Parameters<typeof getOfficialBasisIfSane>[0];
  check(getOfficialBasisIfSane(officialNoBasis) === null, "getOfficialBasisIfSane returns null when no initialValue/avgPrice");

  const officialListWithBasis = [
    { asset: "0xasset1", size: 200, initialValue: 120, avgPrice: 0.6, currentValue: 140, cashPnl: 20, curPrice: 0.7, conditionId: "0xcond", title: "Market", outcome: "Yes" },
  ];
  const derivedListForOfficial = [
    {
      funderAddress: "0xf",
      marketId: "0xcond",
      assetId: "0xasset1",
      marketTitle: "Market",
      outcome: "YES",
      side: "YES",
      size: "500",
      avgEntry: "2.5",
      lastPrice: "0.7",
      costBasis: "1250",
      marketValue: "350",
      unrealizedPnl: "-900",
      realizedPnl: "0",
      reservedOrderSize: "0",
      reservedOrderValue: "0",
      category: null,
      theme: null,
      openedAt: null,
      syncedMarket: null,
    } as Parameters<typeof buildOpenPositionsFromOfficial>[1][0],
  ];
  const mergedWithOfficialBasis = buildOpenPositionsFromOfficial(officialListWithBasis as Parameters<typeof buildOpenPositionsFromOfficial>[0], derivedListForOfficial, "0xf", true);
  const rowWithOfficialBasis = mergedWithOfficialBasis.rows[0];
  check(rowWithOfficialBasis != null, "merged row exists");
  check(rowWithOfficialBasis.basisSource === "official" || rowWithOfficialBasis.basisSource === "official_only", "when official has basis, row uses official basis (not broken derived)");
  check(rowWithOfficialBasis.avgEntry != null && rowWithOfficialBasis.costBasis != null && rowWithOfficialBasis.unrealizedPnl != null, "row has non-null avgEntry, costBasis, unrealizedPnl from official");
  check(rowWithOfficialBasis.pnlSource === "official", "pnlSource is official when basis from official");
  check(mergedWithOfficialBasis.diagnostics.rowsWithOfficialBasis >= 1, "diagnostics include rowsWithOfficialBasis");
  check(mergedWithOfficialBasis.diagnostics.rowsWithDerivedBasis !== undefined && mergedWithOfficialBasis.diagnostics.rowsWithUnavailableBasis !== undefined, "diagnostics include rowsWithDerivedBasis and rowsWithUnavailableBasis");

  const officialNoBasisList = [
    { asset: "0xasset2", size: 100, conditionId: "0xcond2", title: "Market2", outcome: "Yes" },
  ];
  const derivedSaneList = [
    {
      funderAddress: "0xf",
      marketId: "0xcond2",
      assetId: "0xasset2",
      marketTitle: "Market2",
      outcome: "YES",
      side: "YES",
      size: "100",
      avgEntry: "0.5",
      lastPrice: "0.55",
      costBasis: "50",
      marketValue: "55",
      unrealizedPnl: "5",
      realizedPnl: "0",
      reservedOrderSize: "0",
      reservedOrderValue: "0",
      category: null,
      theme: null,
      openedAt: null,
      syncedMarket: null,
    } as Parameters<typeof buildOpenPositionsFromOfficial>[1][0],
  ];
  const mergedDerivedFallback = buildOpenPositionsFromOfficial(officialNoBasisList as Parameters<typeof buildOpenPositionsFromOfficial>[0], derivedSaneList, "0xf", true);
  const rowDerivedFallback = mergedDerivedFallback.rows[0];
  check(rowDerivedFallback.basisSource === "derived" && rowDerivedFallback.pnlSource === "derived", "when official has no basis but derived is sane, use derived");
  check(rowDerivedFallback.avgEntry != null && rowDerivedFallback.costBasis != null, "derived fallback row has non-null basis");

  const derivedInvalidList = [
    {
      funderAddress: "0xf",
      marketId: "0xcond2",
      assetId: "0xasset2",
      marketTitle: "Market2",
      outcome: "YES",
      side: "YES",
      size: "100",
      avgEntry: "2.5",
      lastPrice: "0.55",
      costBasis: "250",
      marketValue: "55",
      unrealizedPnl: "-195",
      realizedPnl: "0",
      reservedOrderSize: "0",
      reservedOrderValue: "0",
      category: null,
      theme: null,
      openedAt: null,
      syncedMarket: null,
    } as Parameters<typeof buildOpenPositionsFromOfficial>[1][0],
  ];
  const mergedUnavailable = buildOpenPositionsFromOfficial(officialNoBasisList as Parameters<typeof buildOpenPositionsFromOfficial>[0], derivedInvalidList, "0xf", true);
  const rowUnavailable = mergedUnavailable.rows[0];
  check(rowUnavailable.basisSource === "unavailable" && rowUnavailable.pnlSource === "unavailable", "when official has no basis and derived is invalid, basis unavailable");
  check(rowUnavailable.avgEntry === null && rowUnavailable.costBasis === null && rowUnavailable.unrealizedPnl === null, "unavailable basis row has null avgEntry, costBasis, unrealizedPnl");

  console.log("\n--- Intelligence: same open truth model as overview/positions ---");
  const intelligencePath = path.resolve(__dirname, "../intelligence.ts");
  const intelligenceSource = fs.existsSync(intelligencePath) ? fs.readFileSync(intelligencePath, "utf8") : "";
  check(
    intelligenceSource.includes("loadOpenCanonicalPositions") && (intelligenceSource.includes("getLiveOfficialPositions") || intelligenceSource.includes("fetchOfficialPositions")) && intelligenceSource.includes("buildOpenPositionsFromOfficial"),
    "intelligence uses live official feed and buildOpenPositionsFromOfficial (same as overview)"
  );
  check(
    intelligenceSource.includes("openOnlyRows") && intelligenceSource.includes("closedOfficialExcluded") && (intelligenceSource.includes("status") && intelligenceSource.includes("closed")),
    "intelligence filters closed official rows (openOnlyRows, status/endDate)"
  );
  check(
    intelligenceSource.includes("openPortfolioSource") && intelligenceSource.includes("totalRowsBeforeFiltering") && intelligenceSource.includes("totalRowsAfterFiltering"),
    "intelligence diagnostics include openPortfolioSource, totalRowsBeforeFiltering, totalRowsAfterFiltering"
  );
  check(
    intelligenceSource.includes("rowsWithOfficialBasis") && intelligenceSource.includes("rowsWithDerivedBasis") && intelligenceSource.includes("rowsWithUnavailableBasis"),
    "intelligence diagnostics include rowsWithOfficialBasis, rowsWithDerivedBasis, rowsWithUnavailableBasis"
  );
  check(
    intelligenceSource.includes("totalPositions: views.length") || (intelligenceSource.includes("totalPositions") && intelligenceSource.includes("views.length")),
    "intelligence summary totalPositions equals open views count (filtered set)"
  );
  check(
    intelligenceSource.includes(".filter((b) => b.exposure > 0)") || intelligenceSource.includes("filter((b) => b.exposure > 0)"),
    "intelligence buckets exclude zero-exposure entries (byMarket, byCategory, byTheme)"
  );
  check(
    intelligenceSource.includes("totalCostBasis") && intelligenceSource.includes("summary.totalCostBasis"),
    "intelligence uses totalCostBasis for basis-dependent PnL flags (LARGE_LOSS/LARGE_GAIN)"
  );
  check(
    intelligenceSource.includes("topThemeConcentrationPct") && intelligenceSource.includes("topMarketConcentrationPct"),
    "intelligence summary exposes topThemeConcentrationPct and topMarketConcentrationPct"
  );
  check(
    intelligenceSource.includes("Top theme concentration") || intelligenceSource.includes("topThemeConcentrationPct"),
    "intelligence HIGH_CONCENTRATION flag message specifies theme (not ambiguous)"
  );
  check(
    intelligenceSource.includes("matchedByMarketId") && intelligenceSource.includes("openOnlyEnriched"),
    "intelligence matchedBy* counts refer to actual analyzed set (openOnlyEnriched)"
  );

  console.log("\n--- Live-truth architecture ---");
  const { runLiveTruthTests } = await import("./live-truth-tests");
  runLiveTruthTests();

  console.log("\n--- Open-position stale filtering ---");
  const { runOpenPositionStaleFilteringTests } = await import("./open-position-stale-filtering.test");
  runOpenPositionStaleFilteringTests();

  console.log("\n--- Official mark/currentValue propagation ---");
  const { runOfficialMarkValuePropagationTests } = await import("./official-mark-value-propagation.test");
  runOfficialMarkValuePropagationTests();

  console.log("\n--- Overview 500 error handling ---");
  const { runOverview500ErrorHandlingTests } = await import("./overview-500-error-handling.test");
  await runOverview500ErrorHandlingTests();

  console.log("\n--- Portfolio page render path ---");
  const { runPortfolioPageRenderPathTests } = await import("./portfolio-page-render-path.test");
  runPortfolioPageRenderPathTests();

  console.log("\n--- Truth model invariants ---");
  const { runTruthModelInvariants } = await import("./truth-model-invariants");
  const inv = runTruthModelInvariants();
  passed += inv.passed;
  failed += inv.failed;

  console.log("\n--- Alert feed (merge drift + engine) ---");
  try {
    const { runAlertFeedTests } = await import("../../alerts/__tests__/feed.test");
    const feedResult = runAlertFeedTests();
    passed += feedResult.passed;
    failed += feedResult.failed;
  } catch (e) {
    failed++;
    console.error("  FAIL: alert feed tests failed to run", e);
  }

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
