/**
 * Truth job failure report: user_sync / order_reconciliation / stream_repair.
 *
 * Writes:
 * - dump/truth-job-failure-report.json
 * - dump/truth-job-failure-report.md
 *
 * npm run dump:truth-job-failure-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JOBS = ["user_sync", "order_reconciliation", "stream_repair"] as const;

type JobName = (typeof JOBS)[number];

type Breadcrumb = {
  stage?: string;
  at?: string;
  durationMs?: number;
  ok?: boolean;
  error?: string;
  meta?: Record<string, unknown>;
};

function safeJsonParse(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function median(nums: number[]): number | null {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 === 1 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function p95(nums: number[]): number | null {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const idx = Math.min(a.length - 1, Math.max(0, Math.floor(a.length * 0.95) - 1));
  return a[idx];
}

function classifyFailure(run: { errorMessage: string | null; metadataJson: string | null }): {
  bucket:
    | "fetch"
    | "db_write"
    | "lock_wait"
    | "auth"
    | "downstream_processing"
    | "timeout"
    | "aborted"
    | "stale_run_recovered"
    | "unknown";
  hint: string | null;
  stage: string | null;
} {
  const msg = run.errorMessage ?? "";
  const meta = safeJsonParse(run.metadataJson ?? null) ?? {};
  const lastStage = typeof meta.lastStage === "string" ? (meta.lastStage as string) : null;
  const breadcrumbs = Array.isArray(meta.breadcrumbs) ? (meta.breadcrumbs as Breadcrumb[]) : [];
  const lastCrumb = breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1] : null;
  const crumbStage = lastCrumb && typeof lastCrumb.stage === "string" ? lastCrumb.stage : null;

  const stage = lastStage ?? crumbStage;

  if (/abandoned_stale_run:/i.test(msg)) {
    return { bucket: "stale_run_recovered", hint: "prior run exceeded maxDuration; recovered on next attempt", stage };
  }
  if (typeof meta.timeout === "object" && meta.timeout != null) {
    return { bucket: "timeout", hint: "job_timeout (scheduler maxDurationMs)", stage };
  }
  if (/aborted:/i.test(msg)) {
    return { bucket: "aborted", hint: "aborted by cancellation/deadline", stage };
  }
  if (/job_timeout:/i.test(msg) || /timeout:/i.test(msg) || /ETIMEDOUT|timeout/i.test(msg)) {
    return { bucket: "timeout", hint: "timeout (job or request)", stage };
  }
  if (/401|403|Unauthorized|Invalid api key/i.test(msg)) {
    return { bucket: "auth", hint: "CLOB auth rejected", stage };
  }
  if (/deadlock|lock wait|timeout:.*lock/i.test(msg)) {
    return { bucket: "lock_wait", hint: "DB lock wait/deadlock", stage };
  }
  if (/prisma|constraint|Unique constraint|foreign key|P20\d\d/i.test(msg)) {
    return { bucket: "db_write", hint: "Prisma/DB write error", stage };
  }
  if (/CLOB|GET \/data|fetch/i.test(msg) || (stage != null && stage.startsWith("fetch_"))) {
    return { bucket: "fetch", hint: "exchange fetch error", stage };
  }
  if (stage != null && (stage.startsWith("reconciliation_") || stage.startsWith("repair_"))) {
    return { bucket: "downstream_processing", hint: "reconciliation/repair failure", stage };
  }
  return { bucket: "unknown", hint: null, stage };
}

function inferMostLikelyStall(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const lastStage = typeof meta.lastStage === "string" ? meta.lastStage : null;
  const timeout = meta.timeout as Record<string, unknown> | null | undefined;
  if (timeout && typeof timeout.at === "string") {
    return lastStage ? `timed out after lastStage=${lastStage}` : "timed out with no lastStage";
  }
  if (lastStage) return `lastStage=${lastStage}`;
  const breadcrumbs = Array.isArray(meta.breadcrumbs) ? (meta.breadcrumbs as Breadcrumb[]) : [];
  if (breadcrumbs.length > 0) {
    const b = breadcrumbs[breadcrumbs.length - 1];
    if (b?.stage) return `lastBreadcrumb=${b.stage}`;
  }
  return null;
}

function summarizeStages(meta: Record<string, unknown> | null): {
  lastStage: string | null;
  longestStages: Array<{ stage: string; durationMs: number }>;
  timeout: Record<string, unknown> | null;
} {
  if (!meta) return { lastStage: null, longestStages: [], timeout: null };
  const lastStage = typeof meta.lastStage === "string" ? meta.lastStage : null;
  const timeout = (meta.timeout as Record<string, unknown> | null | undefined) ?? null;
  const breadcrumbs = Array.isArray(meta.breadcrumbs) ? (meta.breadcrumbs as Breadcrumb[]) : [];
  const durations: Array<{ stage: string; durationMs: number }> = [];
  for (const b of breadcrumbs) {
    if (!b || typeof b.stage !== "string") continue;
    const d = typeof b.durationMs === "number" && Number.isFinite(b.durationMs) ? b.durationMs : null;
    if (d != null && d >= 0) durations.push({ stage: b.stage, durationMs: d });
  }
  durations.sort((a, b) => b.durationMs - a.durationMs);
  return { lastStage, longestStages: durations.slice(0, 5), timeout };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const runs = await prisma.scheduledJobRun.findMany({
    where: { jobName: { in: JOBS as unknown as string[] } },
    orderBy: { startedAt: "desc" },
    take: 600,
    select: {
      id: true,
      jobName: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      errorMessage: true,
      metadataJson: true,
    },
  });

  const byJob: Record<JobName, unknown> = {
    user_sync: null,
    order_reconciliation: null,
    stream_repair: null,
  };

  for (const job of JOBS) {
    const r = runs.filter((x) => x.jobName === job);
    const lastFailure = r.find((x) => x.status === "failure") ?? null;
    const lastSuccess = r.find((x) => x.status === "success") ?? null;

    const durationsAll = r.map((x) => x.durationMs ?? 0).filter((n) => n > 0);
    const durationsSuccess = r.filter((x) => x.status === "success").map((x) => x.durationMs ?? 0).filter((n) => n > 0);

    const counts = {
      total: r.length,
      success: r.filter((x) => x.status === "success").length,
      failure: r.filter((x) => x.status === "failure").length,
      running: r.filter((x) => x.status === "running").length,
      timeout: r.filter((x) => {
        const meta = safeJsonParse(x.metadataJson ?? null);
        return (meta?.timeout ?? null) != null || (x.errorMessage ?? "").startsWith("job_timeout:");
      }).length,
    };

    const failures = r
      .filter((x) => x.status === "failure")
      .slice(0, 80)
      .map((x) => {
        const meta = safeJsonParse(x.metadataJson ?? null);
        const c = classifyFailure({ errorMessage: x.errorMessage, metadataJson: x.metadataJson });
        const stages = summarizeStages(meta);
        return {
          id: x.id,
          startedAt: x.startedAt.toISOString(),
          durationMs: x.durationMs ?? null,
          errorMessage: x.errorMessage ?? null,
          bucket: c.bucket,
          stage: c.stage,
          stallHint: inferMostLikelyStall(meta),
          lastStage: stages.lastStage,
          longestStages: stages.longestStages,
          timeout: stages.timeout,
        };
      });

    const bucketCounts: Record<string, number> = {};
    for (const f of failures) bucketCounts[f.bucket] = (bucketCounts[f.bucket] ?? 0) + 1;

    byJob[job] = {
      counts,
      durationsMs: {
        medianAll: median(durationsAll),
        p95All: p95(durationsAll),
        medianSuccess: median(durationsSuccess),
        p95Success: p95(durationsSuccess),
        slowestRunMs: durationsAll.length > 0 ? Math.max(...durationsAll) : null,
      },
      lastSuccess: lastSuccess
        ? {
            id: lastSuccess.id,
            startedAt: lastSuccess.startedAt.toISOString(),
            durationMs: lastSuccess.durationMs ?? null,
          }
        : null,
      lastFailure: lastFailure
        ? {
            id: lastFailure.id,
            startedAt: lastFailure.startedAt.toISOString(),
            durationMs: lastFailure.durationMs ?? null,
            errorMessage: lastFailure.errorMessage ?? null,
            stallHint: inferMostLikelyStall(safeJsonParse(lastFailure.metadataJson ?? null)),
            stageSummary: summarizeStages(safeJsonParse(lastFailure.metadataJson ?? null)),
          }
        : null,
      failureBuckets: bucketCounts,
      recentFailures: failures.slice(0, 25),
      longestStagesAcrossFailures: failures
        .flatMap((f) => (Array.isArray(f.longestStages) ? f.longestStages.map((s) => ({ ...s, runId: f.id })) : []))
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 10),
      likelyFailureOrStallAreas: Object.entries(bucketCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([bucket, count]) => ({ bucket, count })),
    };
  }

  const report = {
    generatedAt,
    jobs: JOBS,
    byJob,
    notes: [
      "This report infers failure cluster (fetch/db/timeout/etc) from errorMessage and ScheduledJobRun.metadataJson breadcrumbs.",
      "If breadcrumbs are missing, upgrade worker to include new job-run instrumentation (run a few cycles) then rerun.",
    ],
  };

  const md = [
    "# Truth job failure report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Per-job summary",
    "",
    "```json",
    JSON.stringify(report.byJob, null, 2),
    "```",
    "",
  ].join("\n");

  await fs.writeFile(path.join(DUMP_DIR, "truth-job-failure-report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(DUMP_DIR, "truth-job-failure-report.md"), md);
  console.log("Wrote dump/truth-job-failure-report.{json,md}");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

