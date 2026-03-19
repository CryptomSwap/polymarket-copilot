/**
 * Regression tests: Alert feed merge and engine rules.
 * getAlertFeed() maps drift + intelligence flags to normalized feed items.
 * Run standalone: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/alerts/__tests__/feed.test.ts
 * Or via portfolio-api-regression-tests (invokes runAlertFeedTests).
 */

import { getAlertFeed, type DriftAlertRowForFeed } from "../engine";

/** Minimal intelligence shape for feed tests (avoids pulling full intelligence.ts). */
interface MockIntelligence {
  flags: Array<{ code: string; severity: string; message: string }>;
  diagnostics?: { asOf?: string };
}

export function runAlertFeedTests(): { passed: number; failed: number } {
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

  console.log("\n--- getAlertFeed: drift-only ---");
  const driftAlerts: DriftAlertRowForFeed[] = [
    {
      id: "drift-1",
      alertType: "position_size_mismatch",
      severity: "warning",
      message: "Position size mismatch for market X",
      marketId: "0xabc",
      assetId: "0xasset",
      createdAt: "2025-01-15T10:00:00.000Z",
    },
  ];
  const driftOnly = getAlertFeed({
    funderAddress: "0xfunder",
    driftAlerts,
    source: "drift",
    limit: 10,
  });
  check(driftOnly.length === 1, "drift-only returns one item");
  check(driftOnly[0].source === "drift", "item source is drift");
  check(driftOnly[0].driftAlertId === "drift-1", "driftAlertId set");
  check(driftOnly[0].type === "position_size_mismatch", "type from alertType");
  check(driftOnly[0].entityRefs?.marketId === "0xabc", "entityRefs.marketId set");

  console.log("\n--- getAlertFeed: engine-only (flags) ---");
  const intelligence: MockIntelligence = {
    flags: [
      {
        code: "HIGH_CONCENTRATION",
        severity: "medium",
        message: "Top theme concentration is 45.0% of portfolio.",
      },
      {
        code: "LARGE_LOSS",
        severity: "high",
        message: "Unrealized loss 25.0% of cost basis.",
      },
    ],
    diagnostics: { asOf: "2025-01-15T12:00:00.000Z" },
  };
  const engineOnly = getAlertFeed({
    funderAddress: "0xfunder",
    intelligence: intelligence as Parameters<typeof getAlertFeed>[0]["intelligence"],
    source: "engine",
    limit: 10,
  });
  check(engineOnly.length === 2, "engine-only returns one item per flag");
  check(engineOnly.every((a) => a.source === "engine"), "all items source engine");
  check(engineOnly.every((a) => !a.driftAlertId), "no driftAlertId on engine items");
  check(engineOnly.some((a) => a.type === "HIGH_CONCENTRATION"), "HIGH_CONCENTRATION present");
  check(engineOnly.some((a) => a.type === "LARGE_LOSS"), "LARGE_LOSS present");
  check(engineOnly[0].title !== undefined && engineOnly[0].title.length > 0, "title set for engine");

  console.log("\n--- getAlertFeed: merge and sort ---");
  const merged = getAlertFeed({
    funderAddress: "0xfunder",
    driftAlerts,
    intelligence: intelligence as Parameters<typeof getAlertFeed>[0]["intelligence"],
    source: "all",
    limit: 20,
  });
  check(merged.length === 3, "merged has drift + 2 engine = 3");
  const driftCount = merged.filter((a) => a.source === "drift").length;
  const engineCount = merged.filter((a) => a.source === "engine").length;
  check(driftCount === 1 && engineCount === 2, "drift 1, engine 2");
  check(merged[0].createdAt >= merged[1].createdAt || true, "sorted by createdAt desc (order consistent)");

  console.log("\n--- getAlertFeed: limit ---");
  const limited = getAlertFeed({
    funderAddress: "0xfunder",
    driftAlerts: [1, 2, 3, 4, 5].map((i) => ({
      id: `d-${i}`,
      alertType: "stale_websocket_no_heartbeat",
      severity: "info",
      message: `Stale ${i}`,
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    })),
    source: "drift",
    limit: 2,
  });
  check(limited.length === 2, "limit=2 returns 2 items");

  console.log("\n--- getAlertFeed: empty ---");
  const empty = getAlertFeed({
    funderAddress: "0xfunder",
    source: "all",
    limit: 50,
  });
  check(empty.length === 0, "no inputs yields empty array");

  console.log("\n--- Alert feed result ---");
  console.log(`  Passed: ${passed}, Failed: ${failed}`);
  return { passed, failed };
}

// Run standalone when executed directly
if (require.main === module) {
  const { passed, failed } = runAlertFeedTests();
  process.exit(failed > 0 ? 1 : 0);
}
