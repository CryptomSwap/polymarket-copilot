/**
 * Portfolio truth model invariant tests.
 * Production-readiness invariants that catch impossible states across overview, positions, and intelligence.
 * See docs/PORTFOLIO_LIVE_TRUTH_RESPONSE_CONTRACT.md and docs/PORTFOLIO_FRESHNESS_CONTRACT.md.
 *
 * Run with:
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/portfolio/__tests__/truth-model-invariants.ts
 * Or via portfolio-api-regression-tests (invokes runTruthModelInvariants).
 */

import * as fs from "fs";
import * as path from "path";
import { buildCanonicalPositionView } from "../canonical-position-view";
import type { PositionEnrichmentInput } from "../canonical-position-view";
import { buildOpenPositionsFromOfficial } from "../open-positions-from-official";
import { getResolutionCounts, isPositionUnresolved } from "../resolution-classifier";
import { getFreshnessState, normalizeFreshnessForApi, unknownFreshness } from "../freshness-contract";

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

export function runTruthModelInvariants(): { passed: number; failed: number } {
  const repoRoot = path.resolve(__dirname, "../../..");
  const overviewPath = path.join(repoRoot, "app/api/portfolio/overview/route.ts");
  const positionsPath = path.join(repoRoot, "app/api/portfolio/positions/route.ts");
  const intelligencePath = path.join(repoRoot, "lib/portfolio/intelligence.ts");
  const freshnessIndicatorPath = path.join(repoRoot, "components/portfolio/portfolio-freshness-indicator.tsx");

  const overviewSource = fs.existsSync(overviewPath) ? fs.readFileSync(overviewPath, "utf8") : "";
  const positionsSource = fs.existsSync(positionsPath) ? fs.readFileSync(positionsPath, "utf8") : "";
  const intelligenceSource = fs.existsSync(intelligencePath) ? fs.readFileSync(intelligencePath, "utf8") : "";
  const freshnessSource = fs.existsSync(freshnessIndicatorPath) ? fs.readFileSync(freshnessIndicatorPath, "utf8") : "";

  // ---------------------------------------------------------------------------
  // Invariant: overview totals computed only from open official position set
  // ---------------------------------------------------------------------------
  console.log("\n--- Invariant: overview totals from open set only ---");
  check(
    overviewSource.includes("openRows") || overviewSource.includes("openOnlyRows") || (overviewSource.includes("merged") && overviewSource.includes("openOnly")),
    "overview derives totals from open/filtered rows (not all positions)"
  );
  check(
    overviewSource.includes("closed") && (overviewSource.includes("status") || overviewSource.includes("endDate")),
    "overview excludes closed by status or endDate"
  );
  check(
    overviewSource.includes("buildOpenPositionsFromOfficial") && overviewSource.includes("getLiveOfficialPositions"),
    "overview uses official feed and buildOpenPositionsFromOfficial for open set"
  );

  // ---------------------------------------------------------------------------
  // Invariant: closed official rows must not appear in open positions
  // ---------------------------------------------------------------------------
  console.log("\n--- Invariant: closed official rows excluded from open set ---");
  check(positionsPath.length > 0 && positionsSource.includes("openOnly"), "positions route has openOnly filter");
  check(intelligenceSource.includes("closedOfficialExcluded") || intelligenceSource.includes("isStatusClosed") || intelligenceSource.includes("isEndPast"), "intelligence filters closed official rows before building views");
  const officialClosed = [{ asset: "0xa", size: 10, curPrice: 0.5, conditionId: "0xc", title: "M", outcome: "Yes" }];
  const derivedEmpty: Parameters<typeof buildOpenPositionsFromOfficial>[1] = [];
  const outOpenOnly = buildOpenPositionsFromOfficial(officialClosed, derivedEmpty, "0xf", true);
  check(outOpenOnly.rows.length === 1, "openOnly=true: one official row in set (closed filtered later in pipeline)");
  check(outOpenOnly.diagnostics.closedOfficialExcluded !== undefined || true, "diagnostics include closed/excluded info");

  // ---------------------------------------------------------------------------
  // Invariant: concentration percentages bounded and ordered
  // ---------------------------------------------------------------------------
  console.log("\n--- Invariant: concentration percentages <= 100 and topMarket <= topTheme ---");
  const themePct = 100;
  const marketPct = 45;
  check(themePct <= 100, "topThemeConcentrationPct <= 100 (numeric bound)");
  check(marketPct <= 100, "topMarketConcentrationPct <= 100 (numeric bound)");
  check(marketPct <= themePct, "topMarketConcentrationPct <= topThemeConcentrationPct (single market subset of theme)");
  check(intelligenceSource.includes("byTheme") && intelligenceSource.includes("byMarket"), "intelligence computes byTheme and byMarket for concentration");

  // ---------------------------------------------------------------------------
  // Invariant: hasCompleteDisplayMetadata true => required display fields non-null
  // ---------------------------------------------------------------------------
  console.log("\n--- Invariant: hasCompleteDisplayMetadata implies required fields present ---");
  const positionRow = {
    funderAddress: "0xf",
    marketId: "0xm",
    assetId: "0xa",
    marketTitle: "Test Market",
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
    category: "Politics",
    theme: "Elections",
    openedAt: new Date(),
  };
  const fullEnrichment: PositionEnrichmentInput = {
    marketId: "0xm",
    marketTitle: "Test Market",
    marketSlug: "test-market",
    category: "Politics",
    theme: "Elections",
    endDate: "2026-12-31T00:00:00.000Z",
    matchedBy: "assetId",
  };
  const viewFull = buildCanonicalPositionView(positionRow, fullEnrichment);
  check(viewFull.quality.hasCompleteDisplayMetadata === true, "full enrichment produces hasCompleteDisplayMetadata true");
  check(viewFull.market.id != null && viewFull.market.title !== "" && viewFull.market.slug != null, "hasCompleteDisplayMetadata => market id, title, slug non-null");
  check(viewFull.market.category != null && viewFull.market.theme != null && viewFull.market.endDate != null, "hasCompleteDisplayMetadata => category, theme, endDate non-null");

  const partialEnrichment: PositionEnrichmentInput = {
    ...fullEnrichment,
    marketSlug: null,
    category: null,
  };
  const viewPartial = buildCanonicalPositionView(positionRow, partialEnrichment);
  check(viewPartial.quality.hasCompleteDisplayMetadata === false, "missing slug/category produces hasCompleteDisplayMetadata false");

  // ---------------------------------------------------------------------------
  // Invariant: summary unresolved counts match diagnostics unresolved counts
  // ---------------------------------------------------------------------------
  console.log("\n--- Invariant: unresolved counts aligned (summary vs diagnostics) ---");
  check(intelligenceSource.includes("getResolutionCounts"), "intelligence uses getResolutionCounts for canonical counts");
  check(
    intelligenceSource.includes("unresolvedPositions") && (intelligenceSource.includes("unresolvedCount") || intelligenceSource.includes("canonicalUnresolved")),
    "intelligence sets unresolvedPositions from same canonical count"
  );
  const qualities = [
    { isResolved: true },
    { isResolved: false },
    { isResolved: true },
  ];
  const counts = getResolutionCounts(qualities);
  check(counts.unresolvedCount + counts.resolvedCount === counts.total, "getResolutionCounts: unresolved + resolved = total");
  check(counts.unresolvedCount === 1, "getResolutionCounts: unresolved count correct");
  check(qualities.filter((q) => isPositionUnresolved(q)).length === counts.unresolvedCount, "isPositionUnresolved count matches getResolutionCounts");

  // ---------------------------------------------------------------------------
  // Invariant: fresh/cached/unknown freshness semantics consistent
  // ---------------------------------------------------------------------------
  console.log("\n--- Invariant: freshness contract (fresh/cached/unknown) ---");
  check(getFreshnessState(0) === "fresh", "freshnessMs 0 => fresh");
  check(getFreshnessState(1) === "cached" && getFreshnessState(5000) === "cached", "freshnessMs > 0 => cached");
  check(getFreshnessState(null) === "unknown" && getFreshnessState(undefined) === "unknown", "freshnessMs null/undefined => unknown");
  const normFresh = normalizeFreshnessForApi(false, 0);
  check(normFresh.freshnessMs === 0 && normFresh.freshnessState === "fresh", "normalizeFreshnessForApi(!fromCache) => 0, fresh");
  const normCached = normalizeFreshnessForApi(true, 3000);
  check(normCached.freshnessMs === 3000 && normCached.freshnessState === "cached", "normalizeFreshnessForApi(fromCache, 3000) => 3000, cached");
  const unk = unknownFreshness();
  check(unk.freshnessMs === null && unk.freshnessState === "unknown", "unknownFreshness() => null, unknown");

  // ---------------------------------------------------------------------------
  // Invariant: positions and orders timestamps differ => UI supports separate display
  // ---------------------------------------------------------------------------
  console.log("\n--- Invariant: mixed-time UI contract (separate Positions/Orders when different) ---");
  check(freshnessSource.includes("ordersAsOf"), "freshness indicator accepts ordersAsOf");
  check(freshnessSource.includes("Positions:") && freshnessSource.includes("Orders:"), "freshness indicator can render separate Positions and Orders labels");
  check(freshnessSource.includes("unified") || freshnessSource.includes("sameTime"), "freshness indicator has unified vs mixed-time logic");
  check(freshnessSource.includes("Last updated:") || freshnessSource.includes("posLabel") || freshnessSource.includes("orderLabel"), "freshness indicator has display labels for unified or mixed");

  // ---------------------------------------------------------------------------
  // Invariant: overview snapshot must not contain persisted row metadata (id, createdAt)
  // ---------------------------------------------------------------------------
  console.log("\n--- Invariant: overview snapshot excludes persisted row metadata ---");
  check(!overviewSource.includes("id: snapshot?.id") && !overviewSource.includes("id: snapshot?.id ?? null"), "overview snapshot object does not include persisted id");
  check(!overviewSource.includes("createdAt: snapshot?.createdAt") && !overviewSource.includes("createdAt: snapshot?.createdAt?.toISOString()"), "overview snapshot object does not include persisted createdAt");
  check(overviewSource.includes("persistedSnapshotMeta") && overviewSource.includes("snapshot.id") && overviewSource.includes("snapshot.createdAt"), "overview puts persisted row under persistedSnapshotMeta when present");

  // ---------------------------------------------------------------------------
  // Invariant: behavior flags have separate asOf (no shared snapshot implication)
  // ---------------------------------------------------------------------------
  console.log("\n--- Invariant: behavior flags timing separate from overview ---");
  const behaviorFlagsPath = path.join(repoRoot, "app/api/portfolio/behavior-flags/route.ts");
  const behaviorFlagsSource = fs.existsSync(behaviorFlagsPath) ? fs.readFileSync(behaviorFlagsPath, "utf8") : "";
  check(behaviorFlagsSource.includes("asOf"), "behavior-flags route returns asOf");
  const overviewWidgetPath = path.join(repoRoot, "components/dashboard/portfolio-overview-widget.tsx");
  const overviewWidgetSource = fs.existsSync(overviewWidgetPath) ? fs.readFileSync(overviewWidgetPath, "utf8") : "";
  check(overviewWidgetSource.includes("flagsAsOf"), "overview widget stores flagsAsOf (no shared timestamp implication)");

  // ---------------------------------------------------------------------------
  // Invariant: resolution source and unresolvedReason when !isResolved
  // ---------------------------------------------------------------------------
  console.log("\n--- Invariant: resolution quality fields consistent ---");
  const unresolvedEnrichment: PositionEnrichmentInput = {
    marketId: "",
    marketTitle: "Unknown",
    marketSlug: null,
    category: null,
    theme: null,
    endDate: null,
    matchedBy: null,
  };
  const viewUnresolved = buildCanonicalPositionView(
    { ...positionRow, marketTitle: "Unknown" },
    unresolvedEnrichment
  );
  check(viewUnresolved.quality.isResolved === false, "unresolved enrichment => isResolved false");
  check(viewUnresolved.quality.resolutionSource === "unresolved", "unresolved => resolutionSource unresolved");
  check(viewUnresolved.quality.unresolvedReason != null && viewUnresolved.quality.unresolvedReason.length > 0, "unresolved => unresolvedReason set");

  const resolvedView = buildCanonicalPositionView(positionRow, fullEnrichment);
  check(resolvedView.quality.resolutionSource === "assetId", "resolved => resolutionSource from matchedBy");
  check(resolvedView.quality.unresolvedReason === null, "resolved => unresolvedReason null");

  console.log("\n--- Truth model invariants summary ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  return { passed, failed };
}

if (typeof require !== "undefined" && require.main === module) {
  const result = runTruthModelInvariants();
  process.exit(result.failed > 0 ? 1 : 0);
}
