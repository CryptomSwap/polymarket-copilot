/**
 * Credential save debug report (secret-safe).
 *
 * Writes:
 * - dump/credential-save-debug-report.json
 * - dump/credential-save-debug-report.md
 *
 * Safety:
 * - Never prints CREDENTIAL_ENCRYPTION_KEY, secrets, passphrases, or ciphertext.
 * - Only emits booleans, safe metadata, and high-level error categories.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { encrypt, decrypt } from "../lib/crypto";
import { validateCredentialEncryptionConfig } from "../lib/polymarket/credentials-env";

const DUMP_DIR = path.join(process.cwd(), "dump");

type ErrorInfo = {
  ok: boolean;
  category:
    | "missing_env"
    | "encryption_failure"
    | "db_write_failure"
    | "db_connect_failure"
    | "schema_validation_failure"
    | "read_back_verification_failure"
    | "unknown_failure";
  // Safe summary. No secrets, but can contain non-sensitive crypto/db hints.
  message?: string;
};

function normalizeCryptoErrorCategory(e: unknown): ErrorInfo["category"] {
  const msg = e instanceof Error ? e.message : String(e);
  // Node crypto common auth-tag failure when decrypting with the wrong key.
  if (/authenticate|auth tag|unable to authenticate|bad decrypt/i.test(msg)) {
    return "read_back_verification_failure";
  }
  if (/invalid encrypted payload/i.test(msg)) {
    return "read_back_verification_failure";
  }
  return "encryption_failure";
}

function normalizePrismaErrorCategory(e: unknown): ErrorInfo["category"] {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Unknown column|does not exist|undefined column|no such column/i.test(msg)) {
    return "schema_validation_failure";
  }
  if (/refused|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|timeout|ETIMEDOUT/i.test(msg)) {
    return "db_connect_failure";
  }
  if (/DATABASE_URL|postgresql|prisma.*(init|client).*fail|Invalid.*DATABASE_URL/i.test(msg)) {
    return "db_connect_failure";
  }
  return "db_write_failure";
}

function getErrorInfo(
  ok: boolean,
  category: ErrorInfo["category"],
  e?: unknown
): ErrorInfo {
  const safeMsg = ok
    ? undefined
    : e instanceof Error
      ? e.message
      : typeof e === "string"
        ? e
        : undefined;

  return { ok, category, message: safeMsg };
}

function safeEncryptionKeyKind(raw: string): {
  kind: "missing" | "hex_64" | "base64_32plus" | "passphrase_len32plus" | "unknown";
  trimmedLength: number;
} {
  const str = raw.trim();
  const trimmedLength = str.length;
  if (/^[0-9a-fA-F]{64}$/.test(str)) return { kind: "hex_64", trimmedLength };
  try {
    const decoded = Buffer.from(str, "base64");
    if (decoded.length >= 32) return { kind: "base64_32plus", trimmedLength };
  } catch {
    // ignore
  }
  if (trimmedLength >= 32) return { kind: "passphrase_len32plus", trimmedLength };
  return { kind: "unknown", trimmedLength };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const encryptionKeyRaw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  const encryptionKeyPresent = typeof encryptionKeyRaw === "string" && encryptionKeyRaw.trim().length > 0;
  const encryptionKeyKind = encryptionKeyPresent
    ? safeEncryptionKeyKind(encryptionKeyRaw as string)
    : { kind: "missing" as const, trimmedLength: 0 };

  const encryptionConfig = validateCredentialEncryptionConfig();

  let dryRunEncryptDecrypt: ErrorInfo;
  try {
    const plaintext = "credential-debug-roundtrip";
    const ciphertext = encrypt(plaintext);
    // We never print ciphertext; we only verify decrypt works with current key.
    const roundTrip = decrypt(ciphertext);
    const ok = roundTrip === plaintext;
    dryRunEncryptDecrypt = ok
      ? { ok: true, category: "unknown_failure" }
      : { ok: false, category: "encryption_failure", message: "decrypt mismatch" };
  } catch (e) {
    dryRunEncryptDecrypt = getErrorInfo(false, normalizeCryptoErrorCategory(e), e);
  }

  const databaseUrlPresent = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim().length > 0;

  // ---- Prisma connectivity + schema reachability probes ----
  let connectedWalletQuery: {
    ok: boolean;
    hasRow: boolean;
    rowId?: string;
    eoaAddressPresent?: boolean;
    funderAddressPresent?: boolean;
    signatureTypePresent?: boolean;
  } = { ok: false, hasRow: false };

  let connectedWalletWriteProbe: ErrorInfo = { ok: false, category: "db_write_failure" };
  let polymarketApiCredentialCount: { ok: boolean; count?: number; errorCategory?: string; message?: string } = { ok: false };
  let storedCredentialDecryptProbe: ErrorInfo = { ok: false, category: "unknown_failure" };

  try {
    const cw = await prisma.connectedWallet.findFirst({
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        eoaAddress: true,
        funderAddress: true,
        signatureType: true,
      },
    });
    connectedWalletQuery = {
      ok: true,
      hasRow: Boolean(cw),
      rowId: cw?.id,
      eoaAddressPresent: Boolean(cw?.eoaAddress),
      funderAddressPresent: Boolean(cw?.funderAddress),
      signatureTypePresent: typeof cw?.signatureType === "number",
    };

    // Safe write probe: if a row exists, update it with identical values.
    if (cw) {
      const updateRes = await prisma.connectedWallet.update({
        where: { id: cw.id },
        data: {
          eoaAddress: cw.eoaAddress,
          funderAddress: cw.funderAddress,
          signatureType: cw.signatureType,
        },
        select: { id: true },
      });
      connectedWalletWriteProbe = {
        ok: true,
        category: "unknown_failure",
        message: updateRes?.id ? undefined : "no update row id",
      };
    } else {
      // No row to update safely; skip write probe.
      connectedWalletWriteProbe = { ok: true, category: "unknown_failure" };
    }

    const count = await prisma.polymarketApiCredential.count();
    polymarketApiCredentialCount = { ok: true, count };

    if (count > 0) {
      const first = await prisma.polymarketApiCredential.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { encryptedSecret: true, encryptedPassphrase: true },
      });

      if (first) {
        try {
          const _secret = decrypt(first.encryptedSecret);
          const _passphrase = decrypt(first.encryptedPassphrase);
          // Do not print values; only verify they are non-empty.
          storedCredentialDecryptProbe = {
            ok: Boolean(_secret && _passphrase),
            category: "unknown_failure",
          };
        } catch (e) {
          storedCredentialDecryptProbe = getErrorInfo(false, normalizeCryptoErrorCategory(e), e);
        }
      }
    } else {
      storedCredentialDecryptProbe = {
        ok: true,
        category: "unknown_failure",
        message: "no stored credentials to decrypt",
      };
    }
  } catch (e) {
    const cat = normalizePrismaErrorCategory(e);
    connectedWalletQuery = { ok: false, hasRow: false };
    polymarketApiCredentialCount = { ok: false, errorCategory: cat, message: e instanceof Error ? e.message : undefined };
    connectedWalletWriteProbe = { ok: false, category: cat, message: e instanceof Error ? e.message : undefined };
    storedCredentialDecryptProbe = { ok: false, category: cat, message: e instanceof Error ? e.message : undefined };
  }

  // ---- Static code check: did connection route still swallow details? ----
  const connectionRoutePath = path.join(
    process.cwd(),
    "app/api/polymarket/connection/route.ts"
  );
  let connectionRouteErrorSwallowing = true;
  try {
    const src = await fs.readFile(connectionRoutePath, "utf8");
    // Old shape: only `{ error: "Failed to save connection" }` with no `code` / `hint`.
    connectionRouteErrorSwallowing = /return NextResponse\.json\(\s*\{\s*error:\s*"Failed to save connection"\s*\}\s*,/m.test(src);
  } catch {
    connectionRouteErrorSwallowing = true;
  }

  // ---- Likely failure category (for debugging) ----
  let likelyFailureCategory: ErrorInfo["category"] = "unknown_failure";
  if (!databaseUrlPresent) likelyFailureCategory = "db_connect_failure";
  else if (encryptionConfig.ok !== true) likelyFailureCategory = "missing_env";
  else if (!dryRunEncryptDecrypt.ok) likelyFailureCategory = "encryption_failure";
  else if (connectedWalletQuery.ok !== true || connectedWalletWriteProbe.ok !== true)
    likelyFailureCategory = "db_write_failure";
  else if (polymarketApiCredentialCount.ok === true && (polymarketApiCredentialCount.count ?? 0) > 0 && !storedCredentialDecryptProbe.ok) {
    likelyFailureCategory = storedCredentialDecryptProbe.category;
  } else {
    // Everything basic is green; still possible the specific saveConnection error is unrelated.
    likelyFailureCategory = "unknown_failure";
  }

  const report = {
    generatedAt,
    env: {
      DATABASE_URL_present: databaseUrlPresent,
      CREDENTIAL_ENCRYPTION_KEY_present: encryptionKeyPresent,
      CREDENTIAL_ENCRYPTION_KEY_kind: encryptionKeyKind.kind,
      CREDENTIAL_ENCRYPTION_KEY_length: encryptionKeyKind.trimmedLength,
      CREDENTIAL_ENCRYPTION_KEY_validation: encryptionConfig,
    },
    probes: {
      encrypt_decrypt_dry_run: dryRunEncryptDecrypt,
      prisma: {
        connectedWallet: {
          queryOk: connectedWalletQuery.ok,
          hasRow: connectedWalletQuery.hasRow,
          rowFieldsPresent: {
            eoaAddressPresent: connectedWalletQuery.eoaAddressPresent ?? false,
            funderAddressPresent: connectedWalletQuery.funderAddressPresent ?? false,
            signatureTypePresent: connectedWalletQuery.signatureTypePresent ?? false,
          },
        },
        connectedWalletWriteProbe: connectedWalletWriteProbe,
        polymarketApiCredential: {
          countOk: polymarketApiCredentialCount.ok,
          count: polymarketApiCredentialCount.count ?? null,
        },
        storedCredentialDecryptProbe: storedCredentialDecryptProbe,
      },
      connectionRouteErrorSwallowing: connectionRouteErrorSwallowing,
    },
    likelyFailureCategory,
    // High-signal hints for the operator. No secrets.
    hints: [
      !encryptionConfig.ok ? "Fix CREDENTIAL_ENCRYPTION_KEY (missing/invalid) and restart." : null,
      !dryRunEncryptDecrypt.ok ? "Encryption roundtrip failed; ensure CREDENTIAL_ENCRYPTION_KEY is valid." : null,
      connectedWalletQuery.ok !== true ? "Prisma connectedWallet probe failed; check DATABASE_URL and migrations/schema." : null,
      polymarketApiCredentialCount.ok === true &&
      (polymarketApiCredentialCount.count ?? 0) > 0 &&
      !storedCredentialDecryptProbe.ok
        ? "Stored credentials exist but can't be decrypted with current key; previously-saved creds likely need re-entry."
        : null,
    ].filter(Boolean),
  };

  const jsonPath = path.join(DUMP_DIR, "credential-save-debug-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const mdLines: string[] = [];
  mdLines.push("# Credential save debug report (secret-safe)");
  mdLines.push("");
  mdLines.push(`Generated: ${generatedAt}`);
  mdLines.push("");
  mdLines.push("## Likely failure category");
  mdLines.push("");
  mdLines.push("```");
  mdLines.push(String(likelyFailureCategory));
  mdLines.push("```");
  mdLines.push("");
  mdLines.push("## Env / key checks");
  mdLines.push("");
  mdLines.push("```json");
  mdLines.push(JSON.stringify(report.env, null, 2));
  mdLines.push("```");
  mdLines.push("");
  mdLines.push("## Probes");
  mdLines.push("");
  mdLines.push("```json");
  mdLines.push(JSON.stringify(report.probes, null, 2));
  mdLines.push("```");
  mdLines.push("");
  mdLines.push("## Operator hints");
  mdLines.push("");
  for (const h of report.hints) {
    mdLines.push("- " + h);
  }
  mdLines.push("");

  const mdPath = path.join(DUMP_DIR, "credential-save-debug-report.md");
  await fs.writeFile(mdPath, mdLines.join("\n"), "utf8");

  console.log("Wrote dump/credential-save-debug-report.{json,md}");

  await prisma.$disconnect();
}

main().catch((e) => {
  // Do not leak any env secrets here; only print non-sensitive errors.
  console.error("create-credential-save-debug-report failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

