/**
 * Server-side encryption for storing Polymarket API secret and passphrase.
 * Uses AES-256-GCM.
 *
 * CREDENTIAL_ENCRYPTION_KEY format (min 32 bytes effective):
 * - 64 hex chars (32 bytes), or
 * - 44+ base64 chars (32+ bytes), or
 * - passphrase of at least 32 characters (derived via scrypt).
 * Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function getEncryptionKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY must be set (32+ bytes, e.g. 64 hex chars or 44 base64)"
    );
  }
  const str = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(str)) {
    return Buffer.from(str, "hex").slice(0, KEY_LENGTH);
  }
  return crypto.scryptSync(str, "polymarket-copilot-salt", KEY_LENGTH);
}

/**
 * Encrypt plaintext for storage. Returns "iv:authTag:ciphertext" in base64.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, enc]);
  return combined.toString("base64");
}

/**
 * Decrypt a value produced by encrypt().
 */
export function decrypt(encoded: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(encoded, "base64");
  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted payload");
  }
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
