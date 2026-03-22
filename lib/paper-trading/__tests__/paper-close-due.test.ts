/**
 * Paper 12h close-due selection and metadata helpers (unit tests).
 * Run: npx tsx lib/paper-trading/__tests__/paper-close-due.test.ts
 */

import assert from "assert";
import {
  isPaperTradeDueForClose,
  paperCloseDueBefore,
  mergePaperCloseMetadata,
  PAPER_CLOSE_HORIZON_MS,
} from "../paper-close-helpers";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function run(): void {
  const horizon = PAPER_CLOSE_HORIZON_MS;

  console.log("\n--- not due before horizon ---");
  const entry = new Date("2025-01-01T12:00:00.000Z");
  const justBefore = new Date(entry.getTime() + horizon - 60_000);
  check(!isPaperTradeDueForClose(entry, justBefore, horizon), "1 min before 12h not due");

  console.log("\n--- due at horizon ---");
  const atHorizon = new Date(entry.getTime() + horizon);
  check(isPaperTradeDueForClose(entry, atHorizon, horizon), "exactly 12h after entry is due");

  console.log("\n--- due after horizon ---");
  const after = new Date(entry.getTime() + horizon + 60_000);
  check(isPaperTradeDueForClose(entry, after, horizon), "after 12h is due");

  console.log("\n--- paperCloseDueBefore matches Prisma filter ---");
  const now = new Date("2025-01-02T15:00:00.000Z");
  const cutoff = paperCloseDueBefore(now, horizon);
  check(
    isPaperTradeDueForClose(entry, now, horizon) === entry.getTime() <= cutoff.getTime(),
    "entry <= cutoff equivalent to due"
  );

  console.log("\n--- mergePaperCloseMetadata ---");
  const merged = mergePaperCloseMetadata('{"a":1}', { closeReason: "test" });
  const o = JSON.parse(merged) as { a: number; paperClose: { closeReason: string } };
  check(o.a === 1, "preserves keys");
  check(o.paperClose.closeReason === "test", "nested paperClose");

  console.log("\nAll paper close-due helper tests passed.\n");
}

run();
