import { NextRequest, NextResponse } from "next/server";
import { runScheduledJob, isJobName } from "@/lib/ops/scheduled-jobs";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ jobName: z.string().min(1) });

/**
 * POST /api/ops/run-job
 * Manually trigger a scheduled job by name. No autonomous trading; same jobs as the worker.
 */
export async function POST(request: NextRequest) {
  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const { jobName } = parsed.data;
    if (!isJobName(jobName)) {
      return NextResponse.json(
        { error: "Unknown job name", jobName },
        { status: 400 }
      );
    }
    const result = await runScheduledJob(jobName);
    return NextResponse.json({
      success: result.status === "success",
      runId: result.runId,
      status: result.status,
      durationMs: result.durationMs,
      error: result.error,
    });
  } catch (error) {
    console.error("[POST /api/ops/run-job]", error);
    return NextResponse.json(
      { error: "Failed to run job" },
      { status: 500 }
    );
  }
}
