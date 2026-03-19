/**
 * Debug script: simulate init-flow diagnostics without L1 (no wallet sign).
 * Loads connection + stored credential (if any), runs authoritative validation,
 * prints safe diagnostics: identity, request paths, status codes, body snippets.
 * Use after a failed init to inspect what request paths and responses the CLOB returned.
 *
 * Run from repo root:
 *   npx tsx scripts/debug-polymarket-init-flow.ts
 * Or:
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register scripts/debug-polymarket-init-flow.ts
 */

import "dotenv/config";
import { prisma } from "../lib/db";
import { getStoredCredentials } from "../lib/polymarket/auth";
import { validateCredentialsWithClobAuthoritative } from "../lib/polymarket/l2-readonly";

async function main(): Promise<void> {
  console.log("\n--- Polymarket init-flow diagnostics (no secrets) ---\n");

  const connection = await prisma.connectedWallet.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  if (!connection) {
    console.log("No saved connection. Save EOA + funder in Settings → Polymarket first.");
    process.exit(0);
  }

  console.log("Connection (saved wallet):");
  console.log("  connectedWalletId:", connection.id);
  console.log("  eoaAddress:", connection.eoaAddress);
  console.log("  funderAddress:", connection.funderAddress);
  console.log("  signatureType:", connection.signatureType);
  console.log("");

  const { credential, selectionDiagnostics } = await getStoredCredentials();

  if (!credential) {
    console.log("No stored credential (or none strong-auth valid).");
    console.log("  selectionReason:", selectionDiagnostics?.selectionReason ?? "n/a");
    console.log("  credentialCount:", selectionDiagnostics?.credentialCount ?? 0);
    console.log("");
    console.log("To produce a strong-auth-valid credential:");
    console.log("  1. In app: Settings → Polymarket → Initialize API credentials");
    console.log("  2. Sign the L1 message with the wallet matching the connection EOA");
    console.log("  3. Init will derive/create key, validate on api-keys and trades, then store (orders logged separately)");
    process.exit(0);
  }

  console.log("Stored credential identity (used for L2 POLY_ADDRESS):");
  console.log("  credentialId:", credential.credentialId);
  console.log("  polyAddress:", credential.polyAddress);
  console.log("  funderAddress:", credential.funderAddress);
  console.log("  polyAddressSource: from getStoredCredentials (stored_credential | connected_wallet_fallback | funder_fallback)");
  if (selectionDiagnostics) {
    console.log("");
    console.log("Selection diagnostics:");
    console.log("  selectionReason:", selectionDiagnostics.selectionReason);
    console.log("  validationSummary:", selectionDiagnostics.validationSummary ?? "(none)");
  }
  console.log("");

  console.log("Running authoritative validation (same as init and preflight)...");
  const validation = await validateCredentialsWithClobAuthoritative({
    apiKey: credential.apiKey,
    secret: credential.secret,
    passphrase: credential.passphrase,
    funderAddress: credential.funderAddress,
    polyAddress: credential.polyAddress,
  });

  console.log("");
  console.log("Validation result:");
  console.log("  apiKeysOk:", validation.apiKeysOk, "| status:", validation.diagnostics.apiKeysStatus);
  console.log("  apiKeysRequestPath:", validation.diagnostics.apiKeysRequestPath);
  if (validation.diagnostics.apiKeysBodySnippet) {
    console.log("  apiKeysBodySnippet:", validation.diagnostics.apiKeysBodySnippet);
  }
  console.log("");
  console.log("  tradesOk:", validation.tradesOk, "| status:", validation.diagnostics.tradesStatus);
  console.log("  tradesRequestPath:", validation.diagnostics.tradesRequestPath);
  if (validation.diagnostics.tradesBodySnippet) {
    console.log("  tradesBodySnippet:", validation.diagnostics.tradesBodySnippet);
  }
  console.log("");
  console.log(
    "  dataOrdersOk:",
    validation.dataOrdersOk,
    "| status:",
    validation.diagnostics.dataOrdersStatus
  );
  console.log("  dataOrdersRequestPath:", validation.diagnostics.dataOrdersRequestPath);
  if (validation.diagnostics.dataOrdersBodySnippet) {
    console.log("  dataOrdersBodySnippet:", validation.diagnostics.dataOrdersBodySnippet);
  }
  console.log("");
  console.log("  overallOk:", validation.overallOk);
  console.log("");
  console.log("If init fails with 502 and overallOk false, compare these requestPaths and status/body with CLOB docs.");
  console.log("Identity must match: POLY_ADDRESS = EOA that derived the key (polyAddress); funder = stored funderAddress.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
