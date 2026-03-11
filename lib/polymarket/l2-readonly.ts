/**
 * Read-only L2 CLOB access using stored credentials only. No signer/private key.
 * Builds L2 HMAC headers and performs GET requests for orders and trades.
 * TODO: Manual execution / cron can call into this for scheduled sync.
 */

import * as crypto from "crypto";

const CLOB_HOST = "https://clob.polymarket.com";
const GET_OPEN_ORDERS = "/data/orders";
const GET_TRADES = "/data/trades";
/** Base64-encoded cursor for first page (matches @polymarket/clob-client). */
const INITIAL_CURSOR = "MA==";
const GET_NOTIFICATIONS = "/notifications";
/** L2-only; no query params. Preferred for credential validation. */
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
 * Perform a GET request to the CLOB with L2 auth. Query params are appended to URL; requestPath for signing is path only.
 */
export async function clobGetWithL2<T>(
  creds: L2Creds,
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = new URL(path, CLOB_HOST);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });
  const requestPath = path.startsWith("/") ? path : `/${path}`;
  const headers = buildL2Headers(creds, "GET", requestPath);

  const res = await fetch(url.toString(), {
    method: "GET",
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CLOB GET ${path} failed: ${res.status} ${res.statusText}${text ? ` ${text}` : ""}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Fetch open orders (first page). Returns array of orders.
 */
export async function fetchOpenOrdersL2(creds: L2Creds): Promise<unknown[]> {
  const response = (await clobGetWithL2<{ data?: unknown[]; next_cursor?: string }>(
    creds,
    GET_OPEN_ORDERS,
    { next_cursor: INITIAL_CURSOR }
  )) as { data?: unknown[]; next_cursor?: string };
  const data = response?.data ?? [];
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch trades (first page). Returns array of trades.
 */
export async function fetchTradesL2(creds: L2Creds): Promise<unknown[]> {
  const response = (await clobGetWithL2<{ data?: unknown[]; next_cursor?: string }>(
    creds,
    GET_TRADES,
    { next_cursor: INITIAL_CURSOR }
  )) as { data?: unknown[]; next_cursor?: string };
  const data = response?.data ?? [];
  return Array.isArray(data) ? data : [];
}

export interface FetchAllTradesResult {
  trades: unknown[];
  pagesFetched: number;
}

/**
 * Fetch all trades (fills) for the authenticated user via pagination.
 * First page: no params (avoids 400 "Invalid trade params payload"). Next pages: next_cursor from response.
 * Loops until next_cursor is absent or empty. Dedupe by trade id when consuming.
 */
export async function fetchAllTradesL2(creds: L2Creds): Promise<FetchAllTradesResult> {
  const all: unknown[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;
  while (true) {
    const params: Record<string, string> = cursor != null && cursor !== "" ? { next_cursor: cursor } : {};
    const response = (await clobGetWithL2<{ data?: unknown[]; next_cursor?: string }>(
      creds,
      GET_TRADES,
      params
    )) as { data?: unknown[]; next_cursor?: string };
    const data = response?.data ?? [];
    if (Array.isArray(data)) {
      for (const row of data) all.push(row);
    }
    pagesFetched++;
    const next = response?.next_cursor?.trim();
    if (!next || (Array.isArray(data) && data.length === 0)) break;
    cursor = next;
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

/**
 * Perform a GET with L2 auth and return status + body without throwing.
 * Caller can distinguish 200 vs 401 vs 400 vs 5xx for validation.
 */
async function clobGetWithL2Raw(
  creds: L2Creds,
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<{ status: number; body: string }> {
  const url = new URL(path, CLOB_HOST);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });
  const requestPath = path.startsWith("/") ? path : `/${path}`;
  const headers = buildL2Headers(creds, "GET", requestPath);

  const res = await fetch(url.toString(), {
    method: "GET",
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
  return { status: res.status, body };
}

/**
 * Lightweight credential validation: authenticated GET with no ambiguous params.
 * Tries GET /auth/api-keys first (no query params). Fallback: GET /balance-allowance?signature_type=N.
 * 200 => valid; 401 => invalid credentials; 400 => malformed validation request; 5xx => upstream.
 */
export async function validateCredentialsWithClob(
  creds: L2Creds,
  signatureType: number = 2
): Promise<CredentialValidationSuccess | CredentialValidationFailure> {
  const path = GET_AUTH_API_KEYS;
  const validationMethodUsed = "get_api_keys";

  try {
    const { status, body } = await clobGetWithL2Raw(creds, path, {});

    if (status === 200) {
      return { ok: true, validationMethodUsed };
    }

    const diag: CredentialValidationDiagnostics = {
      validationMethodUsed,
      httpStatus: status,
      errorBody: body && body.length <= 500 ? body : body ? `${body.slice(0, 500)}...` : null,
    };

    if (status === 401 || /Unauthorized|Invalid api key/i.test(body || "")) {
      return {
        ok: false,
        error: "Credentials invalid or expired.",
        code: "credentials_invalid",
        diagnostics: diag,
      };
    }
    if (status === 400 || /invalid.*payload|invalid.*param|bad request/i.test(body || "")) {
      return {
        ok: false,
        error: "Validation request malformed (validator bug or wrong endpoint).",
        code: "validation_request_malformed",
        diagnostics: diag,
      };
    }
    if (status >= 500 && status < 600) {
      return {
        ok: false,
        error: "CLOB unavailable or temporary failure.",
        code: "clob_unavailable",
        diagnostics: diag,
      };
    }
    return {
      ok: false,
      error: body || `Unexpected validation response (HTTP ${status}).`,
      code: "unexpected",
      diagnostics: diag,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const statusMatch = msg.match(/\b(\d{3})\b/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
    const diag: CredentialValidationDiagnostics = {
      validationMethodUsed,
      httpStatus: status || 0,
      errorBody: msg && msg.length <= 500 ? msg : msg ? `${msg.slice(0, 500)}...` : null,
    };
    if (status === 401 || /Unauthorized|Invalid api key/i.test(msg)) {
      return {
        ok: false,
        error: "Credentials invalid or expired.",
        code: "credentials_invalid",
        diagnostics: diag,
      };
    }
    if (status === 400 || /invalid.*payload|invalid.*param|bad request/i.test(msg)) {
      return {
        ok: false,
        error: "Validation request malformed (validator bug or wrong endpoint).",
        code: "validation_request_malformed",
        diagnostics: diag,
      };
    }
    if (status >= 500 && status < 600) {
      return {
        ok: false,
        error: "CLOB unavailable or temporary failure.",
        code: "clob_unavailable",
        diagnostics: diag,
      };
    }
    return {
      ok: false,
      error: msg || "Unexpected validation response.",
      code: "unexpected",
      diagnostics: diag,
    };
  }
}
