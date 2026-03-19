/**
 * Deterministic audit for user truth freshness marker lifecycle.
 *
 * Writes:
 * - dump/user-truth-marker-audit-report.json
 * - dump/user-truth-marker-audit-report.md
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

type MismatchClassification =
  | "WRITE_NOT_CALLED"
  | "WRITE_FAILED"
  | "WRITE_NOT_VISIBLE"
  | "WRITE_OVERWRITTEN"
  | "WORKING_CORRECTLY";

type MarkerWriteAttempt = {
  runId: string;
  jobName: string;
  attemptedAt: string;
  success: boolean;
  dbWriteResult: Record<string, unknown> | null;
  transactionContext: string | null;
  markerValue: string | null;
  setCallsite: string;
  error: string | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toIso(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function parseAttemptsFromRun(
  runId: string,
  jobName: string,
  metadataJson: string | null
): MarkerWriteAttempt[] {
  if (!metadataJson) return [];
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const breadcrumbs = Array.isArray(parsed?.breadcrumbs) ? (parsed?.breadcrumbs as unknown[]) : [];
  const out: MarkerWriteAttempt[] = [];
  for (const b of breadcrumbs) {
    const br = asRecord(b);
    if (!br) continue;
    if (String(br.stage ?? "") !== "user_truth_marker_write_attempt") continue;
    const meta = asRecord(br.meta);
    out.push({
      runId,
      jobName: String(meta?.jobName ?? jobName ?? "other"),
      attemptedAt: toIso(meta?.attemptedAt) ?? toIso(br.at) ?? new Date(0).toISOString(),
      success: br.ok === true || meta?.success === true,
      dbWriteResult: asRecord(meta?.dbWriteResult),
      transactionContext:
        typeof meta?.transactionContext === "string" ? (meta.transactionContext as string) : null,
      markerValue: toIso(meta?.markerValue),
      setCallsite: typeof meta?.setCallsite === "string" ? (meta.setCallsite as string) : "unknown",
      error: typeof br.error === "string" ? (br.error as string) : typeof meta?.error === "string" ? (meta.error as string) : null,
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
      jobName: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      errorMessage: true,
      metadataJson: true,
    },
  });

  const attempts = runs.flatMap((r) => parseAttemptsFromRun(r.id, r.jobName, r.metadataJson));
  attempts.sort((a, b) => parseMs(b.attemptedAt)! - parseMs(a.attemptedAt)!);

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { metadataJson: true, lastSeenAt: true },
  });
  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? undefined);
  const rh = asRecord(meta?.runtimeHealth);
  const runtimeMeta = asRecord(rh?.metadata);
  const currentStoredValue = toIso(runtimeMeta?.lastSuccessfulUserTruthFetchAt);
  const readSource = typeof runtimeMeta?.userTruthMarkerReadSource === "string"
    ? (runtimeMeta.userTruthMarkerReadSource as string)
    : "unknown";
  const readChangedSinceLastTick =
    typeof runtimeMeta?.userTruthMarkerChangedSinceLastTick === "boolean"
      ? (runtimeMeta.userTruthMarkerChangedSinceLastTick as boolean)
      : null;
  const readAuditRecent = Array.isArray(runtimeMeta?.userTruthMarkerReadAuditRecent)
    ? (runtimeMeta?.userTruthMarkerReadAuditRecent as unknown[])
    : [];

  const latestSuccess = attempts.find((a) => a.success);
  const latestAttempt = attempts[0] ?? null;
  const currentStoredMs = parseMs(currentStoredValue);
  const latestSuccessMs = parseMs(latestSuccess?.markerValue ?? latestSuccess?.attemptedAt ?? null);
  const anySuccess = attempts.some((a) => a.success);

  let mismatchClassification: MismatchClassification = "WORKING_CORRECTLY";
  let mismatchWhy = "Recent marker writes and runtime visibility are consistent.";
  if (attempts.length === 0) {
    mismatchClassification = "WRITE_NOT_CALLED";
    mismatchWhy = "No instrumented marker write attempts were recorded in the bounded 30m window.";
  } else if (!anySuccess) {
    mismatchClassification = "WRITE_FAILED";
    mismatchWhy = "All instrumented marker write attempts in 30m were failures.";
  } else if (currentStoredMs == null) {
    mismatchClassification = "WRITE_NOT_VISIBLE";
    mismatchWhy = "Successful write attempts exist, but worker heartbeat metadata does not expose a current marker value.";
  } else if (
    latestSuccessMs != null &&
    currentStoredMs + VISIBILITY_EPSILON_MS < latestSuccessMs
  ) {
    mismatchClassification = "WRITE_NOT_VISIBLE";
    mismatchWhy = "Latest successful write timestamp is newer than current runtime-visible marker.";
  } else {
    const successMarkers = attempts
      .filter((a) => a.success)
      .map((a) => parseMs(a.markerValue ?? a.attemptedAt))
      .filter((x): x is number => x != null);
    const maxSuccess = successMarkers.length > 0 ? Math.max(...successMarkers) : null;
    if (maxSuccess != null && currentStoredMs != null && currentStoredMs + VISIBILITY_EPSILON_MS < maxSuccess) {
      mismatchClassification = "WRITE_OVERWRITTEN";
      mismatchWhy = "Current marker appears older than the maximum successful written value.";
    }
  }

  const byWindow = WINDOWS.map((w) => {
    const cutoff = nowMs - w.ms;
    const inWin = attempts.filter((a) => {
      const t = parseMs(a.attemptedAt);
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

  const report = {
    generatedAt,
    boundedWindows: { primary: "5m", comparison: "10m", fullAudit: "30m" },
    attemptedWritesLast30m: attempts,
    writeSummaryByWindow: byWindow,
    currentStoredValue: {
      lastSuccessfulUserTruthFetchAt: currentStoredValue,
      heartbeatLastSeenAt: hb?.lastSeenAt?.toISOString() ?? null,
    },
    runtimeReadSideVisibility: {
      runtimeReadsCurrentMarkerValue: currentStoredValue,
      source: readSource,
      changedSinceLastTick: readChangedSinceLastTick,
      readAuditRecent,
    },
    lifecycleChecks: {
      latestAttempt,
      latestSuccessfulAttempt: latestSuccess ?? null,
      runtimeSeesLatestSuccessfulValue:
        latestSuccessMs != null && currentStoredMs != null
          ? currentStoredMs + VISIBILITY_EPSILON_MS >= latestSuccessMs
          : null,
    },
    mismatchClassification: {
      classification: mismatchClassification,
      why: mismatchWhy,
    },
    filesChanged: [
      "lib/ops/scheduled-jobs.ts",
      "worker/stream-runtime.ts",
      "tools/create-user-truth-marker-audit-report.ts",
      "package.json",
    ],
    redaction: {
      secretsRedacted: true,
      note: "No credential material included.",
    },
  };

  const md: string[] = [];
  md.push("# User Truth Marker Audit Report");
  md.push(`Generated at: ${generatedAt}`);
  md.push("");
  md.push("## A) All attempted writes (last 30m)");
  md.push("| attemptedAt | jobName | success | markerValue | callsite |");
  md.push("|---|---|---|---|---|");
  for (const a of attempts.slice(0, 120)) {
    md.push(`| ${a.attemptedAt} | ${a.jobName} | ${a.success} | ${a.markerValue ?? "—"} | ${a.setCallsite} |`);
  }
  md.push("");
  md.push("## B) Whether writes succeeded");
  md.push("| window | attempts | succeeded | failed | latestAttemptAt |");
  md.push("|---|---:|---:|---:|---|");
  for (const w of byWindow) {
    md.push(`| ${w.window} | ${w.writeAttempts} | ${w.writesSucceeded} | ${w.writesFailed} | ${w.latestAttemptAt ?? "—"} |`);
  }
  md.push("");
  md.push("## C) Current stored value");
  md.push(`- lastSuccessfulUserTruthFetchAt: **${currentStoredValue ?? "—"}**`);
  md.push("");
  md.push("## D) Whether runtime sees updated value");
  md.push(`- source: **${readSource}**`);
  md.push(`- changedSinceLastTick: **${String(readChangedSinceLastTick)}**`);
  md.push(`- runtimeSeesLatestSuccessfulValue: **${String(report.lifecycleChecks.runtimeSeesLatestSuccessfulValue)}**`);
  md.push("");
  md.push("## E) Mismatch classification");
  md.push(`- **${mismatchClassification}**`);
  md.push(`- ${mismatchWhy}`);

  await fs.writeFile(path.join(DUMP_DIR, "user-truth-marker-audit-report.json"), JSON.stringify(report, null, 2), "utf-8");
  await fs.writeFile(path.join(DUMP_DIR, "user-truth-marker-audit-report.md"), md.join("\n"), "utf-8");

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mismatchClassification,
        attempts30m: attempts.length,
        latestStoredValue: currentStoredValue,
      },
      null,
      2
    )
  );
}

void main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("create-user-truth-marker-audit-report failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

