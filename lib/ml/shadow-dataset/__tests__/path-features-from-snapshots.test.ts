/**
 * Path/regime feature computation: truthful pre-decision series, no forward leakage.
 */

import {
  computePathRegimeFeaturesFromPreDecisionPoints,
  filterPreDecisionPoints,
  mergePathFeaturesIntoUpdate,
  priceAtOrBefore,
  type SnapshotPoint,
} from "../path-features-from-snapshots";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function ptAt(decisionAt: Date, msOffsetFromDecision: number, price: number, liquidity = 100): SnapshotPoint {
  return {
    capturedAt: new Date(decisionAt.getTime() + msOffsetFromDecision),
    price,
    liquidity,
    volume: 0,
  };
}

function run(): void {
  const decisionAt = new Date(Date.parse("2024-01-01T15:00:00.000Z"));
  const tEnd = decisionAt.getTime();

  // 1) Forward-only points must not affect features (cross-horizon contamination)
  // Only snapshot in (decision−1h, decision]: no anchor at/before T−1h → momentum1h must stay null
  const withFuture: SnapshotPoint[] = [
    ptAt(decisionAt, -30 * 60 * 1000, 0.4, 100),
    ptAt(decisionAt, 2 * 3600 * 1000, 0.99, 9999), // +2h after decision — must be excluded from path
  ];
  const preOnly = filterPreDecisionPoints(withFuture, decisionAt);
  check(preOnly.length === 1 && preOnly[0]!.price === 0.4, "forward snapshot excluded from pre-decision set");

  const f1 = computePathRegimeFeaturesFromPreDecisionPoints(preOnly, decisionAt, {
    marketEndDate: new Date(tEnd + 48 * 3600 * 1000),
    intendedPriceFallback: null,
  });
  check(
    f1.distanceFromMid != null && Math.abs(parseFloat(f1.distanceFromMid) - 0.1) < 1e-9,
    "distanceFromMid uses pre-decision price only (~0.1)"
  );
  check(f1.momentum1hBps == null, "no 1h history → momentum null (not fake zero)");

  // 2) When 1h and 6h anchors exist, momentum is non-null; future spike ignored
  const history: SnapshotPoint[] = [
    ptAt(decisionAt, -7 * 3600 * 1000, 0.4, 80),
    ptAt(decisionAt, -6 * 3600 * 1000 - 60_000, 0.4, 80),
    ptAt(decisionAt, -3600 * 1000 - 60_000, 0.45, 90),
    ptAt(decisionAt, -60_000, 0.45, 90),
    ptAt(decisionAt, 0, 0.5, 100),
    ptAt(decisionAt, 6 * 3600 * 1000, 0.1, 10),
  ];
  const pre2 = filterPreDecisionPoints(history, decisionAt);
  const f2 = computePathRegimeFeaturesFromPreDecisionPoints(pre2, decisionAt, {
    marketEndDate: new Date(tEnd + 72 * 3600 * 1000),
  });
  check(f2.momentum1hBps != null, "with 1h anchor, momentum1h populated");
  check(f2.momentum6hBps != null, "with 6h anchor, momentum6h populated");
  check(parseFloat(f2.momentum1hBps!) > 0, "price rose into decision → positive 1h momentum");
  check(f2.volatility1hBps != null || f2.volatility6hBps != null, "some vol from range");

  // 3) priceAtOrBefore picks last point at or before target
  const series = [
    ptAt(decisionAt, -7200_000, 0.3),
    ptAt(decisionAt, -3600_000, 0.35),
    ptAt(decisionAt, 0, 0.5),
  ];
  check(priceAtOrBefore(series, decisionAt) === 0.5, "price at decision");

  // 4) mergePathFeaturesIntoUpdate does not clobber existing DB strings; fills nulls
  const computed = computePathRegimeFeaturesFromPreDecisionPoints(pre2, decisionAt, {});
  const computedOverwrite = { ...computed, momentum1hBps: "999" as string | null };
  const patch = mergePathFeaturesIntoUpdate(
    {
      momentum1hBps: "0.123",
      momentum6hBps: null,
      volatility1hBps: null,
      volatility6hBps: null,
      distanceFromMid: null,
      timeToCloseHours: null,
      liquidityTrend: null,
    },
    computedOverwrite
  );
  check(patch.momentum1hBps === undefined, "existing momentum1h preserved (no overwrite)");
  check(
    computed.momentum6hBps != null ? patch.momentum6hBps === computed.momentum6hBps : true,
    "fills previously null slot when computed available"
  );

  console.log("--- path-features-from-snapshots tests passed ---");
}

run();
