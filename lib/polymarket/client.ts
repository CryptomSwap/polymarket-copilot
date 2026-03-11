/**
 * Polymarket CLOB client factory and HTTP helpers.
 * Credentials are created/derived server-side and never sent to the client.
 */

import { ClobClient, type ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { POLYMARKET_CHAIN_ID, POLYMARKET_HOST } from "@/lib/config";

const CLOB_HOST = "https://clob.polymarket.com";

const DEFAULT_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

export function getPolymarketApiUrl(path: string): string {
  const base = POLYMARKET_HOST.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

/** Generic GET for Polymarket HTTP API (e.g. Gamma). TODO: Add auth when needed. */
export async function polymarketGet<T>(path: string): Promise<T> {
  const url = getPolymarketApiUrl(path);
  const res = await fetch(url, { method: "GET", headers: DEFAULT_HEADERS });
  if (!res.ok) throw new Error(`Polymarket API error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export function getClobHost(): string {
  return CLOB_HOST;
}

export function getClobChainId(): number {
  return POLYMARKET_CHAIN_ID;
}

/** Internal shape for storage (apiKey column). SDK uses `key`. */
export interface StoredApiKeyCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
}

/**
 * Create a CLOB client for L1 operations (e.g. derive API key).
 * Uses signer (ethers Wallet) with private key. Server-side only.
 * TODO: Use for trading when order placement is implemented.
 */
export function createClobClientForDerivation(signer: Wallet): ClobClient {
  return new ClobClient(CLOB_HOST, POLYMARKET_CHAIN_ID, signer);
}

/**
 * Create a fully authenticated CLOB client for L2 (trading) operations.
 * Pass the derived apiKeyCreds (SDK shape: key, secret, passphrase), signatureType, and funderAddress.
 * TODO: Use when implementing order placement and other authenticated CLOB calls.
 */
export function createAuthenticatedClobClient(
  signer: Wallet,
  apiKeyCreds: ApiKeyCreds,
  signatureType: number,
  funderAddress: string
): ClobClient {
  return new ClobClient(
    CLOB_HOST,
    POLYMARKET_CHAIN_ID,
    signer,
    apiKeyCreds,
    signatureType,
    funderAddress
  );
}
