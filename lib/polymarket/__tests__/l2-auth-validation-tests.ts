/**
 * L2 auth: authoritative validation (no false green), requestPath matches request, preflight semantics.
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/polymarket/__tests__/l2-auth-validation-tests.ts
 */

import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
  buildRequestPathForGet,
  clobGetWithL2Raw,
  fetchAllTradesL2,
  GET_DATA_ORDERS,
  GET_TRADES,
  validateCredentialsWithClobAuthoritative,
  type L2Creds,
} from "../l2-readonly";

const mockCreds: L2Creds = {
  apiKey: "test-key",
  secret: Buffer.from("test-secret-32-bytes!!").toString("base64"),
  passphrase: "test-pass",
  funderAddress: "0xfunder0000000000000000000000000000000000",
  polyAddress: "0xpoly0000000000000000000000000000000000",
};

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

  console.log("\n--- buildRequestPathForGet: requestPath includes query when params present ---");
  {
    const { url, requestPath } = buildRequestPathForGet("/data/orders", { next_cursor: "MA==" });
    const hasQuery = requestPath.includes("?") && requestPath.includes("next_cursor");
    check(hasQuery, "requestPath includes query string when params provided");
    const urlObj = new URL(url);
    check(urlObj.searchParams.get("next_cursor") === "MA==", "URL has same next_cursor param");
    const pathOnly = requestPath.split("?")[0];
    check(pathOnly === "/data/orders", "requestPath path part is /data/orders");
  }

  console.log("\n--- buildRequestPathForGet: no params => path only ---");
  {
    const { requestPath } = buildRequestPathForGet("/auth/api-keys", {});
    check(requestPath === "/auth/api-keys", "requestPath with no params is path only");
  }

  console.log("\n--- Authoritative validation: api-keys=200, trades=401, data/orders=401 => strongAuthOk false ---");
  const originalFetch = globalThis.fetch;
  try {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const u = new URL(url);
      let status = 200;
      let body = "{}";
      if (u.pathname === "/auth/api-keys") {
        status = 200;
        body = "[]";
      } else if (u.pathname === "/data/trades") {
        status = 401;
        body = '{"error":"Unauthorized/Invalid api key"}';
      } else if (u.pathname === "/data/orders") {
        status = 401;
        body = '{"error":"Unauthorized/Invalid api key"}';
      }
      return new Response(body, { status, headers: { "Content-Type": "application/json" } });
    };
    const result = await validateCredentialsWithClobAuthoritative(mockCreds);
    check(result.apiKeysOk === true, "apiKeysOk true when api-keys returns 200");
    check(result.tradesOk === false, "tradesOk false when trades returns 401");
    check(result.dataOrdersOk === false, "dataOrdersOk false when data/orders returns 401");
    check(result.strongAuthOk === false, "strongAuthOk false when trades fails");
    check(result.overallOk === false, "overallOk mirrors strongAuthOk (temporary policy)");
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }

  console.log("\n--- Authoritative validation: api-keys=200, trades=200, data/orders=401 => strongAuthOk false ---");
  try {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const u = new URL(url);
      if (u.pathname === "/auth/api-keys") return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.pathname === "/data/trades") return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.pathname === "/data/orders") return new Response('{"error":"Unauthorized/Invalid api key"}', { status: 401, headers: { "Content-Type": "application/json" } });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const result = await validateCredentialsWithClobAuthoritative(mockCreds);
    check(result.apiKeysOk === true, "apiKeysOk true");
    check(result.tradesOk === true, "tradesOk true");
    check(result.dataOrdersOk === false, "dataOrdersOk false when data/orders returns 401");
    check(result.strongAuthOk === false, "strongAuthOk false when data/orders fails (no false positive)");
    check(result.overallOk === false, "overallOk false");
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }

  console.log("\n--- Authoritative validation: all 200 (api-keys, trades, data/orders) => strongAuthOk true ---");
  try {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async () =>
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    const result = await validateCredentialsWithClobAuthoritative(mockCreds);
    check(
      result.apiKeysOk === true &&
        result.tradesOk === true &&
        result.dataOrdersOk === true,
      "all endpoints ok (api-keys, trades, data/orders)"
    );
    check(result.strongAuthOk === true, "strongAuthOk true when all three pass");
    check(result.overallOk === true, "overallOk mirrors strongAuthOk");
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }

  console.log("\n--- GET /data/orders: final URL includes next_cursor, signed requestPath is path-only ---");
  {
    const { url, requestPath } = buildRequestPathForGet(GET_DATA_ORDERS, { next_cursor: "MA==" });
    const urlObj = new URL(url);
    check(urlObj.searchParams.get("next_cursor") === "MA==", "buildRequestPathForGet URL has next_cursor param");
    check(requestPath.includes("next_cursor"), "buildRequestPathForGet requestPath includes query (used for URL only)");
  }
  try {
    let capturedUrl: string | null = null;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      return new Response('{"data":[]}', { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const out = await clobGetWithL2Raw(mockCreds, GET_DATA_ORDERS, { next_cursor: "MA==" });
    check(out.requestPath === GET_DATA_ORDERS, "clobGetWithL2Raw signed requestPath is path-only for /data/orders");
    check((capturedUrl ?? "").includes("next_cursor"), "actual fetch URL includes next_cursor");
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }

  console.log("\n--- GET /data/trades: first page and paginated use path-only signing (SDK alignment) ---");
  {
    const { url } = buildRequestPathForGet(GET_TRADES, { next_cursor: "LTE=" });
    const urlObj = new URL(url);
    check(urlObj.searchParams.get("next_cursor") === "LTE=", "trades URL has next_cursor param");
  }
  try {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async () =>
      new Response('{"data":[],"next_cursor":null}', { status: 200, headers: { "Content-Type": "application/json" } });
    const firstPage = await clobGetWithL2Raw(mockCreds, GET_TRADES, {});
    check(firstPage.requestPath === GET_TRADES, "first-page trades signed requestPath is path-only");
    const paginated = await clobGetWithL2Raw(mockCreds, GET_TRADES, { next_cursor: "LTE=" });
    check(paginated.requestPath === GET_TRADES, "paginated trades signed requestPath is path-only (SDK behavior)");
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }

  console.log("\n--- fetchAllTradesL2: next_cursor LTE= stops pagination (no second request) ---");
  try {
    let fetchCallCount = 0;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async () => {
      fetchCallCount++;
      return new Response('{"data":[],"next_cursor":"LTE="}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const result = await fetchAllTradesL2(mockCreds);
    check(result.pagesFetched === 1, "pagesFetched is 1 when first page returns next_cursor LTE=");
    check(result.trades.length === 0, "trades array empty when response has no data");
    check(fetchCallCount === 1, "only one request made; LTE= is end sentinel, no second request");
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }

  console.log("\n--- Credential selection: getStoredCredentials uses validity-aware ranking ---");
  {
    const authPath = path.resolve(__dirname, "../auth.ts");
    const authSource = fs.readFileSync(authPath, "utf8");
    const usesRanking = /rankCredentialRows|selectBestCredentialIndex|isStrongAuthValidCredentialRow/.test(authSource);
    check(usesRanking, "auth uses validity-aware ranking (rankCredentialRows / selectBestCredentialIndex)");
  }

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
