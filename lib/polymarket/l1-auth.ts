/**
 * Backend Polymarket L1 auth: build headers and call create/derive API key endpoints.
 * Uses signature produced client-side (e.g. MetaMask). No server-side private key required for init.
 * TODO: For server-side authenticated trading, use getStoredCredentials() + signer when needed.
 */

const CLOB_HOST = "https://clob.polymarket.com";
const DERIVE_API_KEY = "/auth/derive-api-key";
const CREATE_API_KEY = "/auth/api-key";

export interface L1Headers {
  POLY_ADDRESS: string;
  POLY_SIGNATURE: string;
  POLY_TIMESTAMP: string;
  POLY_NONCE: string;
}

/**
 * Build L1 auth headers from client-supplied signature and params.
 */
export function buildL1Headers(params: {
  polygonAddress: string;
  signature: string;
  timestamp: number;
  nonce: number;
}): L1Headers {
  return {
    POLY_ADDRESS: params.polygonAddress.toLowerCase(),
    POLY_SIGNATURE: params.signature,
    POLY_TIMESTAMP: String(params.timestamp),
    POLY_NONCE: String(params.nonce),
  };
}

export interface ApiKeyCredsRaw {
  apiKey: string;
  secret: string;
  passphrase: string;
}

function isApiKeyCredsRaw(obj: unknown): obj is ApiKeyCredsRaw {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "apiKey" in obj &&
    "secret" in obj &&
    "passphrase" in obj &&
    typeof (obj as ApiKeyCredsRaw).apiKey === "string" &&
    typeof (obj as ApiKeyCredsRaw).secret === "string" &&
    typeof (obj as ApiKeyCredsRaw).passphrase === "string"
  );
}

/**
 * Call Polymarket derive-api-key (GET). Returns existing API credentials if any.
 */
export async function callDeriveApiKey(headers: L1Headers): Promise<ApiKeyCredsRaw | null> {
  const url = `${CLOB_HOST}${DERIVE_API_KEY}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      POLY_ADDRESS: headers.POLY_ADDRESS,
      POLY_SIGNATURE: headers.POLY_SIGNATURE,
      POLY_TIMESTAMP: headers.POLY_TIMESTAMP,
      POLY_NONCE: headers.POLY_NONCE,
    },
  });

  if (res.status === 404 || res.status === 400) {
    return null;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Derive API key failed: ${res.status} ${res.statusText}${text ? ` ${text}` : ""}`);
  }

  const data = (await res.json()) as unknown;
  if (!isApiKeyCredsRaw(data)) {
    return null;
  }
  return data;
}

/**
 * Call Polymarket create api-key (POST). Creates new API credentials.
 */
export async function callCreateApiKey(headers: L1Headers): Promise<ApiKeyCredsRaw> {
  const url = `${CLOB_HOST}${CREATE_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      POLY_ADDRESS: headers.POLY_ADDRESS,
      POLY_SIGNATURE: headers.POLY_SIGNATURE,
      POLY_TIMESTAMP: headers.POLY_TIMESTAMP,
      POLY_NONCE: headers.POLY_NONCE,
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create API key failed: ${res.status} ${res.statusText}${text ? ` ${text}` : ""}`);
  }

  const data = (await res.json()) as unknown;
  if (!isApiKeyCredsRaw(data)) {
    throw new Error("Create API key returned invalid credentials shape");
  }
  return data;
}

/**
 * Create or derive API credentials using L1 headers (client-signed).
 * Tries derive first; if no credentials, calls create.
 */
export async function createOrDeriveApiKeyWithL1Headers(params: {
  polygonAddress: string;
  signature: string;
  timestamp: number;
  nonce: number;
}): Promise<ApiKeyCredsRaw> {
  const headers = buildL1Headers(params);

  const derived = await callDeriveApiKey(headers).catch(() => null);
  if (derived?.apiKey && derived?.secret && derived?.passphrase) {
    return derived;
  }

  return callCreateApiKey(headers);
}
