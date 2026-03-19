/**
 * L2 trades fetch: first page no params, later pages next_cursor only.
 * Regression test for 400 "Invalid trade params payload" when sending params on first page.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/polymarket/__tests__/l2-readonly-trades-tests.ts
 */

import assert from "assert";
import {
  fetchTradesL2,
  fetchAllTradesL2,
  type L2Creds,
} from "../l2-readonly";

const mockCreds: L2Creds = {
  apiKey: "test-key",
  secret: Buffer.from("test-secret").toString("base64"),
  passphrase: "test-pass",
  funderAddress: "0xtest",
  polyAddress: "0xtest",
};

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

  const originalFetch = globalThis.fetch;

  console.log("\n--- fetchTradesL2: first page must use NO query params ---");
  {
    let capturedUrl: string | null = null;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      return new Response(
        JSON.stringify({ data: [{ id: "t1" }], next_cursor: null }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    try {
      const data = await fetchTradesL2(mockCreds);
      check(Array.isArray(data) && data.length === 1, "fetchTradesL2 returns one trade");
      const url = new URL(capturedUrl!);
      const hasNextCursor = url.searchParams.has("next_cursor");
      check(!hasNextCursor, "fetchTradesL2 first page must not send next_cursor (no params)");
      check(url.pathname === "/data/trades", "fetchTradesL2 path is /data/trades");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  }

  console.log("\n--- fetchAllTradesL2: first page no params, second page next_cursor only ---");
  {
    const urls: string[] = [];
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async (input: RequestInfo | URL) => {
      const s = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      urls.push(s);
      const u = new URL(s);
      const cursor = u.searchParams.get("next_cursor");
      const isFirst = !cursor;
      const data = isFirst ? [{ id: "t1" }, { id: "t2" }] : [{ id: "t3" }];
      const nextCursor = isFirst ? "cursor_page_2" : undefined;
      return new Response(
        JSON.stringify({ data, next_cursor: nextCursor ?? null }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    try {
      const result = await fetchAllTradesL2(mockCreds);
      check(result.pagesFetched === 2, "fetchAllTradesL2 fetched 2 pages");
      check(result.trades.length === 3, "fetchAllTradesL2 returned 3 trades");
      check(urls.length === 2, "fetchAllTradesL2 made 2 requests");
      const firstUrl = new URL(urls[0]);
      const secondUrl = new URL(urls[1]);
      check(!firstUrl.searchParams.has("next_cursor"), "first page: no next_cursor param");
      check(secondUrl.searchParams.get("next_cursor") === "cursor_page_2", "second page: next_cursor only");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  }

  console.log("\n--- fetchAllTradesL2: error message includes first vs later page ---");
  {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async () => {
      return new Response(
        JSON.stringify({ error: "Invalid trade params payload" }),
        { status: 400, statusText: "Bad Request" }
      );
    };
    try {
      await fetchAllTradesL2(mockCreds);
      check(false, "expected fetchAllTradesL2 to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check(msg.includes("first page"), "error message indicates first page (no params)");
      check(msg.includes("/data/trades"), "error message includes path");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  }

  console.log("\n--- fetchAllTradesL2: empty first page (no next_cursor) stops pagination ---");
  {
    let callCount = 0;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({ data: [], next_cursor: null }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    try {
      const result = await fetchAllTradesL2(mockCreds);
      check(result.pagesFetched === 1, "only one page when next_cursor absent");
      check(result.trades.length === 0, "no trades");
      check(callCount === 1, "single request");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  }

  console.log("\n--- fetchAllTradesL2: page 2 400 regression - error includes page number and params ---");
  {
    let callCount = 0;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async (input: RequestInfo | URL) => {
      callCount++;
      const s = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const u = new URL(s);
      const hasCursor = u.searchParams.has("next_cursor");
      if (!hasCursor) {
        return new Response(
          JSON.stringify({ data: [{ id: "a" }], next_cursor: "valid_cursor_for_page2" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ error: "Invalid trade params payload" }),
        { status: 400, statusText: "Bad Request" }
      );
    };
    try {
      await fetchAllTradesL2(mockCreds);
      check(false, "expected fetchAllTradesL2 to throw on page 2 400");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check(msg.includes("page 2"), "error message includes page 2");
      check(msg.includes("next_cursor") || msg.includes("Params"), "error message includes params summary");
      check(msg.includes("/data/trades"), "error message includes path");
      check(callCount === 2, "exactly two requests (page 1 success, page 2 400)");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  }

  console.log("\n--- fetchAllTradesL2: malformed next_cursor (non-string) stops without invalid request ---");
  {
    let callCount = 0;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({ data: [{ id: "t1" }], next_cursor: 12345 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    try {
      const result = await fetchAllTradesL2(mockCreds);
      check(result.pagesFetched === 1, "one page when next_cursor is non-string");
      check(result.trades.length === 1, "one trade returned");
      check(callCount === 1, "no second request when cursor malformed");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  }

  console.log("\n--- fetchAllTradesL2: three pages with valid cursors ---");
  {
    const urls: string[] = [];
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async (input: RequestInfo | URL) => {
      const s = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      urls.push(s);
      const u = new URL(s);
      const cursor = u.searchParams.get("next_cursor");
      let data: unknown[];
      let nextCursor: string | null;
      if (!cursor) {
        data = [{ id: "t1" }];
        nextCursor = "cursor_2";
      } else if (cursor === "cursor_2") {
        data = [{ id: "t2" }];
        nextCursor = "cursor_3";
      } else {
        data = [{ id: "t3" }];
        nextCursor = null;
      }
      return new Response(
        JSON.stringify({ data, next_cursor: nextCursor }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    try {
      const result = await fetchAllTradesL2(mockCreds);
      check(result.pagesFetched === 3, "fetchAllTradesL2 fetched 3 pages");
      check(result.trades.length === 3, "fetchAllTradesL2 returned 3 trades");
      check(urls.length === 3, "fetchAllTradesL2 made 3 requests");
      const [u1, u2, u3] = urls.map((u) => new URL(u));
      check(!u1.searchParams.has("next_cursor"), "page 1: no next_cursor");
      check(u2.searchParams.get("next_cursor") === "cursor_2", "page 2: next_cursor only");
      check(u3.searchParams.get("next_cursor") === "cursor_3", "page 3: next_cursor only");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
