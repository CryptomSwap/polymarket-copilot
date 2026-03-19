/**
 * Tests for dashboard summary strip: payload shape, aggregation, and data sources.
 * getDashboardSummaryStrip() composes intelligence, open orders, and alert feed; read-only.
 * Run: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/dashboard/__tests__/summary-strip.test.ts
 */

import { getDashboardSummaryStrip, type SummaryStripPayload } from "../summary-strip";

function hasSummaryStripShape(p: unknown): p is SummaryStripPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.openPositionsCount === "number" &&
    typeof o.openOrdersCount === "number" &&
    (o.topThemeConcentrationPct === null || typeof o.topThemeConcentrationPct === "number") &&
    (o.topMarketConcentrationPct === null || typeof o.topMarketConcentrationPct === "number") &&
    typeof o.unresolvedPositionsCount === "number" &&
    typeof o.activeAlertsCount === "number" &&
    typeof o.hasHighSeverityAlert === "boolean" &&
    (o.portfolioAsOf === null || typeof o.portfolioAsOf === "string") &&
    (o.portfolioFreshnessMs === null || typeof o.portfolioFreshnessMs === "number") &&
    (o.ordersAsOf === null || typeof o.ordersAsOf === "string")
  );
}

export async function runSummaryStripTests(): Promise<{ passed: number; failed: number }> {
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

  const testFunder = "0x0000000000000000000000000000000000000001";

  console.log("\n--- getDashboardSummaryStrip: returns valid payload ---");
  const payload = await getDashboardSummaryStrip(testFunder);
  check(hasSummaryStripShape(payload), "payload has required summary strip shape");
  check(payload.openPositionsCount >= 0, "openPositionsCount is non-negative");
  check(payload.openOrdersCount >= 0, "openOrdersCount is non-negative");
  check(payload.unresolvedPositionsCount >= 0, "unresolvedPositionsCount is non-negative");
  check(payload.activeAlertsCount >= 0, "activeAlertsCount is non-negative");

  console.log("\n--- getDashboardSummaryStrip: concentration bounds ---");
  if (payload.topThemeConcentrationPct != null) {
    check(
      payload.topThemeConcentrationPct >= 0 && payload.topThemeConcentrationPct <= 100,
      "topThemeConcentrationPct in 0–100"
    );
  }
  if (payload.topMarketConcentrationPct != null) {
    check(
      payload.topMarketConcentrationPct >= 0 && payload.topMarketConcentrationPct <= 100,
      "topMarketConcentrationPct in 0–100"
    );
  }

  console.log("\n--- getDashboardSummaryStrip: high severity consistent with count ---");
  if (payload.activeAlertsCount === 0) {
    check(payload.hasHighSeverityAlert === false, "no alerts implies no high severity");
  }

  console.log("\n--- getDashboardSummaryStrip: mixed-time fields present when applicable ---");
  check(
    typeof payload.portfolioSourceOfTruth === "string" || payload.portfolioSourceOfTruth === null,
    "portfolioSourceOfTruth is string or null"
  );
  check(
    typeof payload.orderSourceOfTruth === "string" || payload.orderSourceOfTruth === null,
    "orderSourceOfTruth is string or null"
  );

  console.log("\n--- Summary strip tests result ---");
  console.log(`  Passed: ${passed}, Failed: ${failed}`);
  return { passed, failed };
}

if (require.main === module) {
  runSummaryStripTests()
    .then(({ failed }) => process.exit(failed > 0 ? 1 : 0))
    .catch((err) => {
      console.error("Summary strip tests error:", err);
      process.exit(1);
    });
}
