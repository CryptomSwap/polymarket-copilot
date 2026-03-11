/**
 * Validates CREDENTIAL_ENCRYPTION_KEY for secure credential storage.
 * Used by init-credentials and sync-stats. Never exposes the key.
 *
 * Expected format (matches lib/crypto.ts):
 * - 64 hex characters (32 bytes), or
 * - 44+ base64 characters (32+ bytes decoded), or
 * - A passphrase of at least 32 characters (derived via scrypt).
 *
 * To generate a key for local/dev:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * Add the output to .env as: CREDENTIAL_ENCRYPTION_KEY=<paste>
 * Restart the dev server after changing .env.
 */

export interface CredentialEncryptionConfigResult {
  ok: true;
}

export interface CredentialEncryptionConfigError {
  ok: false;
  error: string;
  hint: string;
}

export type CredentialEncryptionConfig =
  | CredentialEncryptionConfigResult
  | CredentialEncryptionConfigError;

const HINT_MISSING =
  "Add CREDENTIAL_ENCRYPTION_KEY to your .env and restart the dev server. " +
  "Use a 32-byte key as base64, e.g. from: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"";

/**
 * Validates presence and basic shape/length of CREDENTIAL_ENCRYPTION_KEY.
 * Does not use or log the key. Safe to call from API routes.
 */
export function validateCredentialEncryptionConfig(): CredentialEncryptionConfig {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (raw == null || typeof raw !== "string") {
    return {
      ok: false,
      error: "CREDENTIAL_ENCRYPTION_KEY is not set",
      hint: HINT_MISSING,
    };
  }
  const str = raw.trim();
  if (str.length === 0) {
    return {
      ok: false,
      error: "CREDENTIAL_ENCRYPTION_KEY is empty",
      hint: HINT_MISSING,
    };
  }
  if (str.length < 32) {
    return {
      ok: false,
      error: "CREDENTIAL_ENCRYPTION_KEY must be at least 32 characters (or 64 hex / 44 base64)",
      hint: "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    };
  }
  if (/^[0-9a-fA-F]{64}$/.test(str)) {
    return { ok: true };
  }
  try {
    const decoded = Buffer.from(str, "base64");
    if (decoded.length >= 32) return { ok: true };
  } catch {
    // not valid base64; passphrase mode requires length >= 32 (already checked)
  }
  return { ok: true };
}

/** Returns true if encryption key is configured and valid; for debugging only. Do not expose secret. */
export function isCredentialEncryptionConfigured(): boolean {
  return validateCredentialEncryptionConfig().ok === true;
}
