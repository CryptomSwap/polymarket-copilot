/**
 * Compare GET /orders vs GET /data/orders using the same L2 credentials and signing logic as production.
 * Open-orders read uses GET /data/orders with path-only signing (SDK-compatible). GET /orders is for create/cancel.
 * Prints safe diagnostics only (no secrets).
 *
 * Run from repo root:
 *   npx tsx scripts/compare-polymarket-orders-endpoints.ts
 */

import "dotenv/config";
import { getStoredCredentials } from "../lib/polymarket/auth";
import { clobGetWithL2Raw, GET_DATA_ORDERS, type L2Creds } from "../lib/polymarket/l2-readonly";

function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length < 8) return "(present, length < 8)";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

async function main(): Promise<void> {
  console.log("\n--- Compare /orders vs /data/orders (same L2 creds; open-orders read = GET /data/orders) ---\n");

  const { credential: creds } = await getStoredCredentials();
  if (!creds) {
    console.error("No stored credential. Save connection and init credentials via Settings → Polymarket first.");
    process.exit(1);
  }

  console.log("Using credential:");
  console.log("  credentialId:", creds.credentialId);
  console.log("  funderAddress:", creds.funderAddress);
  console.log("  polyAddress:", creds.polyAddress);
  console.log("  apiKey:", maskApiKey(creds.apiKey));
  console.log("");

  const l2Creds: L2Creds = {
    apiKey: creds.apiKey,
    secret: creds.secret,
    passphrase: creds.passphrase,
    funderAddress: creds.funderAddress,
    polyAddress: creds.polyAddress,
  };

  const probes: Array<{ name: string; path: string; params: Record<string, string | number | undefined> }> = [
    { name: "GET /orders (not read endpoint; may 405)", path: "/orders", params: {} },
    { name: `GET ${GET_DATA_ORDERS}?next_cursor=MA== (SDK path-only signing)`, path: GET_DATA_ORDERS, params: { next_cursor: "MA==" } },
  ];

  for (const probe of probes) {
    console.log(`--- ${probe.name} ---`);
    try {
      const { status, body, requestPath } = await clobGetWithL2Raw(l2Creds, probe.path, probe.params);
      const snippet = body && body.length > 300 ? `${body.slice(0, 300)}...` : body || "";
      console.log("  requestPath:", requestPath);
      console.log("  status:", status);
      console.log("  bodySnippet:", snippet || "(empty)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log("  ERROR:", msg);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

