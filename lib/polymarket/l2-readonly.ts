/**
 * Read-only L2 CLOB access using stored credentials only. No signer/private key.
 * Builds L2 HMAC headers and performs GET requests for orders and trades.
 * TODO: Manual execution / cron can call into this for scheduled sync.
 */

import * as crypto from "crypto";

export const CLOB_HOST = "https://clob.polymarket.com";
/**
 * Open-orders read endpoint. Official SDK uses GET_OPEN_ORDERS = "/data/orders" and signs
 * requestPath = "/data/orders" only (query params sent in URL but NOT in signed path).
 */
export const GET_DATA_ORDERS = "/data/orders";
/** Trades (fills) endpoint; first page no params, later pages next_cursor. SDK signs requestPath = "/data/trades" only. */
export const GET_TRADES = "/data/trades";
/** Paths that use path-only signing (SDK compatibility); query params are sent but not included in signature. */
const PATH_ONLY_SIGNING_GET_PATHS = new Set([GET_DATA_ORDERS, GET_TRADES]);
/** Base64-encoded cursor for first page of GET /data/orders (exported for user-sync to use same value). */
export const DATA_ORDERS_INITIAL_CURSOR = "MA==";
const INITIAL_CURSOR = DATA_ORDERS_INITIAL_CURSOR;
const GET_NOTIFICATIONS = "/notifications";
/** L2-only; no query params. */
const GET_AUTH_API_KEYS = "/auth/api-keys";

export interface L2Creds {
  apiKey: string;
  secret: string;
  passphrase: string;
  funderAddress: string;
  /** Polygon signer address (EOA) that derived the API key; use for POLY_ADDRESS header. */
  polyAddress: string;
}

export interface L2Headers {
  POLY_ADDRESS: string;
  POLY_SIGNATURE: string;
  POLY_TIMESTAMP: string;
  POLY_API_KEY: string;
  POLY_PASSPHRASE: string;
}

/**
 * Build Polymarket L2 HMAC signature (matches SDK: timestamp + method + requestPath + body).
 * Secret is base64; output is url-safe base64.
 */
function buildPolyHmacSignature(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string
): string {
  let message = `${timestamp}${method}${requestPath}`;
  if (body !== undefined && body !== "") {
    message += body;
  }
  const key = Buffer.from(secret, "base64");
  const sig = crypto.createHmac("sha256", key).update(message).digest("base64");
  return sig.replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Build L2 auth headers for a request. POLY_ADDRESS must be the Polygon signer (EOA) that derived the API key.
 */
export function buildL2Headers(
  creds: L2Creds,
  method: string,
  requestPath: string,
  body?: string
): L2Headers {
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = buildPolyHmacSignature(
    creds.secret,
    timestamp,
    method,
    requestPath,
    body
  );
  return {
    POLY_ADDRESS: creds.polyAddress.toLowerCase(),
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: String(timestamp),
    POLY_API_KEY: creds.apiKey,
    POLY_PASSPHRASE: creds.passphrase,
  };
}

/**
 * Canonical request path and URL for an L2 GET. Single place for query-string and path construction.
 * For paths in PATH_ONLY_SIGNING_GET_PATHS (e.g. /data/orders), clobGetWithL2Raw signs path-only; URL still includes query.
 */
export function buildRequestPathForGet(
  path: string,
  params: Record<string, string | number | undefined> = {}
): { url: string; requestPath: string } {
  const url = new URL(path, CLOB_HOST);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });
  const pathOnly = path.startsWith("/") ? path : `/${path}`;
  const requestPath =
    url.searchParams.toString().length > 0 ? `${pathOnly}?${url.searchParams.toString()}` : pathOnly;
  return { url: url.toString(), requestPath };
}

/**
 * Perform a GET with L2 auth and return status + body + requestPath (no throw). Canonical flow for probes and validation.
 * For paths in PATH_ONLY_SIGNING_GET_PATHS (e.g. /data/orders), the signed requestPath is path-only; query params
 * are still sent in the URL (SDK-compatible behavior).
 */
