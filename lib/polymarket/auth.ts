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

/** Source of polyAddress when loading credentials (for diagnostics). */
export type PolyAddressSource =
  | "stored_credential"
  | "connected_wallet_fallback"
  | "funder_fallback";

/**
 * Resolve polyAddress and its source from a credential row and linked wallet.
 * Prefer stored polyAddress; else connectedWallet.eoaAddress; else funderAddress.
 */
export function resolvePolyAddressFromCred(
  cred: { polyAddress?: string | null; funderAddress: string },
  connectedWallet: { eoaAddress?: string | null }
): { polyAddress: string; polyAddressSource: PolyAddressSource } {
  const stored = cred.polyAddress?.trim()?.toLowerCase();
  if (stored) {
    return { polyAddress: stored, polyAddressSource: "stored_credential" };
  }
  const fromWallet = connectedWallet.eoaAddress?.trim()?.toLowerCase();
  if (fromWallet) {
    return { polyAddress: fromWallet, polyAddressSource: "connected_wallet_fallback" };
  }
  return {
    polyAddress: cred.funderAddress.toLowerCase(),
    polyAddressSource: "funder_fallback",
  };
}

/** Row shape for validity-aware ranking. Null validation fields count as not valid. */
export interface CredentialRowForRanking {
  id: string;
  updatedAt: Date;
  validationApiKeysOk: boolean | null;
  validationTradesOk: boolean | null;
  validationOrdersOk: boolean | null;
}

/** Strong-auth valid when apiKeys and trades have both passed at least once. Orders may still be false. */
export function isStrongAuthValidCredentialRow(row: CredentialRowForRanking): boolean {
  return (
    row.validationApiKeysOk === true &&
    row.validationTradesOk === true
  );
}

/**
 * Compare two credential rows for selection order under temporary strong-auth policy.
 * Strong-auth-valid rows (apiKeysOk && tradesOk) first.
 * Among those, newest updatedAt first; if tied, prefer validationOrdersOk === true.
 * Among not-strong-auth-valid, newest first (they will not be selected, but diagnostics are stable).
 * Returns negative if a should be chosen before b, positive if b before a, 0 if equal.
 */
