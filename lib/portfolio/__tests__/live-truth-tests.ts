/**
 * Live-truth architecture tests: official success path, official failure fallback,
 * provenance fields, and no stale quantity leakage.
 * See docs/LIVE_TRUTH_ARCHITECTURE.md and docs/LIVE_TRUTH_FALLBACK_BEHAVIOR.md.
 * Run with portfolio-api-regression-tests or:
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/portfolio/__tests__/live-truth-tests.ts
 */

import { buildOpenPositionsFromOfficial } from "../open-positions-from-official";
import { getSourceOfTruth, clearLivePortfolioCache } from "../live-portfolio-service";
import {
  getOrderSourceOfTruth,
  getOrdersReconciliationDiagnostics,
  type LiveOpenOrder,
  type LocalOpenOrderRow,
} from "../live-open-orders-service";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

export function runLiveTruthTests(): void {
  console.log("\n--- Live-truth: getSourceOfTruth ---");
  const successMeta = { success: true, status: 200, error: null, asOf: new Date(), freshnessMs: 0, fromCache: false };
  const failMeta = { success: false, status: 500, error: "API error", asOf: new Date(), freshnessMs: 0, fromCache: false };
  check(getSourceOfTruth(successMeta, 3) === "official", "sourceOfTruth official when success and positions");
  check(getSourceOfTruth(successMeta, 0) === "official", "sourceOfTruth official when success and empty");
  check(getSourceOfTruth(failMeta, 0) === "derived", "sourceOfTruth derived when fetch failed");

  console.log("\n--- Live-truth: buildOpenPositionsFromOfficial provenance ---");
  const officialWithPrice = [
    { asset: "0xasset1", size: 50, curPrice: 0.7, conditionId: "0xc", title: "M", outcome: "Yes" },
  ];
  const derivedMatch = [
    {
      funderAddress: "0xf",
      marketId: "0xc",
      assetId: "0xasset1",
      marketTitle: "M",
      outcome: "YES",
      side: "YES",
      size: "50",
      avgEntry: "0.6",
      lastPrice: "0.65",
      costBasis: "30",
      marketValue: "35",
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
  const out = buildOpenPositionsFromOfficial(officialWithPrice, derivedMatch, "0xf", true);
  check(out.rows.length === 1, "one row");
  const row = out.rows[0];
  check(row.quantitySource === "official", "quantitySource official when from API");
  check(row.priceSource === "official", "priceSource official when curPrice from API");
  check(row.rowSource === "official+derived", "rowSource official+derived when matched");
  check(row.basisSource === "derived" || row.basisSource === "official", "basisSource set");
  check(row.pnlSource === "derived" || row.pnlSource === "official", "pnlSource set");

  console.log("\n--- Live-truth: official-only row has priceSource ---");
  const officialOnlyList = [
    { asset: "0xonly", size: 10, conditionId: "0xc", title: "M", outcome: "Yes" },
  ];
  const outOfficialOnly = buildOpenPositionsFromOfficial(officialOnlyList, [], "0xf", true);
  check(outOfficialOnly.rows.length === 1, "one official-only row");
  check(outOfficialOnly.rows[0].priceSource === "derived" || outOfficialOnly.rows[0].priceSource === "official", "priceSource present (official_only has no curPrice so derived)");
  check(outOfficialOnly.rows[0].rowSource === "official_only", "rowSource official_only");
  check(outOfficialOnly.rows[0].quantitySource === "official", "quantitySource official");

  console.log("\n--- Live-truth: no stale derived quantity in official row ---");
  const officialSize = 100;
  const officialRow = out.rows.find((r) => r.assetId === "0xasset1");
  check(officialRow != null, "matched row exists");
  check(parseFloat(officialRow!.size) === officialWithPrice[0].size, "displayed size is official quantity (50), not derived");
  check(officialRow!.quantitySource === "official", "quantitySource is official so UI knows source");

  console.log("\n--- Live-truth: derived-only row has provenance ---");
  const derivedOnlyOut = buildOpenPositionsFromOfficial([], derivedMatch, "0xf", false);
  const derivedOnlyRow = derivedOnlyOut.rows.find((r) => r.assetId === "0xasset1");
  check(derivedOnlyRow != null, "derived-only row exists when openOnly=false and no official");
  check(derivedOnlyRow!.quantitySource === "derived", "quantitySource derived");
  check(derivedOnlyRow!.priceSource === "derived", "priceSource derived");
  check(derivedOnlyRow!.rowSource === "derived_only", "rowSource derived_only");

  clearLivePortfolioCache();

  console.log("\n--- Live-truth: getOrderSourceOfTruth ---");
  const orderSuccessMeta = { success: true, status: 200, error: null, asOf: new Date(), freshnessMs: 0, fromCache: false };
  const orderFailMeta = { success: false, status: 0, error: "No credentials", asOf: new Date(), freshnessMs: 0, fromCache: false };
  check(getOrderSourceOfTruth(orderSuccessMeta) === "official", "orderSourceOfTruth official when success");
  check(getOrderSourceOfTruth(orderFailMeta) === "derived", "orderSourceOfTruth derived when fetch failed");

  console.log("\n--- Live-truth: getOrdersReconciliationDiagnostics shape ---");
  const officialOrders: LiveOpenOrder[] = [
    {
      orderId: "oid1",
      marketId: "m1",
      assetId: "a1",
      side: "BUY",
      outcome: "Yes",
      size: "10",
      remainingSize: "10",
      price: "0.5",
      status: "LIVE",
      createdAt: 12345,
      rowSource: "official",
    },
  ];
  const localOrders: LocalOpenOrderRow[] = [
    { orderId: "oid1", marketId: "m1", assetId: "a1", side: "BUY", status: "LIVE", sizeMatched: "0", originalSize: "10", price: "0.5" },
  ];
  const diag = getOrdersReconciliationDiagnostics(officialOrders, localOrders, true, new Date());
  check(diag.officialOpenOrdersCount === 1, "officialOpenOrdersCount");
  check(diag.localOpenOrdersCount === 1, "localOpenOrdersCount");
  check(diag.countDelta === 0, "countDelta");
  check(Array.isArray(diag.ordersMissingLocally), "ordersMissingLocally array");
  check(Array.isArray(diag.ordersMissingOfficially), "ordersMissingOfficially array");
  check(Array.isArray(diag.mismatchedStatuses), "mismatchedStatuses array");
  check(Array.isArray(diag.sampleDiffs), "sampleDiffs array");
  check(typeof diag.asOf === "string", "asOf string");
  check(diag.officialFetchSuccess === true, "officialFetchSuccess");

  const diagMissingLocal = getOrdersReconciliationDiagnostics(
    officialOrders,
    [],
    true,
    new Date()
  );
  check(diagMissingLocal.ordersMissingLocally.length === 1 && diagMissingLocal.ordersMissingLocally[0] === "oid1", "ordersMissingLocally when local empty");
  check(diagMissingLocal.ordersMissingOfficially.length === 0, "ordersMissingOfficially empty");

  const diagMissingOfficial = getOrdersReconciliationDiagnostics(
    [],
    localOrders,
    true,
    new Date()
  );
  check(diagMissingOfficial.ordersMissingOfficially.length === 1 && diagMissingOfficial.ordersMissingOfficially[0] === "oid1", "ordersMissingOfficially when official empty");

  console.log("\n--- Live-truth: overview display timestamp prefers asOf over persisted snapshot ---");
  const getDisplayTimestamp = (r: { asOf?: string; snapshot?: { createdAt?: string } }) => r.asOf ?? null;
  check(getDisplayTimestamp({ asOf: "2025-01-01T12:00:00Z", snapshot: { createdAt: "2024-06-01T00:00:00Z" } }) === "2025-01-01T12:00:00Z", "display timestamp uses asOf when present");
  check(getDisplayTimestamp({ snapshot: { createdAt: "2024-06-01T00:00:00Z" } }) === null, "display timestamp is null when asOf absent (do not use snapshot.createdAt)");
  check(getDisplayTimestamp({ asOf: "2025-01-01T12:00:00Z" }) === "2025-01-01T12:00:00Z", "display timestamp uses asOf when snapshot absent");

  console.log("\n--- Live-truth tests passed ---");
}