export async function clobGetWithL2Raw(
  creds: L2Creds,
  path: string,
  params: Record<string, string | number | undefined> = {},
  opts?: { signal?: AbortSignal }
): Promise<{ status: number; body: string; requestPath: string }> {
  const { url, requestPath } = buildRequestPathForGet(path, params);
  const pathNorm = path.startsWith("/") ? path : `/${path}`;
  const signRequestPath = PATH_ONLY_SIGNING_GET_PATHS.has(pathNorm) ? pathNorm : requestPath;
  const headers = buildL2Headers(creds, "GET", signRequestPath);

  const res = await fetch(url, {
    method: "GET",
    signal: opts?.signal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      POLY_ADDRESS: headers.POLY_ADDRESS,
      POLY_SIGNATURE: headers.POLY_SIGNATURE,
      POLY_TIMESTAMP: headers.POLY_TIMESTAMP,
      POLY_API_KEY: headers.POLY_API_KEY,
      POLY_PASSPHRASE: headers.POLY_PASSPHRASE,
    },
  });
  const body = await res.text();
  return { status: res.status, body, requestPath: signRequestPath };
}

/**
 * Perform a GET request to the CLOB with L2 auth. Uses canonical buildRequestPathForGet + buildL2Headers.
 */
export async function clobGetWithL2<T>(
  creds: L2Creds,
  path: string,
  params: Record<string, string | number | undefined> = {},
  opts?: { signal?: AbortSignal }
): Promise<T> {
  const { status, body } = await clobGetWithL2Raw(creds, path, params, opts);
  if (status !== 200) {
    throw new Error(`CLOB GET ${path} failed: ${status} ${statusTextFor(status)}${body ? ` ${body}` : ""}`);
  }
  return JSON.parse(body || "null") as T;
}

function statusTextFor(status: number): string {
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 405) return "Method Not Allowed";
  if (status === 400) return "Bad Request";
  if (status >= 500) return "Server Error";
  return "Error";
}

/** Response shape from GET /data/orders (first page or paginated). */
export interface OpenOrdersResponse {
  data?: unknown[];
  next_cursor?: string;
}

/**
 * Fetch open orders (first page). Uses GET /data/orders with next_cursor=MA== (SDK-compatible; path-only signing).
 */
export async function fetchOpenOrdersL2(creds: L2Creds, opts?: { signal?: AbortSignal }): Promise<unknown[]> {
  const response = (await clobGetWithL2<OpenOrdersResponse>(
    creds,
    GET_DATA_ORDERS,
    { next_cursor: INITIAL_CURSOR },
    opts
  )) as OpenOrdersResponse;
  const data = response?.data ?? [];
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch open orders (first page) without throwing. Returns status, parsed data when status is 200, and error message otherwise.
 * Use for live open-orders service so callers can expose status/error in diagnostics.
 */
export async function fetchOpenOrdersL2Raw(creds: L2Creds, opts?: { signal?: AbortSignal }): Promise<{
  status: number;
  data: unknown[];
  error: string | null;
}> {
  const { status, body } = await clobGetWithL2Raw(creds, GET_DATA_ORDERS, {
    next_cursor: INITIAL_CURSOR,
  }, opts);
  if (status !== 200) {
    const snippet = body && body.length > 200 ? `${body.slice(0, 200)}...` : body || "";
    return { status, data: [], error: `${statusTextFor(status)}${snippet ? `: ${snippet}` : ""}` };
  }
  try {
    const parsed = JSON.parse(body || "{}") as OpenOrdersResponse;
    const data = parsed?.data ?? [];
    return { status: 200, data: Array.isArray(data) ? data : [], error: null };
  } catch {
    return { status: 200, data: [], error: "Failed to parse orders response" };
  }
}

/**
 * Fetch first page of trades (fills). Returns array of trades.
 * Polymarket CLOB requires NO query params on the first request to GET /data/trades;
 * sending next_cursor or other params on the first page yields 400 "Invalid trade params payload".
 * Use fetchAllTradesL2 for paginated fetch (first page no params, later pages next_cursor only).
 */
export async function fetchTradesL2(creds: L2Creds, opts?: { signal?: AbortSignal }): Promise<unknown[]> {
  const response = (await clobGetWithL2<{ data?: unknown[]; next_cursor?: string }>(
    creds,
    GET_TRADES,
    {},
    opts
  )) as { data?: unknown[]; next_cursor?: string };
  const data = response?.data ?? [];
  return Array.isArray(data) ? data : [];
}

export interface FetchAllTradesResult {
  trades: unknown[];
  pagesFetched: number;
}

/** Log a single line for trades pagination (no secrets). */
function logTradesPage(opts: {
  pageNumber: number;
  isFirstPage: boolean;
  paramsSummary: string;
  receivedNextCursor: string | null;
  responseHasNextCursor: boolean;
  tradeCount: number;
}): void {
  console.info("[l2-readonly][trades-pagination]", JSON.stringify(opts));
}

/** Polymarket end-of-pagination sentinel (SDK END_CURSOR). Do not request another page with this value. */
const TRADES_END_CURSOR = "LTE=";

/**
 * Validates next_cursor from API: must be a non-empty string and not the end sentinel. Returns null if invalid (stops pagination).
 * Avoids sending end sentinel (LTE=) or malformed values to /data/trades (server returns 400 "Invalid trade params payload").
 */
function parseTradesNextCursor(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "" || s === TRADES_END_CURSOR) return null;
  return s;
}

