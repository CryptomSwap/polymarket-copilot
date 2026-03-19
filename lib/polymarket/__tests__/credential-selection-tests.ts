/**
 * Validity-aware credential selection: ranking, selectBest, no fallback to invalid.
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/polymarket/__tests__/credential-selection-tests.ts
 */

import assert from "assert";
import {
  isStrongAuthValidCredentialRow,
  rankCredentialRows,
  selectBestCredentialIndex,
  type CredentialRowForRanking,
} from "../auth";

function row(
  id: string,
  updatedAt: Date,
  apiKeys: boolean | null,
  trades: boolean | null,
  orders: boolean | null
): CredentialRowForRanking {
  return {
    id,
    updatedAt,
    validationApiKeysOk: apiKeys,
    validationTradesOk: trades,
    validationOrdersOk: orders,
  };
}

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

  console.log("\n--- isStrongAuthValidCredentialRow: apiKeys && trades required (orders optional) ---");
  check(isStrongAuthValidCredentialRow(row("a", new Date(), true, true, true)), "all true => strong-auth valid");
  check(isStrongAuthValidCredentialRow(row("a", new Date(), true, true, false)), "orders false => still strong-auth valid");
  check(!isStrongAuthValidCredentialRow(row("a", new Date(), true, null, true)), "trades null => not strong-auth valid");
  check(!isStrongAuthValidCredentialRow(row("a", new Date(), null, null, null)), "all null => not strong-auth valid");

  console.log("\n--- rankCredentialRows: strong-auth-valid first, then by updatedAt desc, then ordersOk ---");
  const older = new Date(1000);
  const newer = new Date(2000);
  const a = row("a", older, true, true, true);
  const b = row("b", newer, false, false, false);
  check(rankCredentialRows(a, b) < 0, "strong-auth-valid (older) before not strong-auth-valid (newer)");
  check(rankCredentialRows(b, a) > 0, "not strong-auth-valid (newer) after strong-auth-valid (older)");

  const a2 = row("a2", older, true, true, true);
  const b2 = row("b2", newer, true, true, false);
  const c2 = row("c2", newer, true, true, true);
  check(rankCredentialRows(b2, a2) < 0, "among strong-auth-valid: newer first (even if orders false)");
  check(rankCredentialRows(a2, b2) > 0, "among strong-auth-valid: older second");
  check(rankCredentialRows(c2, b2) < 0, "tie on updatedAt: ordersOk true preferred over false");

  const c = row("c", older, false, false, false);
  const d = row("d", newer, false, false, false);
  check(rankCredentialRows(d, c) < 0, "among invalid: newer first");
  check(rankCredentialRows(c, d) > 0, "among invalid: older second");

  console.log("\n--- selectBestCredentialIndex: two rows, newer invalid, older strong-auth-valid => older selected ---");
  const rowsNewerInvalidOlderValid = [
    row("new", newer, false, false, false),
    row("old", older, true, true, true),
  ];
  rowsNewerInvalidOlderValid.sort(rankCredentialRows);
  const sel1 = selectBestCredentialIndex(rowsNewerInvalidOlderValid);
  check(sel1.chosenIndex === 0, "best is at index 0 after sort");
  check(isStrongAuthValidCredentialRow(rowsNewerInvalidOlderValid[0]), "best row is the strong-auth-valid one");
  check(sel1.selectionReason === "strong_auth_valid_newest", "reason strong_auth_valid_newest");
  check(sel1.chosenIndex >= 0 && rowsNewerInvalidOlderValid[sel1.chosenIndex].id === "old", "chosen is older strong-auth-valid row");

  console.log("\n--- selectBestCredentialIndex: both strong-auth-valid, newest with orders=false => warning selected ---");
  const rowsBothValid = [
    row("old", older, true, true, true),
    row("new", newer, true, true, false),
  ];
  rowsBothValid.sort(rankCredentialRows);
  const sel2 = selectBestCredentialIndex(rowsBothValid);
  check(sel2.chosenIndex === 0, "best at index 0");
  check(rowsBothValid[0].id === "new", "newest strong-auth-valid is first after sort");
  check(sel2.selectionReason === "strong_auth_valid_orders_warning", "reason strong_auth_valid_orders_warning");
  check(sel2.hadFullyValidAlternatives === true, "hadFullyValidAlternatives true when two strong-auth-valid");

  console.log("\n--- selectBestCredentialIndex: no strong-auth-valid => chosenIndex -1, reason no_strong_auth_valid_credential ---");
  const rowsNoneValid = [
    row("a", newer, true, false, false),
    row("b", older, null, null, null),
  ];
  rowsNoneValid.sort(rankCredentialRows);
  const sel3 = selectBestCredentialIndex(rowsNoneValid);
  check(sel3.chosenIndex === -1, "no row chosen");
  check(sel3.selectionReason === "no_strong_auth_valid_credential", "reason no_strong_auth_valid_credential");
  check(sel3.hadFullyValidAlternatives === false, "hadFullyValidAlternatives false");

  console.log("\n--- selectBestCredentialIndex: no rows => no_rows ---");
  const sel4 = selectBestCredentialIndex([]);
  check(sel4.chosenIndex === -1, "chosenIndex -1");
  check(sel4.selectionReason === "no_rows", "reason no_rows");

  console.log("\n--- null validation fields rank below strong-auth-valid ---");
  const legacy = row("legacy", newer, null, null, null);
  const valid = row("valid", older, true, true, true);
  check(!isStrongAuthValidCredentialRow(legacy), "legacy row not strong-auth-valid");
  check(rankCredentialRows(valid, legacy) < 0, "strong-auth-valid (older) before legacy (newer)");
  const withLegacy = [legacy, valid];
  withLegacy.sort(rankCredentialRows);
  check(withLegacy[0].id === "valid", "valid chosen over legacy when both present");
  const sel5 = selectBestCredentialIndex(withLegacy);
  check(sel5.chosenIndex === 0 && withLegacy[0].id === "valid", "selected row is the valid one");

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
