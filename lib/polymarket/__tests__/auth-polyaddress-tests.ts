/**
 * PolyAddress storage and resolution: resolvePolyAddressFromCred + init-credentials stores polyAddress.
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/polymarket/__tests__/auth-polyaddress-tests.ts
 */

import assert from "assert";
import { resolvePolyAddressFromCred } from "../auth";
import * as fs from "fs";
import * as path from "path";

function ok(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
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

  console.log("\n--- resolvePolyAddressFromCred: stored polyAddress ---");
  {
    const { polyAddress, polyAddressSource } = resolvePolyAddressFromCred(
      { polyAddress: "0xStoredEoa123456789012345678901234567890", funderAddress: "0xFunder0000000000000000000000000000000000" },
      { eoaAddress: "0xWalletEoa00000000000000000000000000000000" }
    );
    check(polyAddress === "0xstoredeoa123456789012345678901234567890", "returns stored polyAddress (lowercased)");
    check(polyAddressSource === "stored_credential", "source is stored_credential");
  }

  console.log("\n--- resolvePolyAddressFromCred: legacy null polyAddress, use connectedWallet.eoaAddress ---");
  {
    const { polyAddress, polyAddressSource } = resolvePolyAddressFromCred(
      { polyAddress: null, funderAddress: "0xFunder0000000000000000000000000000000000" },
      { eoaAddress: "0xWalletEoa00000000000000000000000000000000" }
    );
    check(polyAddress === "0xwalleteoa00000000000000000000000000000000", "returns connectedWallet.eoaAddress (lowercased)");
    check(polyAddressSource === "connected_wallet_fallback", "source is connected_wallet_fallback");
  }

  console.log("\n--- resolvePolyAddressFromCred: legacy null polyAddress, empty wallet EOA, use funderAddress ---");
  {
    const { polyAddress, polyAddressSource } = resolvePolyAddressFromCred(
      { polyAddress: null, funderAddress: "0xFunder0000000000000000000000000000000000" },
      { eoaAddress: "" }
    );
    check(polyAddress === "0xfunder0000000000000000000000000000000000", "returns funderAddress (lowercased)");
    check(polyAddressSource === "funder_fallback", "source is funder_fallback");
  }

  console.log("\n--- resolvePolyAddressFromCred: legacy row with no connectedWallet EOA (undefined) falls back to funderAddress ---");
  {
    const { polyAddress, polyAddressSource } = resolvePolyAddressFromCred(
      { polyAddress: null, funderAddress: "0xFunder0000000000000000000000000000000000" },
      {}
    );
    check(polyAddress === "0xfunder0000000000000000000000000000000000", "returns funderAddress when wallet has no eoaAddress");
    check(polyAddressSource === "funder_fallback", "source is funder_fallback");
  }

  console.log("\n--- resolvePolyAddressFromCred: undefined polyAddress same as null (legacy) ---");
  {
    const { polyAddress, polyAddressSource } = resolvePolyAddressFromCred(
      { funderAddress: "0xFunder0000000000000000000000000000000000" },
      { eoaAddress: "0xWalletEoa00000000000000000000000000000000" }
    );
    check(polyAddressSource === "connected_wallet_fallback", "undefined polyAddress uses wallet fallback");
    check(polyAddress === "0xwalleteoa00000000000000000000000000000000", "polyAddress from wallet");
  }

  console.log("\n--- init-credentials route stores polyAddress on create/update ---");
  {
    const routePath = path.resolve(__dirname, "../../../app/api/polymarket/init-credentials/route.ts");
    const content = fs.readFileSync(routePath, "utf8");
    const hasCreatePolyAddress = /create:\s*\{[\s\S]*?polyAddress:\s*eoaNorm/.test(content);
    const hasUpdatePolyAddress = /update:\s*\{[\s\S]*?polyAddress:\s*eoaNorm/.test(content);
    check(hasCreatePolyAddress, "init-credentials create block includes polyAddress: eoaNorm");
    check(hasUpdatePolyAddress, "init-credentials update block includes polyAddress: eoaNorm");
  }

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
