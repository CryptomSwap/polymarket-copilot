/**
 * Regression tests: official curPrice and currentValue must propagate to merged row
 * lastPrice and marketValue when sourceOfTruth is official (no derived/cache override).
 * Run: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/portfolio/__tests__/official-mark-value-propagation.test.ts
 */

import type { OfficialPosition } from "@/lib/polymarket/official-positions";
import { buildOpenPositionsFromOfficial } from "../open-positions-from-official";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

/** $130 crude oil row: raw upstream curPrice 0.345, currentValue 444.538... */
const CRUDE_130: OfficialPosition = {
  asset: "11493408506991053005",
  conditionId: "0xcrude130",
  size: 1288.518649,
  avgPrice: 0.416107,
  curPrice: 0.345,
  currentValue: 444.53893390499996,
  title: "Will Crude Oil (CL) hit (HIGH) $130 by end of March?",
  outcome: "Yes",
  endDate: "2026-03-31T00:00:00.000Z",
  redeemable: false,
};

/** $120 row: curPrice 0.55, currentValue 327.252761 */
const CRUDE_120: OfficialPosition = {
  asset: "69136365945621600854",
  conditionId: "0xcrude120",
  size: 595.00502,
  avgPrice: 0.589932,
  curPrice: 0.55,
  currentValue: 327.252761,
  title: "Will Crude Oil (CL) hit (HIGH) $120 by end of March?",
  outcome: "Yes",
  endDate: "2026-03-31T00:00:00.000Z",
  redeemable: false,
};

/** Official has currentValue but no valid basis (no initialValue, avgPrice out of range): getOfficialBasisIfSane returns null. */
const OFFICIAL_VALUE_NO_BASIS: OfficialPosition = {
  asset: "0xnoBasis",
  conditionId: "0xc",
  size: 100,
  avgPrice: 1.5,
  initialValue: undefined,
  curPrice: 0.4,
  currentValue: 40,
  title: "Market",
  outcome: "Yes",
  redeemable: false,
};

export function runOfficialMarkValuePropagationTests(): void {
  console.log("\n--- Official mark/currentValue propagation ---");

  const out130 = buildOpenPositionsFromOfficial([CRUDE_130], [], "0xf", true);
  check(out130.rows.length === 1, "one row $130");
  const row130 = out130.rows[0];
  check(row130.lastPrice === "0.345", "lastPrice from official curPrice ($130 row)");
  check(
    Math.abs(parseFloat(row130.marketValue) - 444.53893390499996) < 1e-6,
    "marketValue from official currentValue ($130 row)"
  );
  check(row130.priceSource === "official", "priceSource official when curPrice present");

  const out120 = buildOpenPositionsFromOfficial([CRUDE_120], [], "0xf", true);
  check(out120.rows.length === 1, "one row $120");
  check(out120.rows[0].lastPrice === "0.55", "lastPrice from official curPrice ($120 row)");
  check(
    Math.abs(parseFloat(out120.rows[0].marketValue) - 327.252761) < 1e-6,
    "marketValue from official currentValue ($120 row)"
  );

  const outNoBasis = buildOpenPositionsFromOfficial([OFFICIAL_VALUE_NO_BASIS], [], "0xf", true);
  check(outNoBasis.rows.length === 1, "one row when official has value but no sane basis");
  check(outNoBasis.rows[0].lastPrice === "0.4", "lastPrice from official curPrice when basis null");
  check(
    parseFloat(outNoBasis.rows[0].marketValue) === 40,
    "marketValue from raw official currentValue when getOfficialBasisIfSane returns null"
  );

  const allCrude = buildOpenPositionsFromOfficial(
    [CRUDE_130, CRUDE_120],
    [],
    "0xf",
    true
  );
  check(allCrude.rows.length === 2, "two crude rows");
  const byAsset = new Map(allCrude.rows.map((r) => [r.assetId, r]));
  check(byAsset.get(CRUDE_130.asset)!.lastPrice === "0.345", "$130 row lastPrice 0.345");
  check(byAsset.get(CRUDE_130.asset)!.marketValue === "444.53893390499996", "$130 row marketValue exact");
  check(byAsset.get(CRUDE_120.asset)!.lastPrice === "0.55", "$120 row lastPrice 0.55");
  check(Math.abs(parseFloat(byAsset.get(CRUDE_120.asset)!.marketValue) - 327.252761) < 1e-6, "$120 row marketValue");

  // Verification-bundle values: upstream curPrice 0.38, currentValue 489.63708662 must propagate (no derived override)
  const CRUDE_130_VERIFICATION: OfficialPosition = {
    ...CRUDE_130,
    asset: "11493408506991053005001467740252564391469635719348506396067415301658723204334",
    curPrice: 0.38,
    currentValue: 489.63708662,
  };
  const outVerification = buildOpenPositionsFromOfficial([CRUDE_130_VERIFICATION], [], "0xf", true);
  check(outVerification.rows.length === 1, "one row $130 verification");
  check(outVerification.rows[0].lastPrice === "0.38", "lastPrice preserved from upstream 0.38");
  check(
    Math.abs(parseFloat(outVerification.rows[0].marketValue) - 489.63708662) < 1e-6,
    "marketValue preserved from upstream 489.63708662"
  );
  check(outVerification.rows[0].priceSource === "official", "priceSource official when upstream has curPrice");

  // When API returns curPrice/currentValue as strings, we still use them (do not fall back to derived)
  const CRUDE_130_STRING_API = {
    ...CRUDE_130,
    asset: "11493408506991053005001467740252564391469635719348506396067415301658723204334",
    curPrice: "0.38" as unknown as number,
    currentValue: "489.63708662" as unknown as number,
  } as OfficialPosition;
  const derivedWithStalePrice = {
    assetId: "11493408506991053005001467740252564391469635719348506396067415301658723204334",
    funderAddress: "0xf",
    marketId: "0xm",
    marketTitle: "Will Crude Oil (CL) hit (HIGH) $130 by end of March?",
    outcome: "Yes",
    side: "YES",
    size: "1288.518649",
    lastPrice: "0.29",
    avgEntry: "0.416107",
    costBasis: "536.16",
    marketValue: "373.67040821",
    unrealizedPnl: "-162.49",
    realizedPnl: "0",
    reservedOrderSize: "0",
    reservedOrderValue: "0",
    category: null,
    theme: null,
    openedAt: new Date(),
    syncedMarket: null,
  } as Parameters<typeof buildOpenPositionsFromOfficial>[1][number];
  const outWithDerived = buildOpenPositionsFromOfficial(
    [CRUDE_130_STRING_API],
    [derivedWithStalePrice],
    "0xf",
    true
  );
  check(outWithDerived.rows.length === 1, "one row when official has string curPrice and derived present");
  check(
    outWithDerived.rows[0].lastPrice === "0.38",
    "lastPrice from official when API sent string 0.38 (not derived 0.29)"
  );
  check(
    Math.abs(parseFloat(outWithDerived.rows[0].marketValue) - 489.63708662) < 1e-6,
    "marketValue from official when API sent string (not derived)"
  );

  console.log("\n--- Official mark/currentValue propagation tests passed ---");
}