/**
 * Fetch all trades (fills) for the authenticated user via pagination.
 * First page: NO params (Polymarket rejects any params on first request with 400 "Invalid trade params payload").
 * Later pages: only next_cursor from the previous response; no other query params.
 * Loops until next_cursor is absent, empty, or malformed. Dedupe by trade id when consuming.
 */
export async function fetchAllTradesL2(creds: L2Creds): Promise<FetchAllTradesResult> {
  const all: unknown[] = [];
  let cursor: string | null = null;
  let pagesFetched = 0;
  while (true) {
    const pageNumber = pagesFetched + 1;
    const isFirstPage = cursor === null;
    const params: Record<string, string> = isFirstPage ? {} : { next_cursor: cursor as string };
    const paramsSummary = isFirstPage ? "{}" : JSON.stringify({ next_cursor: "(present)" });

    try {
      const response = (await clobGetWithL2<{ data?: unknown[]; next_cursor?: unknown }>(
        creds,
        GET_TRADES,
        params
      )) as { data?: unknown[]; next_cursor?: unknown };
      const data = response?.data ?? [];
      const tradeCount = Array.isArray(data) ? data.length : 0;
      if (Array.isArray(data)) {
        for (const row of data) all.push(row);
      }
      pagesFetched++;

      const nextRaw = response?.next_cursor;
      const next = parseTradesNextCursor(nextRaw);

      logTradesPage({
        pageNumber,
        isFirstPage,
        paramsSummary,
        receivedNextCursor: cursor,
        responseHasNextCursor: next != null,
        tradeCount,
      });

      if (next == null || (Array.isArray(data) && data.length === 0)) break;
      cursor = next;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const pageLabel = isFirstPage ? "first page (no params)" : `page ${pageNumber} (next_cursor)`;
      throw new Error(
        `CLOB GET ${GET_TRADES} failed on ${pageLabel}: ${msg}. Params: ${paramsSummary}`
      );
    }
  }
  return { trades: all, pagesFetched };
}

export type CredentialValidationCode =
  | "credentials_invalid"
  | "validation_request_malformed"
  | "clob_unavailable"
  | "unexpected";

export interface CredentialValidationDiagnostics {
  validationMethodUsed: string;
  httpStatus: number;
  errorBody?: string | null;
}

export interface CredentialValidationFailure {
  ok: false;
  error: string;
  code: CredentialValidationCode;
  diagnostics?: CredentialValidationDiagnostics;
}

export interface CredentialValidationSuccess {
  ok: true;
  validationMethodUsed: string;
}

export interface AuthoritativeValidationResult {
  apiKeysOk: boolean;
  tradesOk: boolean;
  /** GET /data/orders with path-only signing (SDK-compatible). */
  dataOrdersOk: boolean;
  /** Strong auth on core endpoints (api-keys + trades). */
  strongAuthOk: boolean;
  /** overallOk = strongAuthOk (dataOrdersOk reported for diagnostics). */
  overallOk: boolean;
  /** No secrets; safe to log/persist. Includes requestPath for each probe for init diagnostics. */
  diagnostics: {
    apiKeysStatus: number;
    tradesStatus: number;
    dataOrdersStatus: number;
    apiKeysRequestPath: string;
    tradesRequestPath: string;
    dataOrdersRequestPath: string;
    apiKeysBodySnippet?: string | null;
    tradesBodySnippet?: string | null;
    dataOrdersBodySnippet?: string | null;
  };
}

