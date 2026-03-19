/**
 * Exchange truth availability report (exchange_truth_unavailable).
 *
 * Writes:
 * - dump/exchange-truth-availability-report.json
 * - dump/exchange-truth-availability-report.md
 *
 * npm run dump:exchange-truth-availability-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getStoredCredentials } from "../lib/polymarket/auth";
import { validateCredentialsWithClobAuthoritative } from "../lib/polymarket/l2-readonly";
import { fetchOpenOrdersL2 } from "../lib/polymarket/l2-readonly";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";
const EXCHANGE_TRUTH_TRANSIENT_GRACE_MS = Number(process.env.EXCHANGE_TRUTH_TRANSIENT_GRACE_MS ?? "60000") || 60_000;

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

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });
  const meta = safeJsonParse(hb?.metadataJson ?? null);
  const runtimeHealth = (meta?.runtimeHealth ?? null) as Record<string, unknown> | null;
  const runtimeSafety = (meta?.runtimeSafety ?? null) as Record<string, unknown> | null;
  const rhMeta = (runtimeHealth?.metadata ?? null) as Record<string, unknown> | null;
  const truthModelStatus = (runtimeHealth?.truthModelStatus ?? null) as Record<string, unknown> | null;

  const scheduled = await prisma.scheduledJobRun.findMany({
    where: { jobName: { in: ["user_sync", "order_reconciliation", "stream_repair"] } },
    orderBy: { startedAt: "desc" },
    take: 15,
  });

  const { credential } = await getStoredCredentials();

  let authPreflight: Record<string, unknown> | null = null;
  let ordersFetch: Record<string, unknown> | null = null;
  if (credential) {
    try {
      const preflight = await validateCredentialsWithClobAuthoritative({
        apiKey: credential.apiKey,
        secret: credential.secret,
        passphrase: credential.passphrase,
        funderAddress: credential.funderAddress,
        polyAddress: credential.polyAddress,
      });
      authPreflight = {
        strongAuthOk: preflight.strongAuthOk,
        apiKeysOk: preflight.apiKeysOk,
        tradesOk: preflight.tradesOk,
        dataOrdersOk: preflight.dataOrdersOk,
        statuses: preflight.diagnostics,
      };
    } catch (e) {
      authPreflight = { error: e instanceof Error ? e.message : String(e) };
    }

    try {
      const raw = await fetchOpenOrdersL2({
        apiKey: credential.apiKey,
        secret: credential.secret,
        passphrase: credential.passphrase,
        funderAddress: credential.funderAddress,
        polyAddress: credential.polyAddress,
      });
      const arr = Array.isArray(raw) ? raw : [];
      ordersFetch = {
        success: true,
        openOrdersCount: arr.length,
        emptyIsValid: arr.length === 0,
        orderIdsSample: arr
          .map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>).id : null))
          .filter((x): x is string => typeof x === "string" && x.length > 0)
          .slice(0, 20),
      };
    } catch (e) {
      ordersFetch = { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const report = {
    generatedAt,
    workerName: WORKER_NAME,
    heartbeatAt: hb?.lastSeenAt?.toISOString() ?? null,
    runtimeSafety: {
      state: typeof runtimeSafety?.state === "string" ? runtimeSafety.state : null,
      blockingReasons: Array.isArray(runtimeSafety?.blockingReasons) ? runtimeSafety.blockingReasons : [],
    },
    runtimeHealthTruth: {
      truthModelStatus,
      exchangeTruthUnavailableFlag: rhMeta?.exchangeTruthUnavailable ?? null,
      exchangeTruthTransientGraceApplied: rhMeta?.exchangeTruthTransientGraceApplied ?? null,
      exchangeTruthTransientGraceReason: rhMeta?.exchangeTruthTransientGraceReason ?? null,
      exchangeTruthTransientGraceMs: EXCHANGE_TRUTH_TRANSIENT_GRACE_MS,
      lastExchangeOrdersSnapshotAt: rhMeta?.lastExchangeOrdersSnapshotAt ?? null,
      lastExchangeFillsSnapshotAt: rhMeta?.lastExchangeFillsSnapshotAt ?? null,
      lastExchangeTruthFailureAt: rhMeta?.lastExchangeTruthFailureAt ?? null,
      lastExchangeTruthFailureError: rhMeta?.lastExchangeTruthFailureError ?? null,
      lastExchangeTruthFailureDiagnostics: rhMeta?.lastExchangeTruthFailureDiagnostics ?? null,
      lastExchangeFillsFetchDiagnostics: rhMeta?.lastExchangeFillsFetchDiagnostics ?? null,
    },
    selectedCredential: credential
      ? {
          credentialId: credential.credentialId,
          funderAddress: credential.funderAddress,
          polyAddress: credential.polyAddress,
          polyAddressSource: credential.polyAddressSource,
        }
      : null,
    authPreflight,
    ordersFetchNow: ordersFetch,
    recentScheduledJobRuns: scheduled.map((r) => ({
      jobName: r.jobName,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      durationMs: r.durationMs ?? null,
      errorMessage: r.errorMessage ?? null,
    })),
    interpretation: {
      exchangeTruthUnavailableMeaning:
        "runtime safety sets exchange_truth_unavailable when RuntimeSafetyInput.exchangeTruthAvailable === false. In StreamRuntime this is driven by exchange truth pull failures (credentials missing or fetch errors) AND absence of recent successful snapshots.",
      emptyOrdersIsValid:
        "If GET /data/orders succeeds and returns [], that is valid truth (zero open orders) and must not be treated as unavailable.",
    },
  };

  const md = [
    "# Exchange truth availability report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Runtime safety blockingReasons",
    "",
    "```json",
    JSON.stringify(report.runtimeSafety, null, 2),
    "```",
    "",
    "## Runtime health truth flags (from worker heartbeat)",
    "",
    "```json",
    JSON.stringify(report.runtimeHealthTruth, null, 2),
    "```",
    "",
    "## Credential + authoritative preflight",
    "",
    "```json",
    JSON.stringify({ selectedCredential: report.selectedCredential, authPreflight: report.authPreflight }, null, 2),
    "```",
    "",
    "## Exchange orders fetch (now)",
    "",
    "```json",
    JSON.stringify(report.ordersFetchNow, null, 2),
    "```",
    "",
    "## Recent scheduled job runs (user_sync / order_reconciliation / stream_repair)",
    "",
    "```json",
    JSON.stringify(report.recentScheduledJobRuns, null, 2),
    "```",
    "",
  ].join("\n");

  await fs.writeFile(
    path.join(DUMP_DIR, "exchange-truth-availability-report.json"),
    JSON.stringify(report, null, 2)
  );
  await fs.writeFile(path.join(DUMP_DIR, "exchange-truth-availability-report.md"), md);
  console.log("Wrote dump/exchange-truth-availability-report.{json,md}");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

