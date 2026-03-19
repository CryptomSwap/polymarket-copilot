/**
 * Direct credential probe: load latest stored L2 credential and hit authenticated endpoints
 * with the same signing/header logic production uses. Diagnostic only.
 *
 * Run from repo root:
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register scripts/probe-polymarket-l2-credential.ts
 * Or:
 *   npx tsx scripts/probe-polymarket-l2-credential.ts
 */

import "dotenv/config";
import { getStoredCredentials } from "../lib/polymarket/auth";
import { clobGetWithL2Raw, type L2Creds } from "../lib/polymarket/l2-readonly";
import { prisma } from "../lib/db";

function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length < 8) return "(present, length < 8)";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

async function main(): Promise<void> {
  console.log("\n--- L2 credential probe (same auth path as production) ---\n");

  const { credential: creds, selectionDiagnostics } = await getStoredCredentials();
  if (!creds) {
    console.error("No stored credential. Save connection and init credentials via Settings → Polymarket.");
    process.exit(1);
  }

  let lastValidatedAt: Date | null = null;
  try {
    const row = await prisma.polymarketApiCredential.findUnique({
      where: { id: creds.credentialId },
      select: { lastValidatedAt: true },
    });
    lastValidatedAt = row?.lastValidatedAt ?? null;
  } catch {
    // optional
  }

  console.log("Credential used:");
  console.log("  credentialId:", creds.credentialId);
  console.log("  funderAddress:", creds.funderAddress);
  console.log("  polyAddress:", creds.polyAddress);
  console.log("  polyAddressSource:", creds.polyAddressSource);
  console.log("  lastValidatedAt:", lastValidatedAt != null ? lastValidatedAt.toISOString() : "(not available)");
  console.log("  apiKey:", maskApiKey(creds.apiKey));
  if (selectionDiagnostics) {
    console.log("  selectionReason:", selectionDiagnostics.selectionReason);
    console.log("  validationSummary:", selectionDiagnostics.validationSummary ?? "(none)");
    console.log("  credentialCount:", selectionDiagnostics.credentialCount);
  }
  console.log("");

  const l2Creds: L2Creds = {
    apiKey: creds.apiKey,
    secret: creds.secret,
    passphrase: creds.passphrase,
    funderAddress: creds.funderAddress,
    polyAddress: creds.polyAddress,
  };

  const probes: Array<{ name: string; path: string; params: Record<string, string | number | undefined> }> = [
    { name: "A. GET /auth/api-keys", path: "/auth/api-keys", params: {} },
    { name: "B. GET /data/orders", path: "/data/orders", params: { next_cursor: "MA==" } },
    { name: "C. GET /data/trades (first page)", path: "/data/trades", params: {} },
  ];

  const results: Array<{
    name: string;
    path: string;
    requestPath: string;
    status: number;
    body: string;
    succeeded: boolean;
  }> = [];

  for (const probe of probes) {
    const { status, body, requestPath } = await clobGetWithL2Raw(l2Creds, probe.path, probe.params);
    const succeeded = status === 200;
    results.push({
      name: probe.name,
      path: probe.path,
      requestPath,
      status,
      body,
      succeeded,
    });
    console.log(`--- ${probe.name} ---`);
    console.log("  endpoint path:", probe.path);
    console.log("  signed path string:", requestPath);
    console.log("  status code:", status);
    console.log("  response body:", body.length > 500 ? body.slice(0, 500) + "..." : body);
    console.log("  succeeded:", succeeded);
    console.log("");
  }

  console.log("--- Summary ---");
  const allOk = results.every((r) => r.succeeded);
  results.forEach((r) => {
    console.log(`  ${r.name}: ${r.status} ${r.succeeded ? "OK" : "FAIL"}`);
  });
  if (!allOk) {
    console.log("\nInterpretation: credential is rejected on one or more endpoints. Compare A vs B vs C to see if validation endpoint is falsely green.");
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
