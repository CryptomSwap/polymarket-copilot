/**
 * Polymarket credential derivation and server-side access.
 * Credentials are derived via L1 (e.g. MetaMask) and stored encrypted.
 * Read-only sync uses getStoredCredentials() + L2 HMAC only (no signer/private key).
 * TODO: For server-side order placement, use getStoredCredentials() + signer when implemented.
 */

import { Wallet } from "ethers";
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import {
  createClobClientForDerivation,
  type StoredApiKeyCreds,
} from "@/lib/polymarket/client";

export interface PolymarketAuthState {
  address?: string;
  funderAddress?: string;
  signatureType?: number;
  hasCredentials: boolean;
}

const VALID_SIGNATURE_TYPES = [0, 1, 2] as const;

export function isValidSignatureType(n: number): n is (typeof VALID_SIGNATURE_TYPES)[number] {
  return VALID_SIGNATURE_TYPES.includes(n as (typeof VALID_SIGNATURE_TYPES)[number]);
}

/**
 * Derive L2 API credentials (apiKey, secret, passphrase) from the EOA private key.
 * Uses Polymarket CLOB createOrDeriveApiKey. Server-side only.
 * @param privateKeyHex - EOA private key (0x-prefixed hex)
 * @returns Credentials (apiKey = SDK key); never expose to client
 */
export async function deriveCredentials(privateKeyHex: string): Promise<StoredApiKeyCreds> {
  const key = privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`;
  const wallet = new Wallet(key);
  const client = createClobClientForDerivation(wallet);
  const creds = await client.createOrDeriveApiKey();
  if (!creds?.key || !creds?.secret || !creds?.passphrase) {
    throw new Error("Derivation returned incomplete credentials");
  }
  return {
    apiKey: creds.key,
    secret: creds.secret,
    passphrase: creds.passphrase,
  };
}

/**
 * Get decrypted credentials from DB for the current connection.
 * Server-side only; use only for authenticated CLOB calls (e.g. future trading).
 * polyAddress (EOA) is the Polygon signer that derived the API key; use it for L2 POLY_ADDRESS header.
 */
export async function getStoredCredentials(): Promise<{
  apiKey: string;
  secret: string;
  passphrase: string;
  funderAddress: string;
  polyAddress: string;
  signatureType: number;
} | null> {
  const cred = await prisma.polymarketApiCredential.findFirst({
    orderBy: { updatedAt: "desc" },
    include: { connectedWallet: true },
  });
  if (!cred?.connectedWallet) return null;
  try {
    const secret = decrypt(cred.encryptedSecret);
    const passphrase = decrypt(cred.encryptedPassphrase);
    const polyAddress = cred.connectedWallet.eoaAddress?.trim()?.toLowerCase() || cred.funderAddress.toLowerCase();
    return {
      apiKey: cred.apiKey,
      secret,
      passphrase,
      funderAddress: cred.funderAddress,
      polyAddress,
      signatureType: cred.signatureType,
    };
  } catch {
    return null;
  }
}

/**
 * Check if any credentials exist (without decrypting).
 */
export async function hasStoredCredentials(): Promise<boolean> {
  const count = await prisma.polymarketApiCredential.count();
  return count > 0;
}

/**
 * Clear Polymarket session (delete all stored credentials). Connection can remain.
 */
export async function clearPolymarketSession(): Promise<void> {
  await prisma.polymarketApiCredential.deleteMany({});
}

/**
 * Clear stored credentials only for the given connection. Wallet connection is unchanged.
 */
export async function clearCredentialsForConnection(connectedWalletId: string): Promise<number> {
  const result = await prisma.polymarketApiCredential.deleteMany({
    where: { connectedWalletId },
  });
  return result.count;
}

/**
 * Get stored L2 credentials for read-only operations (e.g. user sync, WS).
 * No signer or POLYMARKET_SIGNER_PRIVATE_KEY required. Use with lib/polymarket/l2-readonly.
 * TODO: Manual execution / cron can call getStoredCredentials() then use l2-readonly for scheduled sync.
 */
export async function getStoredCredentialsForReadOnly(): Promise<{
  apiKey: string;
  secret: string;
  passphrase: string;
  funderAddress: string;
  polyAddress: string;
} | null> {
  return getStoredCredentials();
}
