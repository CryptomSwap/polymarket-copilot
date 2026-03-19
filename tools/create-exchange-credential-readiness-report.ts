/**
 * Exchange credential readiness report for liveReadiness.exchangeCredentialValidationReady.
 *
 * Writes:
 * - dump/exchange-credential-readiness-report.json
 * - dump/exchange-credential-readiness-report.md
 *
 * npm run dump:exchange-credential-readiness-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getStoredCredentials } from "../lib/polymarket/auth";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";

function safeJsonParse(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const creds = await getStoredCredentials();
  const chosenId = creds.selectionDiagnostics.chosenCredentialId;

  const chosenRow = chosenId
    ? await prisma.polymarketApiCredential.findUnique({
        where: { id: chosenId },
        select: {
          id: true,
          funderAddress: true,
          polyAddress: true,
          lastValidatedAt: true,
          validationApiKeysOk: true,
          validationTradesOk: true,
          validationOrdersOk: true,
          updatedAt: true,
        },
      })
    : null;

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });
  const meta = safeJsonParse(hb?.metadataJson ?? null);
  const runtimeHealth = (meta?.runtimeHealth ?? null) as Record<string, unknown> | null;
  const liveReadiness = (meta?.liveReadiness ?? null) as Record<string, unknown> | null;
  const rhMeta = (runtimeHealth?.metadata ?? null) as Record<string, unknown> | null;

  const readyFlagFromHeartbeat =
    rhMeta?.exchangeCredentialValidationReady === true ||
    (typeof rhMeta?.exchangeCredentialValidationReady === "string" &&
      rhMeta.exchangeCredentialValidationReady === "true");

  const maxAgeMs = 10 * 60 * 1000;
  const lastValidatedAtIso = chosenRow?.lastValidatedAt?.toISOString() ?? null;
  const ageMs = lastValidatedAtIso ? Date.now() - new Date(lastValidatedAtIso).getTime() : null;

  const readiness = {
    selectedCredentialPresent: creds.credential != null,
    selectedCredentialId: chosenId ?? null,
    selectedValidationSummary: creds.selectionDiagnostics.validationSummary,
    selectedLastValidatedAt: lastValidatedAtIso,
    selectedLastValidatedAgeMs: ageMs,
    readyByPolicy:
      chosenRow != null &&
      chosenRow.validationApiKeysOk === true &&
      chosenRow.validationTradesOk === true &&
      chosenRow.lastValidatedAt != null &&
      Date.now() - chosenRow.lastValidatedAt.getTime() <= maxAgeMs,
    maxAgeMs,
  };

  const report = {
    generatedAt,
    workerName: WORKER_NAME,
    workerHeartbeatAt: hb?.lastSeenAt?.toISOString() ?? null,
    liveReadinessBlockingReasons: Array.isArray(liveReadiness?.blockingReasons)
      ? (liveReadiness?.blockingReasons as string[])
      : [],
    selectedCredential: {
      diagnostics: creds.selectionDiagnostics,
      dbRow: chosenRow
        ? {
            id: chosenRow.id,
            funderAddress: chosenRow.funderAddress,
            polyAddress: chosenRow.polyAddress,
            lastValidatedAt: chosenRow.lastValidatedAt?.toISOString() ?? null,
            updatedAt: chosenRow.updatedAt.toISOString(),
            validationApiKeysOk: chosenRow.validationApiKeysOk,
            validationTradesOk: chosenRow.validationTradesOk,
            validationOrdersOk: chosenRow.validationOrdersOk,
          }
        : null,
    },
    readinessComputed: readiness,
    heartbeatRuntimeHealthFlag: {
      exchangeCredentialValidationReady: rhMeta?.exchangeCredentialValidationReady ?? null,
      exchangeCredentialLastValidatedAt: rhMeta?.exchangeCredentialLastValidatedAt ?? null,
      exchangeCredentialPreflight: rhMeta?.exchangeCredentialPreflight ?? null,
      readyFlagFromHeartbeat,
    },
    interpretation: {
      whyNotReady:
        !readiness.selectedCredentialPresent
          ? "No selected strong-auth-valid credential (apiKeysOk && tradesOk)."
          : !readiness.readyByPolicy
            ? "Selected credential exists but validation is missing/false or too old."
            : "Credential appears ready; if readiness still blocks, wiring/state propagation is stale.",
      fixDirection:
        "If runtime health flag is false but DB row shows valid+recent, check whether worker startup preflight ran (StreamRuntime startup) and whether heartbeat includes updated runtimeHealth.metadata.*.",
    },
  };

  const md = [
    "# Exchange credential readiness report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Selected credential (DB + selection diagnostics)",
    "",
    "```json",
    JSON.stringify(report.selectedCredential, null, 2),
    "```",
    "",
    "## Readiness computed",
    "",
    "```json",
    JSON.stringify(report.readinessComputed, null, 2),
    "```",
    "",
    "## Heartbeat runtimeHealth flag (what worker wired into liveReadiness)",
    "",
    "```json",
    JSON.stringify(report.heartbeatRuntimeHealthFlag, null, 2),
    "```",
    "",
    "## liveReadiness.blockingReasons",
    "",
    "```json",
    JSON.stringify(report.liveReadinessBlockingReasons, null, 2),
    "```",
    "",
  ].join("\n");

  await fs.writeFile(
    path.join(DUMP_DIR, "exchange-credential-readiness-report.json"),
    JSON.stringify(report, null, 2)
  );
  await fs.writeFile(path.join(DUMP_DIR, "exchange-credential-readiness-report.md"), md);
  console.log("Wrote dump/exchange-credential-readiness-report.{json,md}");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

