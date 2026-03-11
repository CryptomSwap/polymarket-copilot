import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { JOB_NAMES } from "@/lib/ops/scheduled-jobs";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/job-runs
 * Recent scheduled job runs. Query: limit (default 50), jobName (filter), status (filter).
 * Also returns last success and last failure per job name.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);
    const jobName = searchParams.get("jobName") || undefined;
    const status = searchParams.get("status") || undefined;

    const where: { jobName?: string; status?: string } = {};
    if (jobName) where.jobName = jobName;
    if (status) where.status = status;

    const [runs, successRows, failureRows] = await Promise.all([
      prisma.scheduledJobRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: limit,
      }),
      Promise.all(
        JOB_NAMES.map(async (name) => {
          const last = await prisma.scheduledJobRun.findFirst({
            where: { jobName: name, status: "success" },
            orderBy: { finishedAt: "desc" },
          });
          return { jobName: name, last };
        })
      ),
      Promise.all(
        JOB_NAMES.map(async (name) => {
          const last = await prisma.scheduledJobRun.findFirst({
            where: { jobName: name, status: "failure" },
            orderBy: { finishedAt: "desc" },
          });
          return { jobName: name, last };
        })
      ),
    ]);

    const lastSuccessByJob: Record<string, { finishedAt: string | null; durationMs: number | null } | null> = {};
    for (const { jobName: name, last } of successRows) {
      lastSuccessByJob[name] = last ? { finishedAt: last.finishedAt?.toISOString() ?? null, durationMs: last.durationMs } : null;
    }
    const lastFailureByJob: Record<string, { finishedAt: string | null; errorMessage: string | null } | null> = {};
    for (const { jobName: name, last } of failureRows) {
      lastFailureByJob[name] = last ? { finishedAt: last.finishedAt?.toISOString() ?? null, errorMessage: last.errorMessage } : null;
    }

    return NextResponse.json({
      runs: runs.map((r) => ({
        id: r.id,
        jobName: r.jobName,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        durationMs: r.durationMs,
        errorMessage: r.errorMessage,
        metadataJson: r.metadataJson,
        createdAt: r.createdAt.toISOString(),
      })),
      lastSuccessByJob: lastSuccessByJob,
      lastFailureByJob: lastFailureByJob,
    });
  } catch (error) {
    console.error("[GET /api/ops/job-runs]", error);
    return NextResponse.json(
      { error: "Failed to fetch job runs" },
      { status: 500 }
    );
  }
}