export async function validateCredentialsWithClobAuthoritative(
  creds: L2Creds,
  opts?: { signal?: AbortSignal }
): Promise<AuthoritativeValidationResult> {
  const [apiKeys, trades, dataOrders] = await Promise.all([
    clobGetWithL2Raw(creds, GET_AUTH_API_KEYS, {}, opts),
    clobGetWithL2Raw(creds, GET_TRADES, {}, opts),
    clobGetWithL2Raw(creds, GET_DATA_ORDERS, { next_cursor: INITIAL_CURSOR }, opts),
  ]);

  const apiKeysOk = apiKeys.status === 200;
  const tradesOk = trades.status === 200;
  const dataOrdersOk = dataOrders.status === 200;
  /** Require all three so init does not store creds that fail on GET /data/orders (worker startup). */
  const strongAuthOk = apiKeysOk && tradesOk && dataOrdersOk;
  const overallOk = strongAuthOk;

  const snippet = (b: string, max = 200) =>
    b && b.length > max ? `${b.slice(0, max)}...` : b || null;

  return {
    apiKeysOk,
    tradesOk,
    dataOrdersOk,
    strongAuthOk,
    overallOk,
    diagnostics: {
      apiKeysStatus: apiKeys.status,
      tradesStatus: trades.status,
      dataOrdersStatus: dataOrders.status,
      apiKeysRequestPath: apiKeys.requestPath,
      tradesRequestPath: trades.requestPath,
      dataOrdersRequestPath: dataOrders.requestPath,
      apiKeysBodySnippet: snippet(apiKeys.body),
      tradesBodySnippet: snippet(trades.body),
      dataOrdersBodySnippet: snippet(dataOrders.body),
    },
  };
}

/**
 * Credential validation for init and preflight. Uses authoritative multi-endpoint check; success only when overallOk.
 * Maps to legacy success/failure shape for init-credentials compatibility.
 */
export async function validateCredentialsWithClob(
  creds: L2Creds,
  _signatureType: number = 2
): Promise<CredentialValidationSuccess | CredentialValidationFailure> {
  try {
    const result = await validateCredentialsWithClobAuthoritative(creds);

    if (result.strongAuthOk) {
      return {
        ok: true,
        validationMethodUsed: "authoritative_multi_endpoint",
      };
    }

    const diag: CredentialValidationDiagnostics = {
      validationMethodUsed: "authoritative_multi_endpoint",
      httpStatus: result.diagnostics.dataOrdersStatus,
      errorBody:
        result.diagnostics.dataOrdersBodySnippet ??
        result.diagnostics.tradesBodySnippet ??
        result.diagnostics.apiKeysBodySnippet ??
        null,
    };

    if (
      result.diagnostics.apiKeysStatus === 401 ||
      result.diagnostics.tradesStatus === 401 ||
      result.diagnostics.dataOrdersStatus === 401 ||
      [
        result.diagnostics.apiKeysBodySnippet,
        result.diagnostics.tradesBodySnippet,
        result.diagnostics.dataOrdersBodySnippet,
      ].some(
        (b) => b && /Unauthorized|Invalid api key/i.test(b)
      )
    ) {
      return {
        ok: false,
        error: "Credentials invalid or rejected on one or more endpoints (api-keys, trades, orders).",
        code: "credentials_invalid",
        diagnostics: diag,
      };
    }
    if (
      result.diagnostics.apiKeysStatus === 400 ||
      result.diagnostics.tradesStatus === 400 ||
      result.diagnostics.dataOrdersStatus === 400
    ) {
      return {
        ok: false,
        error: "Validation request malformed on one or more endpoints.",
        code: "validation_request_malformed",
        diagnostics: diag,
      };
    }
    if (
      result.diagnostics.apiKeysStatus >= 500 ||
      result.diagnostics.tradesStatus >= 500 ||
      result.diagnostics.dataOrdersStatus >= 500
    ) {
      return {
        ok: false,
        error: "CLOB unavailable or temporary failure.",
        code: "clob_unavailable",
        diagnostics: diag,
      };
    }
    return {
      ok: false,
      error: `Validation failed (apiKeys: ${result.diagnostics.apiKeysStatus}, trades: ${result.diagnostics.tradesStatus}, dataOrders: ${result.diagnostics.dataOrdersStatus}).`,
      code: "credentials_invalid",
      diagnostics: diag,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: msg || "Validation request failed.",
      code: "clob_unavailable",
      diagnostics: {
        validationMethodUsed: "authoritative_multi_endpoint",
        httpStatus: 0,
        errorBody: msg && msg.length <= 500 ? msg : msg ? `${msg.slice(0, 500)}...` : null,
      },
    };
  }
}
