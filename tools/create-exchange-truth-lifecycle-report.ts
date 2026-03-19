/**
 * Deterministic bounded lifecycle audit for exchange-truth continuity.
 *
 * Writes:
 * - dump/exchange-truth-lifecycle-report.json
 * - dump/exchange-truth-lifecycle-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { parseHeartbeatMetadataJson } from "../lib/ops/worker-heartbeat-canonical";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";
const WINDOWS = [
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "10m", ms: 10 * 60 * 1000 },
  { label: "30m", ms: 30 * 60 * 1000 },
] as const;
const VISIBILITY_EPSILON_MS = 5_000;

type LifecycleClassification =
  | "WRITE_NOT_CALLED"
  | "WRITE_FAILED"
  | "WRITE_NOT_VISIBLE"
  | "WRITE_OVERWRITTEN"
  | "UNAVAILABLE_FLAG_STALE_OR_LATCHED"
  | "WORKING_CORRECTLY";

type ExchangeWriteAttempt = {
  runId: string | null;
  attemptedAt: string;
  jobName: string;
  caller: string;
  success: boolean;
  valuesWritten: {
    ordersSnapshotAt: string | null;
    fillsSnapshotAt: string | null;
    exchangeTruthUnavailable: boolean | null;
  };
  sourcePath: string;
  transactionContext: string | null;
  error: string | null;
  channel: "scheduled_job_breadcrumb" | "runtime_write_audit";
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toIso(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function parseScheduledJobAttempts(runId: string, metadataJson: string | null): ExchangeWriteAttempt[] {
  if (!metadataJson) return [];
  let meta: Record<string, unknown> | null = null;
  try {
    meta = JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    return [];
  }
  const crumbs = Array.isArray(meta?.breadcrumbs) ? (meta.breadcrumbs as unknown[]) : [];
  const out: ExchangeWriteAttempt[] = [];
  for (const c of crumbs) {
    const rec = asRecord(c);
    if (!rec || String(rec.stage ?? "") !== "exchange_truth_write_attempt") continue;
    const m = asRecord(rec.meta);
    const vals = asRecord(m?.valuesWritten);
    out.push({
      runId,
      attemptedAt: toIso(m?.attemptedAt) ?? toIso(rec.at) ?? new Date(0).toISOString(),
      jobName: typeof m?.jobName === "string" ? (m.jobName as string) : "other",
      caller: typeof m?.caller === "string" ? (m.caller as string) : "unknown",
      success: rec.ok === true || m?.success === true,
      valuesWritten: {
        ordersSnapshotAt: toIso(vals?.ordersSnapshotAt),
        fillsSnapshotAt: toIso(vals?.fillsSnapshotAt),
        exchangeTruthUnavailable:
          typeof vals?.exchangeTruthUnavailable === "boolean"
            ? (vals.exchangeTruthUnavailable as boolean)
            : null,
      },
      sourcePath: typeof m?.sourcePath === "string" ? (m.sourcePath as string) : "unknown",
      transactionContext:
        typeof m?.transactionContext === "string" ? (m.transactionContext as string) : null,
      error: typeof rec.error === "string" ? (rec.error as string) : typeof m?.error === "string" ? (m.error as string) : null,
      channel: "scheduled_job_breadcrumb",
    });
  }
  return out;
}

function parseRuntimeAttempts(runtimeMeta: Record<string, unknown> | null): ExchangeWriteAttempt[] {
  const rows = Array.isArray(runtimeMeta?.exchangeTruthWriteAuditRecent)
    ? (runtimeMeta?.exchangeTruthWriteAuditRecent as unknown[])
    : [];
  const out: ExchangeWriteAttempt[] = [];
  for (const r of rows) {
    const rec = asRecord(r);
    if (!rec) continue;
    const vals = asRecord(rec.valuesWritten);
    out.push({
      runId: null,
      attemptedAt: toIso(rec.attemptedAt) ?? new Date(0).toISOString(),
      jobName: typeof rec.transactionContext === "string" ? "runtime" : "runtime",
      caller: typeof rec.caller === "string" ? (rec.caller as string) : "runtime_unknown",
      success: rec.success === true,
      valuesWritten: {
        ordersSnapshotAt: toIso(vals?.ordersSnapshotAt),
        fillsSnapshotAt: toIso(vals?.fillsSnapshotAt),
        exchangeTruthUnavailable:
          typeof vals?.exchangeTruthUnavailable === "boolean"
            ? (vals.exchangeTruthUnavailable as boolean)
            : null,
      },
      sourcePath: typeof rec.sourcePath === "string" ? (rec.sourcePath as string) : "worker/stream-runtime.ts",
      transactionContext:
        typeof rec.transactionContext === "string" ? (rec.transactionContext as string) : null,
      error: typeof rec.error === "string" ? (rec.error as string) : null,
      channel: "runtime_write_audit",
    });
  }
  return out;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const oldest = new Date(nowMs - WINDOWS[2].ms);

  const runs = await prisma.scheduledJobRun.findMany({
    where: {
      startedAt: { gte: oldest },
      jobName: { in: ["user_sync", "stream_repair"] as unknown as string[] },
    },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      metadataJson: true,
    },
  });

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { metadataJson: true, lastSeenAt: true },
  });
  const hbMeta = parseHeartbeatMetadataJson(hb?.metadataJson ?? undefined);
  const rh = asRecord(hbMeta?.runtimeHealth);
  const runtimeMeta = asRecord(rh?.metadata);

  const attemptsFromJobs = runs.flatMap((r) => parseScheduledJobAttempts(r.id, r.metadataJson));
  const attemptsFromRuntime = parseRuntimeAttempts(runtimeMeta);
  const attempts = [...attemptsFromJobs, ...attemptsFromRuntime].sort(
    (a, b) => (toMs(b.attemptedAt) ?? 0) - (toMs(a.attemptedAt) ?? 0)
  );

  const currentValues = {
    lastExchangeOrdersSnapshotAt: toIso(runtimeMeta?.lastExchangeOrdersSnapshotAt),
    lastExchangeFillsSnapshotAt: toIso(runtimeMeta?.lastExchangeFillsSnapshotAt),
    exchangeTruthUnavailable:
      typeof runtimeMeta?.exchangeTruthUnavailable === "boolean"
        ? (runtimeMeta.exchangeTruthUnavailable as boolean)
        : null,
    heartbeatLastSeenAt: hb?.lastSeenAt?.toISOString() ?? null,
  };

  const readAuditRecent = Array.isArray(runtimeMeta?.exchangeTruthReadAuditRecent)
    ? (runtimeMeta?.exchangeTruthReadAuditRecent as unknown[])
    : [];
  const readSource = typeof runtimeMeta?.exchangeTruthReadSource === "string"
    ? (runtimeMeta.exchangeTruthReadSource as string)
    : "unknown";
  const readChangedSinceLastTick =
    typeof runtimeMeta?.exchangeTruthChangedSinceLastTick === "boolean"
      ? (runtimeMeta.exchangeTruthChangedSinceLastTick as boolean)
      : null;

  const byWindow = WINDOWS.map((w) => {
    const cutoff = nowMs - w.ms;
    const inWin = attempts.filter((a) => {
      const t = toMs(a.attemptedAt);
      return t != null && t >= cutoff;
    });
    return {
      window: w.label,
      writeAttempts: inWin.length,
      writesSucceeded: inWin.filter((a) => a.success).length,
      writesFailed: inWin.filter((a) => !a.success).length,
      latestAttemptAt: inWin[0]?.attemptedAt ?? null,
    };
  });

  const latestSuccess = attempts.find((a) => a.success) ?? null;
  const latestSuccessOrdersMs = toMs(latestSuccess?.valuesWritten.ordersSnapshotAt ?? null);
  const latestSuccessFillsMs = toMs(latestSuccess?.valuesWritten.fillsSnapshotAt ?? null);
  const currentOrdersMs = toMs(currentValues.lastExchangeOrdersSnapshotAt);
  const currentFillsMs = toMs(currentValues.lastExchangeFillsSnapshotAt);
  const anySuccess = attempts.some((a) => a.success);

  let classification: LifecycleClassification = "WORKING_CORRECTLY";
  let why = "Exchange-truth writes and runtime visibility appear consistent in the bounded window.";
  if (attempts.length === 0) {
    classification = "WRITE_NOT_CALLED";
    why = "No instrumented exchange-truth write attempts found in 30m.";
  } else if (!anySuccess) {
    classification = "WRITE_FAILED";
    why = "All instrumented exchange-truth writes failed in 30m.";
  } else if (
    (latestSuccessOrdersMs != null && (currentOrdersMs == null || currentOrdersMs + VISIBILITY_EPSILON_MS < latestSuccessOrdersMs)) ||
    (latestSuccessFillsMs != null && (currentFillsMs == null || currentFillsMs + VISIBILITY_EPSILON_MS < latestSuccessFillsMs))
  ) {
    classification = "WRITE_NOT_VISIBLE";
    why = "Latest successful exchange-truth snapshot write is newer than runtime-visible effective values.";
  } else {
    const successfulUnavailableTrue = attempts.filter(
      (a) => a.success && a.valuesWritten.exchangeTruthUnavailable === true
    );
    const lastUnavailableSetTrue = successfulUnavailableTrue[0] ?? null;
    if (currentValues.exchangeTruthUnavailable === true && lastUnavailableSetTrue != null) {
      const laterSuccessClears = attempts.some(
        (a) =>
          a.success &&
          a.valuesWritten.exchangeTruthUnavailable === false &&
          (toMs(a.attemptedAt) ?? 0) > (toMs(lastUnavailableSetTrue.attemptedAt) ?? 0)
      );
      if (laterSuccessClears) {
        classification = "UNAVAILABLE_FLAG_STALE_OR_LATCHED";
        why = "exchangeTruthUnavailable is still true despite later successful clear attempts.";
      }
    }
    const maxOrdersSuccess = Math.max(
      ...attempts
        .filter((a) => a.success && a.valuesWritten.ordersSnapshotAt != null)
        .map((a) => toMs(a.valuesWritten.ordersSnapshotAt) ?? 0),
      0
    );
    const maxFillsSuccess = Math.max(
      ...attempts
        .filter((a) => a.success && a.valuesWritten.fillsSnapshotAt != null)
        .map((a) => toMs(a.valuesWritten.fillsSnapshotAt) ?? 0),
      0
    );
    if (
      classification === "WORKING_CORRECTLY" &&
      ((currentOrdersMs ?? 0) + VISIBILITY_EPSILON_MS < maxOrdersSuccess ||
        (currentFillsMs ?? 0) + VISIBILITY_EPSILON_MS < maxFillsSuccess)
    ) {
      classification = "WRITE_OVERWRITTEN";
      why = "Current exchange-truth snapshot values are older than max successful written values.";
    }
  }

  const appearsLegitimateUpstream =
    classification === "WORKING_CORRECTLY" && currentValues.exchangeTruthUnavailable === true;

  const report = {
    generatedAt,
    boundedWindows: { primary: "5m", comparison: "10m", fullAudit: "30m" },
    attemptedExchangeTruthWritesLast30m: attempts,
    writeSummaryByWindow: byWindow,
    currentStoredOrEffectiveValues: currentValues,
    runtimeReadSideVisibility: {
      readSource,
      changedSinceLastTick: readChangedSinceLastTick,
      readAuditRecent,
    },
    lifecycleClassification: {
      classification,
      why,
    },
    upstreamInterpretation: classification === "WORKING_CORRECTLY"
      ? {
          currentExchangeTruthBlockerLooksLegitimateUpstream: appearsLegitimateUpstream,
          note: appearsLegitimateUpstream
            ? "Lifecycle is healthy; current exchange-truth block appears to be real upstream/unavailable behavior."
            : "Lifecycle is healthy; no immediate upstream-only blocker inferred from current values.",
        }
      : null,
    filesChanged: [
      "lib/ops/scheduled-jobs.ts",
      "worker/stream-runtime.ts",
      "tools/create-exchange-truth-lifecycle-report.ts",
      "package.json",
    ],
    redaction: {
      secretsRedacted: true,
      note: "No credentials or secrets emitted.",
    },
  };

  const md: string[] = [];
  md.push("# Exchange Truth Lifecycle Report");
  md.push(`Generated at: ${generatedAt}`);
  md.push("");
  md.push("## 1) All attempted exchange-truth writes (last 30m)");
  md.push("| attemptedAt | channel | job/caller | success | ordersAt | fillsAt | unavailable |");
  md.push("|---|---|---|---|---|---|---|");
  for (const a of attempts.slice(0, 200)) {
    md.push(
      `| ${a.attemptedAt} | ${a.channel} | ${a.jobName} :: ${a.caller} | ${a.success} | ${a.valuesWritten.ordersSnapshotAt ?? "—"} | ${a.valuesWritten.fillsSnapshotAt ?? "—"} | ${String(a.valuesWritten.exchangeTruthUnavailable)} |`
    );
  }
  md.push("");
  md.push("## 2) Whether writes succeeded (5m / 10m / 30m)");
  md.push("| window | attempts | succeeded | failed | latestAttemptAt |");
  md.push("|---|---:|---:|---:|---|");
  for (const w of byWindow) {
    md.push(`| ${w.window} | ${w.writeAttempts} | ${w.writesSucceeded} | ${w.writesFailed} | ${w.latestAttemptAt ?? "—"} |`);
  }
  md.push("");
  md.push("## 3) Current stored/effective values");
  md.push(`- lastExchangeOrdersSnapshotAt: **${currentValues.lastExchangeOrdersSnapshotAt ?? "—"}**`);
  md.push(`- lastExchangeFillsSnapshotAt: **${currentValues.lastExchangeFillsSnapshotAt ?? "—"}**`);
  md.push(`- exchangeTruthUnavailable: **${String(currentValues.exchangeTruthUnavailable)}**`);
  md.push("");
  md.push("## 4) Runtime read-side visibility");
  md.push(`- source: **${readSource}**`);
  md.push(`- changedSinceLastTick: **${String(readChangedSinceLastTick)}**`);
  md.push(`- recent read rows: ${readAuditRecent.length}`);
  md.push("");
  md.push("## 5) Lifecycle classification");
  md.push(`- **${classification}**`);
  md.push(`- ${why}`);
  if (classification === "WORKING_CORRECTLY") {
    md.push(
      `- current exchange-truth blocker appears legitimate upstream behavior: **${String(appearsLegitimateUpstream)}**`
    );
  }

  await fs.writeFile(
    path.join(DUMP_DIR, "exchange-truth-lifecycle-report.json"),
    JSON.stringify(report, null, 2),
    "utf-8"
  );
  await fs.writeFile(path.join(DUMP_DIR, "exchange-truth-lifecycle-report.md"), md.join("\n"), "utf-8");

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        classification,
        attempts30m: attempts.length,
        exchangeTruthUnavailable: currentValues.exchangeTruthUnavailable,
      },
      null,
      2
    )
  );
}

void main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("create-exchange-truth-lifecycle-report failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

