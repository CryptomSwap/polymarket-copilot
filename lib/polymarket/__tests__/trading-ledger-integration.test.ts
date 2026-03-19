/**
 * Regression: trading.ts uses execution-ledger service for OrderIntent/ExecutedOrder persistence,
 * not raw Prisma. Verifies no direct prisma.orderIntent.create/update or prisma.executedOrder.create in trading.ts.
 */

import * as fs from "fs";
import * as path from "path";

const TRADING_PATH = path.join(__dirname, "..", "trading.ts");

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function run(): Promise<void> {
  const src = fs.readFileSync(TRADING_PATH, "utf-8");

  check(!src.includes("prisma.orderIntent"), "trading must not use prisma.orderIntent");
  check(!src.includes("prisma.executedOrder"), "trading must not use prisma.executedOrder");
  check(src.includes("createIntentWithEvent"), "trading must use createIntentWithEvent");
  check(src.includes("createExecutedOrderForIntent"), "trading must use createExecutedOrderForIntent");
  check(src.includes("appendOrderIntentEventToLedger") || src.includes("appendOrderIntentEvent"), "trading must use ledger event append");
  check(src.includes("buildApiOrderIdempotencyKey"), "trading must use buildApiOrderIdempotencyKey");
  check(src.includes("execution-ledger/service"), "trading must import from execution-ledger/service");
  check(src.includes("execution-ledger/idempotency"), "trading must import from execution-ledger/idempotency");

  console.log("OK: trading.ts uses execution-ledger for order lifecycle; no direct Prisma intent/order writes.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
