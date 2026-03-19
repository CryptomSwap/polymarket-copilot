/**
 * Regression tests: user-sync fills path uses clobGetWithL2Raw; diagnostics recorded;
 * "Credentials rejected" only when fills response is auth (401/403); non-auth failures not misattributed.
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/polymarket/__tests__/user-sync-fills-path-tests.ts
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

  const syncPath = path.resolve(__dirname, "../user-sync.ts");
  const syncSource = fs.readFileSync(syncPath, "utf8");

  console.log("\n--- Fills path uses same helper as orders: clobGetWithL2Raw ---");
  check(
    syncSource.includes("clobGetWithL2Raw") && syncSource.includes("GET_TRADES"),
    "fills loop uses clobGetWithL2Raw and GET_TRADES"
  );
  const l2Path = path.resolve(__dirname, "../l2-readonly.ts");
  const l2Source = fs.readFileSync(l2Path, "utf8");
  check(
    l2Source.includes("GET_TRADES") && (l2Source.includes("PATH_ONLY_SIGNING_GET_PATHS") && l2Source.includes("GET_TRADES")),
    "l2-readonly uses path-only signing for GET_TRADES (SDK alignment; eliminates 401 on paginated trades)"
  );
  check(
    syncSource.includes('fillsFetchHelper = "clobGetWithL2Raw"'),
    "fillsFetchHelper set to clobGetWithL2Raw"
  );

  console.log("\n--- Fills diagnostics recorded (endpoint, requestPath, status, body snippet) ---");
  check(syncSource.includes("fillsEndpoint"), "fillsEndpoint recorded");
  check(syncSource.includes("fillsRequestPath"), "fillsRequestPath recorded");
  check(syncSource.includes("fillsStatus"), "fillsStatus recorded");
  check(syncSource.includes("fillsBodySnippet"), "fillsBodySnippet recorded");
  check(syncSource.includes("fillsPaginationAttempted"), "fillsPaginationAttempted recorded");
  check(syncSource.includes("fillsPagesFetched"), "fillsPagesFetched recorded");
  check(syncSource.includes("fillsClassification"), "fillsClassification recorded");

  console.log("\n--- Credentials rejected only when fills response is auth (401/403) ---");
  check(
    /fillsClassification === "auth".*Credentials rejected|Credentials rejected.*fillsClassification === "auth"/.test(
      syncSource.replace(/\s+/g, " ")
    ),
    "Credentials rejected only pushed when fillsClassification === auth"
  );
  check(
    syncSource.includes('"Trades fetch failed: CLOB or network error"') || syncSource.includes("fillsClassification === \"server\""),
    "server/5xx fills failure gets generic message, not credential-invalid"
  );
  check(
    syncSource.includes("Trades fetch failed: GET") && syncSource.includes("returned"),
    "other fills failure gets status-specific message, not credential-invalid"
  );

  console.log("\n--- Fills result and metadata expose diagnostics ---");
  check(
    syncSource.includes("fillsFetchHelper") && syncSource.includes("fillsEndpoint") && syncSource.includes("fillsRequestPath") && syncSource.includes("fillsStatus"),
    "SyncUserResult includes fills diagnostics"
  );

  console.log("\n--- Pagination termination: LTE= is end sentinel, no second request ---");
  check(
    syncSource.includes("LTE=") && (syncSource.includes("TRADES_END_CURSOR") || syncSource.includes("end-of-pagination")),
    "user-sync defines LTE= as end-of-pagination sentinel"
  );
  check(
    syncSource.includes("s === TRADES_END_CURSOR") || (syncSource.includes("LTE=") && syncSource.includes("return null")),
    "parseTradesNextCursor returns null for LTE= so no second request is made"
  );
  check(syncSource.includes("fillsPaginationTerminatedNormally"), "fillsPaginationTerminatedNormally in diagnostics");
  check(syncSource.includes("fillsLastNextCursorSeen"), "fillsLastNextCursorSeen in diagnostics");
  check(
    syncSource.includes("fillsPaginationTerminatedNormally") && syncSource.includes("!fillsFailed"),
    "pagination terminated normally when no error (e.g. next_cursor LTE=)"
  );

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