export function rankCredentialRows(a: CredentialRowForRanking, b: CredentialRowForRanking): number {
  const aStrong = isStrongAuthValidCredentialRow(a);
  const bStrong = isStrongAuthValidCredentialRow(b);
  if (aStrong && !bStrong) return -1;
  if (!aStrong && bStrong) return 1;

  // If both are strong-auth-valid, newest first; break ties by ordersOk true > false.
  if (aStrong && bStrong) {
    const timeDiff = b.updatedAt.getTime() - a.updatedAt.getTime();
    if (timeDiff !== 0) return timeDiff;
    const aOrders = a.validationOrdersOk === true ? 1 : 0;
    const bOrders = b.validationOrdersOk === true ? 1 : 0;
    if (aOrders !== bOrders) return bOrders - aOrders;
    return 0;
  }

  // Neither strong-auth-valid: newest first.
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

export type CredentialSelectionReason =
  | "no_rows"
  | "no_strong_auth_valid_credential"
  | "strong_auth_valid_newest"
  | "strong_auth_valid_orders_warning";

export interface CredentialValidationSummary {
  apiKeysOk: boolean;
  tradesOk: boolean;
  ordersOk: boolean;
}

/**
 * Selection diagnostics: what was considered and why a credential was or wasn't chosen. No secrets; safe to log.
 */
export interface CredentialSelectionDiagnostics {
  credentialCount: number;
  chosenCredentialId: string | null;
  selectionReason: CredentialSelectionReason;
  credentialUpdatedAt: string | null;
  /** When a credential was chosen, its stored validation state. */
  validationSummary: CredentialValidationSummary | null;
  /** When a credential was chosen, whether another fully valid row existed. */
  hadFullyValidAlternatives: boolean;
}

const MAX_CANDIDATES = 20;

/** Short TTL reuses the same credential row + decrypt across hot paths (reduces Prisma pool churn). */
const CREDENTIAL_LOOKUP_CACHE_TTL_MS =
  Number(process.env.POLY_CREDENTIAL_CACHE_TTL_MS ?? "5000") || 5000;

type GetStoredCredentialsResult = {
  credential: StoredCredential | null;
  selectionDiagnostics: CredentialSelectionDiagnostics;
};

let credentialLookupCache: { expiresAt: number; data: GetStoredCredentialsResult } | null = null;

/** Call after credential upsert/delete so the next lookup sees fresh DB state immediately. */
export function invalidateCredentialLookupCache(): void {
  credentialLookupCache = null;
}

/**
 * From a sorted list (best first), choose the first row if it is strong-auth-valid; otherwise none.
 * Returns chosen index (0-based) or -1, plus reason and whether multiple strong-auth-valid rows existed.
 */
export function selectBestCredentialIndex(
  rows: CredentialRowForRanking[]
): { chosenIndex: number; selectionReason: CredentialSelectionReason; hadFullyValidAlternatives: boolean } {
  if (rows.length === 0) {
    return { chosenIndex: -1, selectionReason: "no_rows", hadFullyValidAlternatives: false };
  }
  const strongAuthCount = rows.filter(isStrongAuthValidCredentialRow).length;
  const best = rows[0];
  if (isStrongAuthValidCredentialRow(best)) {
    const hasOrdersWarning = best.validationOrdersOk !== true;
    return {
      chosenIndex: 0,
      selectionReason: hasOrdersWarning ? "strong_auth_valid_orders_warning" : "strong_auth_valid_newest",
      hadFullyValidAlternatives: strongAuthCount > 1,
    };
  }
  return {
    chosenIndex: -1,
    selectionReason: "no_strong_auth_valid_credential",
    hadFullyValidAlternatives: false,
  };
}

export type StoredCredential = {
  apiKey: string;
  secret: string;
  passphrase: string;
  funderAddress: string;
  polyAddress: string;
  polyAddressSource: PolyAddressSource;
  signatureType: number;
  credentialId: string;
};

/**
 * Get the best stored credential: prefers fully valid rows (apiKeysOk && tradesOk && ordersOk), then newest by updatedAt.
 * If no fully valid row exists, returns null (fail closed). No fallback to invalid/stale credentials.
 * Server-side only. selectionDiagnostics is always present (no secrets).
 */
export async function getStoredCredentials(): Promise<GetStoredCredentialsResult> {
  const now = Date.now();
  if (credentialLookupCache && now < credentialLookupCache.expiresAt) {
    return credentialLookupCache.data;
  }

  const candidates = await prisma.polymarketApiCredential.findMany({
    orderBy: { updatedAt: "desc" },
    take: MAX_CANDIDATES,
    include: { connectedWallet: true },
  });
  const credentialCount = await prisma.polymarketApiCredential.count();

  const forRanking: CredentialRowForRanking[] = candidates.map((c) => ({
    id: c.id,
    updatedAt: c.updatedAt,
    validationApiKeysOk: c.validationApiKeysOk,
    validationTradesOk: c.validationTradesOk,
    validationOrdersOk: c.validationOrdersOk,
  }));
  forRanking.sort(rankCredentialRows);

  const { chosenIndex, selectionReason, hadFullyValidAlternatives } = selectBestCredentialIndex(forRanking);

  const buildDiagnostics = (
    chosenId: string | null,
    updatedAt: string | null,
    validationSummary: CredentialValidationSummary | null
  ): CredentialSelectionDiagnostics => ({
    credentialCount,
    chosenCredentialId: chosenId,
    selectionReason,
    credentialUpdatedAt: updatedAt,
    validationSummary,
    hadFullyValidAlternatives,
  });

  let out: GetStoredCredentialsResult;

  if (chosenIndex < 0) {
    out = {
      credential: null,
      selectionDiagnostics: buildDiagnostics(null, null, null),
    };
  } else {
    const chosenId = forRanking[chosenIndex].id;
    const cred = candidates.find((c) => c.id === chosenId);
    if (!cred?.connectedWallet) {
      out = {
        credential: null,
        selectionDiagnostics: buildDiagnostics(null, null, null),
      };
    } else {
      try {
        const secret = decrypt(cred.encryptedSecret);
        const passphrase = decrypt(cred.encryptedPassphrase);
        const { polyAddress, polyAddressSource } = resolvePolyAddressFromCred(cred, cred.connectedWallet);
        const validationSummary: CredentialValidationSummary = {
          apiKeysOk: cred.validationApiKeysOk === true,
          tradesOk: cred.validationTradesOk === true,
          ordersOk: cred.validationOrdersOk === true,
        };
        out = {
          credential: {
            apiKey: cred.apiKey,
            secret,
            passphrase,
            funderAddress: cred.funderAddress,
            polyAddress,
            polyAddressSource,
            signatureType: cred.signatureType,
            credentialId: cred.id,
          },
          selectionDiagnostics: buildDiagnostics(
            cred.id,
            cred.updatedAt.toISOString(),
            validationSummary
          ),
        };
      } catch {
        out = {
          credential: null,
          selectionDiagnostics: buildDiagnostics(null, null, null),
        };
      }
    }
  }

  credentialLookupCache = {
    data: out,
    expiresAt: Date.now() + CREDENTIAL_LOOKUP_CACHE_TTL_MS,
  };
  return out;
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
  invalidateCredentialLookupCache();
  return result.count;
}

/**
 * Get stored L2 credentials for read-only operations (e.g. user sync, WS).
 * Returns the credential part only; use getStoredCredentials() when selection diagnostics are needed.
 */
export async function getStoredCredentialsForReadOnly(): Promise<StoredCredential | null> {
  const { credential } = await getStoredCredentials();
  return credential;
}
