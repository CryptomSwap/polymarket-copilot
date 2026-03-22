/**
 * Run: npx tsx lib/paper-trading/__tests__/normalize-close-tick-result.test.ts
 */

import assert from "assert";
import { normalizeCloseTickResult } from "../normalize-close-tick-result";

function check(c: boolean, m: string): void {
  assert.strictEqual(c, true, m);
}

function run(): void {
  const legacy = { closed: 0, errors: ["No 12h price for a", "No 12h price for b"] };
  const n = normalizeCloseTickResult(legacy as Record<string, unknown>);
  check(n.legacyShape === true, "legacy");
  check(n.dueCount === 2, "due inferred closed+errors");
  check(n.errorSample.length === 2 && n.errorSample[0] === "No 12h price for a", "sample from errors");

  const modern = {
    runAt: "x",
    horizonMs: 1,
    openTotalCount: 5,
    dueCount: 3,
    closed: 3,
    closedWithMarkout: 2,
    closedWithoutMarkout: 1,
    errors: [],
    errorSample: [],
    closeReasonCounts: {},
  };
  const m = normalizeCloseTickResult(modern as Record<string, unknown>);
  check(m.legacyShape === false, "not legacy");
  check(m.dueCount === 3, "explicit due");
  check(m.openTotalCount === 5, "open total");

  console.log("normalize-close-tick-result tests passed");
}

run();
