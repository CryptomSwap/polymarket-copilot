/**
 * Compare SDK vs raw trades/fills behavior using the same selected stored credential.
 * Runs raw GET /data/trades (first page), GET /data/trades?next_cursor=... (paginated),
 * and (if signer available) SDK getTrades(). Logs endpoint, requestPath, status, truncated body.
 * SDK signs requestPath = "/data/trades" only (path-only); we align to that.
 *
 * Run from repo root:
 *   npx tsx scripts/compare-sdk-vs-raw-trades.ts
 */

import "dotenv/config";
import { getStoredCredentials } from "../lib/polymarket/auth";
import { clobGetWithL2Raw, GET_TRADES, type L2Creds } from "../lib/polymarket/l2-readonly";
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
  console.log("\n--- SDK vs raw trades (same credential) ---\n");

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
  console.log("");

  const l2Creds: L2Creds = {
    apiKey: creds.apiKey,
    secret: creds.secret,
    passphrase: creds.passphrase,
    funderAddress: creds.funderAddress,
    polyAddress: creds.polyAddress,
  };

  console.log("--- A. Raw GET /data/trades (first page, no params) ---");
  try {
    const first = await clobGetWithL2Raw(l2Creds, GET_TRADES, {});
    console.log("  endpoint:", GET_TRADES);
    console.log("  requestPath (signed):", first.requestPath);
    console.log("  status:", first.status);
    console.log("  bodySnippet:", truncate(first.body));
    if (first.status === 200) {
      let parsed: { next_cursor?: string; data?: unknown[] } = {};
      try {
        parsed = JSON.parse(first.body || "{}") as { next_cursor?: string; data?: unknown[] };
      } catch {
        // ignore
      }
      if (parsed.next_cursor) {
        console.log("  next_cursor (for B):", truncate(parsed.next_cursor, 60));
        console.log("");
        console.log("--- B. Raw GET /data/trades?next_cursor=... (paginated) ---");
        try {
          const second = await clobGetWithL2Raw(l2Creds, GET_TRADES, {
            next_cursor: parsed.next_cursor,
          });
          console.log("  endpoint:", GET_TRADES);
          console.log("  requestPath (signed):", second.requestPath);
          console.log("  status:", second.status);
          console.log("  bodySnippet:", truncate(second.body));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log("  ERROR:", truncate(msg));
        }
      } else {
        console.log("  (no next_cursor; skip paginated probe)");
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("  ERROR:", truncate(msg));
  }
  console.log("");

  console.log("--- C. SDK getTrades() ---");
  try {
    const client = await getClobClientForTrading();
    if (!client) {
      console.log("  skipped: no signer (POLYMARKET_SIGNER_PRIVATE_KEY not set); SDK requires signer for L2 client.");
    } else {
      const results = await client.getTrades(undefined, true);
      const arr = Array.isArray(results) ? results : [];
      console.log("  method: GET (SDK uses " + GET_TRADES + " with L2 headers)");
      console.log("  requestPath (SDK): " + GET_TRADES + " (path only; SDK does not include query in signed path)");
      console.log("  result: array length", arr.length);
      console.log("  bodySnippet: (first 280 chars of JSON)", truncate(JSON.stringify(arr)));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("  ERROR:", truncate(msg));
  }
  console.log("");
  console.log("Expected: requestPath (signed) for both A and B should be '/data/trades' (path-only) when aligned with SDK.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
