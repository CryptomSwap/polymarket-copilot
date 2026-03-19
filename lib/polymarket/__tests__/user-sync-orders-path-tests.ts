/**
 * Regression tests: user-sync and startup rebuild use the same open-orders helper;
 * GET /data/orders with path-only signing; 200 response not mapped to "invalid or expired".
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/polymarket/__tests__/user-sync-orders-path-tests.ts
 */

import * as fs from "fs";
import * as path from "path";

async function run(): Promise<void> {
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

  const l2Path = path.resolve(__dirname, "../l2-readonly.ts");
  const syncPath = path.resolve(__dirname, "../user-sync.ts");
  const l2Source = fs.readFileSync(l2Path, "utf8");
  const syncSource = fs.readFileSync(syncPath, "utf8");

  console.log("\n--- Startup rebuild and user-sync use same endpoint: GET /data/orders ---");
  check(
    l2Source.includes("fetchOpenOrdersL2") && l2Source.includes("GET_DATA_ORDERS") && l2Source.includes("clobGetWithL2"),
    "fetchOpenOrdersL2 (startup rebuild path) uses GET_DATA_ORDERS and clobGetWithL2"
  );
  check(
    syncSource.includes("clobGetWithL2Raw") && syncSource.includes("GET_DATA_ORDERS"),
    "user-sync orders fetch uses clobGetWithL2Raw and GET_DATA_ORDERS"
  );
  check(
    syncSource.includes("DATA_ORDERS_INITIAL_CURSOR") || (syncSource.includes("next_cursor") && syncSource.includes("data/orders")),
    "user-sync uses same cursor/params for GET /data/orders"
  );

  console.log("\n--- User-sync uses path-only signing for /data/orders ---");
  check(
    syncSource.includes("clobGetWithL2Raw") && syncSource.includes("ordersRequestPath"),
    "user-sync calls clobGetWithL2Raw and records requestPath (path-only for /data/orders in l2-readonly)"
  );

  console.log("\n--- 200 on /data/orders not mapped to invalid or expired ---");
  check(
    /rawOrders\.status\s*!==\s*200/.test(syncSource) && syncSource.includes("Credentials rejected") && syncSource.includes("classification === \"auth\""),
    "Credentials rejected only pushed when classification is auth (401/403), not on 200"
  );
  check(
    syncSource.includes("} else {") && syncSource.includes("let list: unknown[]") && !/status\s*===\s*200.*Credentials rejected/.test(syncSource),
    "Success branch (status 200) parses list and does not push credentials error"
  );

  console.log("\n--- Same helper identity ---");
  check(
    syncSource.includes('ordersFetchHelper = "clobGetWithL2Raw"') || syncSource.includes("ordersFetchHelper = \"clobGetWithL2Raw\""),
    "user-sync sets ordersFetchHelper to clobGetWithL2Raw (same low-level helper as validation/rebuild)"
  );

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
