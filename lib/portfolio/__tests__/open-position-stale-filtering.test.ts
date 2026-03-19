/**
 * Regression tests for open-position stale/resolved filtering.
 * Ensures March 6–style stale rows are excluded, normal open rows remain, redeemable excluded.
 * Run: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/portfolio/__tests__/open-position-stale-filtering.test.ts
 */

import type { OfficialPosition } from "@/lib/polymarket/official-positions";
import { isOfficialPositionStaleResolved } from "@/lib/polymarket/official-positions";
import { buildOpenPositionsFromOfficial } from "../open-positions-from-official";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

/** March 6 style row from forensic dump: curPrice 0, currentValue 0, redeemable true, endDate "", past-dated title */
const MARCH_6_STALE_ROW: OfficialPosition = {
  asset: "33057885673059385790",
  conditionId: "0xabc",
  size: 103.578092,
  avgPrice: 0.154491,
  curPrice: 0,
  currentValue: 0,
  title: "Will Iran strike Israel on March 6?",
  outcome: "Yes",
  endDate: "",
  redeemable: true,
};

/** Normal open crude oil row: non-zero price and value, future endDate */
const CRUDE_OIL_OPEN_ROW: OfficialPosition = {
  asset: "11493408506991053005",
  conditionId: "0xcrude",
  size: 1288.518649,
  avgPrice: 0.416107,
  curPrice: 0.29,
  currentValue: 373.67040821,
  title: "Will Crude Oil (CL) hit (HIGH) $130 by end of March?",
  outcome: "Yes",
  endDate: "2026-03-31T00:00:00.000Z",
  redeemable: false,
};

/** Redeemable row (resolved market): should be excluded regardless of price */
const REDEEMABLE_ROW: OfficialPosition = {
  asset: "99999999999999999999",
  conditionId: "0xred",
  size: 50,
  curPrice: 0.5,
  currentValue: 25,
  title: "Some resolved market",
  outcome: "Yes",
  endDate: "2025-01-15T00:00:00.000Z",
  redeemable: true,
};

/** Zero price but future-dated title and endDate: should NOT be excluded (legitimate open) */
const ZERO_PRICE_FUTURE_ROW: OfficialPosition = {
  asset: "88888888888888888888",
  conditionId: "0xfut",
  size: 100,
  curPrice: 0,
  currentValue: 0,
  title: "Will X happen by December 31, 2026?",
  outcome: "Yes",
  endDate: "2026-12-31T00:00:00.000Z",
  redeemable: false,
};

export function runOpenPositionStaleFilteringTests(): void {
  console.log("\n--- Stale filter: isOfficialPositionStaleResolved ---");

  const march6Check = isOfficialPositionStaleResolved(MARCH_6_STALE_ROW);
  check(march6Check.exclude === true, "March 6 style row is excluded");
  check(
    Boolean(
      march6Check.reason === "redeemable" || march6Check.reason?.includes("zero_value") || march6Check.reason?.includes("past_dated")
    ),
    "March 6 row has a stale reason (redeemable or zero_value_blank_endDate_past_dated_title)"
  );

  const crudeCheck = isOfficialPositionStaleResolved(CRUDE_OIL_OPEN_ROW);
  check(crudeCheck.exclude === false, "Normal crude oil open row is NOT excluded");
  check(crudeCheck.reason === null, "Crude oil row has no reason");

  const redeemableCheck = isOfficialPositionStaleResolved(REDEEMABLE_ROW);
  check(redeemableCheck.exclude === true, "Redeemable row is excluded");
  check(redeemableCheck.reason === "redeemable", "Redeemable reason is redeemable");

  const zeroFutureCheck = isOfficialPositionStaleResolved(ZERO_PRICE_FUTURE_ROW);
  check(zeroFutureCheck.exclude === false, "Zero price but future-dated row is NOT excluded (no blank endDate, title future)");

  console.log("\n--- Stale filter: buildOpenPositionsFromOfficial excludes March 6 row ---");

  const officialList: OfficialPosition[] = [
    MARCH_6_STALE_ROW,
    CRUDE_OIL_OPEN_ROW,
    REDEEMABLE_ROW,
  ];
  const out = buildOpenPositionsFromOfficial(officialList, [], "0xfunder", true);

  check(out.rows.length === 1, "Only one row remains (crude oil); March 6 and redeemable excluded");
  check(out.rows[0].assetId === CRUDE_OIL_OPEN_ROW.asset, "Remaining row is the crude oil row");

  check(out.diagnostics.staleOfficialExcluded === 2, "staleOfficialExcluded count is 2 (March 6 + redeemable)");
  check(
    out.diagnostics.excludedStaleOfficialRows.length >= 1,
    "excludedStaleOfficialRows sample has at least one entry"
  );
  const march6Excluded = out.diagnostics.excludedStaleOfficialRows.find(
    (r) => r.assetId === MARCH_6_STALE_ROW.asset || r.marketTitle?.includes("March 6")
  );
  check(march6Excluded != null, "March 6 row appears in excludedStaleOfficialRows");
  check(
    march6Excluded!.reason === "redeemable" || march6Excluded!.reason?.includes("zero_value") || march6Excluded!.reason?.includes("past_dated"),
    "March 6 excluded reason is redeemable or zero_value/past_dated"
  );

  console.log("\n--- Stale filter: normal open crude oil rows remain included ---");

  const onlyCrude = buildOpenPositionsFromOfficial([CRUDE_OIL_OPEN_ROW], [], "0xf", true);
  check(onlyCrude.rows.length === 1, "Single crude oil row remains included");
  check(onlyCrude.diagnostics.staleOfficialExcluded === 0, "No stale excluded when only open crude");
  check(parseFloat(onlyCrude.rows[0].marketValue) > 0, "Crude row has positive market value");

  console.log("\n--- Stale filter: closed/redeemable row excluded ---");

  const withRedeemable = buildOpenPositionsFromOfficial([CRUDE_OIL_OPEN_ROW, REDEEMABLE_ROW], [], "0xf", true);
  check(withRedeemable.rows.length === 1, "Redeemable row excluded, only crude remains");
  check(withRedeemable.diagnostics.staleOfficialExcluded === 1, "One stale excluded (redeemable)");
  const redeemableInExcluded = withRedeemable.diagnostics.excludedStaleOfficialRows.find(
    (r) => r.assetId === REDEEMABLE_ROW.asset || r.reason === "redeemable"
  );
  check(Boolean(redeemableInExcluded) && redeemableInExcluded!.reason === "redeemable", "Redeemable row in excluded with reason redeemable");

  console.log("\n--- Open-position stale filtering tests passed ---");
}
