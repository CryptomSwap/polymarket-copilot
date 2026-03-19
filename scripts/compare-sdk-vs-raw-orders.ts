/**
 * Compare SDK vs raw open-orders behavior using the same selected stored credential.
 * Runs raw GET /orders, GET /orders?next_cursor=MA==, GET /data/orders?next_cursor=MA==,
 * and (if signer available) SDK getOpenOrders(). Logs path, method, requestPath, status, truncated body.
 * No secrets (apiKey masked).
 *
 * Run from repo root:
 *   npx tsx scripts/compare-sdk-vs-raw-orders.ts
 */

import "dotenv/config";
import { getStoredCredentials } from "../lib/polymarket/auth";
import { clobGetWithL2Raw, type L2Creds } from "../lib/polymarket/l2-readonly";
import { getClobClientForTrading } from "../lib/polymarket/trading";

function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length < 8) return "(present, length < 8)";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function truncate(s: string, max = 280): string {
  if (!s) return "(empty)";
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

async function main(): Promise<void> {
  console.log("\n--- SDK vs raw open-orders (same credential) ---\n");

  const { credential: creds, selectionDiagnostics } = await getStoredCredentials();
  if (!creds) {
    console.error("No stored credential (or none strong-auth valid). Run init from Settings → Polymarket.");
    console.error("  selectionReason:", selectionDiagnostics?.selectionReason ?? "n/a");
    process.exit(1);
  }

  console.log("Identity (safe):");
  console.log("  credentialId:", creds.credentialId);
  console.log("  funderAddress:", creds.funderAddress);
  console.log("  polyAddress:", creds.polyAddress);
  console.log("  apiKey:", maskApiKey(creds.apiKey));
  console.log("  selectionReason:", selectionDiagnostics?.selectionReason ?? "n/a");
  console.log("");

  const l2Creds: L2Creds = {
    apiKey: creds.apiKey,
    secret: creds.secret,
    passphrase: creds.passphrase,
    funderAddress: creds.funderAddress,
    polyAddress: creds.polyAddress,
  };

  const rawProbes: Array<{ name: string; path: string; params: Record<string, string> }> = [
    { name: "A. Raw GET /orders", path: "/orders", params: {} },
    { name: "B. Raw GET /orders?next_cursor=MA==", path: "/orders", params: { next_cursor: "MA==" } },
    { name: "C. Raw GET /data/orders?next_cursor=MA==", path: "/data/orders", params: { next_cursor: "MA==" } },
  ];

  for (const probe of rawProbes) {
    console.log(`--- ${probe.name} ---`);
    try {
      const { status, body, requestPath } = await clobGetWithL2Raw(l2Creds, probe.path, probe.params);
      console.log("  method: GET");
      console.log("  requestPath:", requestPath);
      console.log("  status:", status);
      console.log("  bodySnippet:", truncate(body));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log("  method: GET");
      console.log("  ERROR:", truncate(msg));
    }
    console.log("");
  }

  console.log("--- D. SDK getOpenOrders() ---");
  try {
    const client = await getClobClientForTrading();
    if (!client) {
      console.log("  skipped: no signer (POLYMARKET_SIGNER_PRIVATE_KEY not set); SDK requires signer for L2 client.");
    } else {
      const results = await client.getOpenOrders(undefined, true);
      const arr = Array.isArray(results) ? results : [];
      console.log("  method: GET (SDK uses /data/orders with L2 headers)");
      console.log("  requestPath (SDK): /data/orders (path only; SDK does not include query in signed path)");
      console.log("  result: array length", arr.length);
      console.log("  bodySnippet: (first 280 chars of JSON)", truncate(JSON.stringify(arr)));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("  ERROR:", truncate(msg));
  }
  console.log("");
  console.log("See docs/POLYMARKET_ORDERS_ENDPOINT_INVESTIGATION.md for SDK vs raw comparison.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
