/**
 * Tests for portfolio timeline: item shape, merge/sort order, and source filtering.
 * getPortfolioTimeline() returns normalized TimelineItem[] from persisted sources.
 * Run: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/portfolio/__tests__/timeline.test.ts
 */

import { getPortfolioTimeline, type TimelineItem, type TimelineSourceFilter } from "../timeline";

const TIMELINE_SOURCES: TimelineSourceFilter[] = [
  "drift",
  "behavior",
  "recommendation",
  "execution",
  "reconciliation",
  "journal",
  "copilot",
];

function hasRequiredFields(item: unknown): item is TimelineItem {
  if (!item || typeof item !== "object") return false;
  const o = item as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.eventType === "string" &&
    typeof o.source === "string" &&
    typeof o.title === "string" &&
    typeof o.message === "string" &&
    (o.severity === null || typeof o.severity === "string") &&
    typeof o.entityRefs === "object" &&
    o.entityRefs !== null &&
    typeof o.createdAt === "string"
  );
}

export async function runTimelineTests(): Promise<{ passed: number; failed: number }> {
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

  console.log("\n--- getPortfolioTimeline: returns array ---");
  const all = await getPortfolioTimeline(testFunder, { limit: 10 });
  check(Array.isArray(all), "returns an array");
  check(all.length <= 10, "respects limit");

  console.log("\n--- getPortfolioTimeline: item shape ---");
  for (const item of all) {
    check(hasRequiredFields(item), "item has required fields (id, eventType, source, title, message, severity, entityRefs, createdAt)");
    check(TIMELINE_SOURCES.includes(item.source as TimelineSourceFilter), "source is one of allowed values");
    check(typeof (item.entityRefs as Record<string, unknown>) === "object", "entityRefs is object");
  }
  if (all.length > 0) {
    check(all.every((i) => i.eventType.length > 0), "eventType non-empty");
    check(all.every((i) => Number.isFinite(new Date(i.createdAt).getTime())), "createdAt is parseable date");
  }

  console.log("\n--- getPortfolioTimeline: sort order (newest first) ---");
  const sorted = [...all].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  check(
    all.length === sorted.length && all.every((e, i) => e.id === sorted[i].id),
    "result is sorted by createdAt desc"
  );

  console.log("\n--- getPortfolioTimeline: source filter ---");
  const driftOnly = await getPortfolioTimeline(testFunder, { limit: 50, source: "drift" });
  check(
    driftOnly.every((i) => i.source === "drift"),
    "source=drift returns only drift items"
  );
  const journalOnly = await getPortfolioTimeline(testFunder, { limit: 50, source: "journal" });
  check(
    journalOnly.every((i) => i.source === "journal"),
    "source=journal returns only journal items"
  );

  console.log("\n--- getPortfolioTimeline: limit ---");
  const limit5 = await getPortfolioTimeline(testFunder, { limit: 5 });
  check(limit5.length <= 5, "limit=5 returns at most 5 items");

  console.log("\n--- getPortfolioTimeline: since filter ---");
  const sinceFuture = await getPortfolioTimeline(testFunder, {
    limit: 10,
    since: new Date(Date.now() + 86400000),
  });
  check(sinceFuture.length === 0, "since in future returns empty");

  console.log("\n--- Timeline tests result ---");
  console.log(`  Passed: ${passed}, Failed: ${failed}`);
  return { passed, failed };
}

// Run standalone when executed directly
if (require.main === module) {
  runTimelineTests()
    .then(({ failed }) => process.exit(failed > 0 ? 1 : 0))
    .catch((err) => {
      console.error("Timeline tests error:", err);
      process.exit(1);
    });
}
