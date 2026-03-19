import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const WORKER_NAME = "polymarket-copilot-worker";

/**
 * GET /api/ops/runtime-safety
 * Returns runtime safety state from worker heartbeat (state, blockingReasons, warnings, evaluatedAt).
 * Used by ops UI. When worker is not running or not reporting safety, returns default.
 */
export async function GET() {
  try {
    const heartbeat = await prisma.workerHeartbeat.findFirst({
      where: { workerName: WORKER_NAME },
      orderBy: { lastSeenAt: "desc" },
    });
    if (!heartbeat?.metadataJson) {
      return NextResponse.json({
        state: "normal",
        blockingReasons: [],
        warnings: [],
        evaluatedAt: new Date().toISOString(),
        message: "Worker not reporting (heartbeat missing); assuming normal.",
      });
    }
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(heartbeat.metadataJson) as Record<string, unknown>;
    } catch {
      return NextResponse.json({
        state: "normal",
        blockingReasons: [],
        warnings: [],
        evaluatedAt: new Date().toISOString(),
        message: "Invalid heartbeat metadata.",
      });
    }
    const runtimeSafety = metadata.runtimeSafety as
      | { state: string; blockingReasons: string[]; warnings: string[]; evaluatedAt: string }
      | null
      | undefined;
    if (runtimeSafety == null) {
      return NextResponse.json({
        state: "normal",
        blockingReasons: [],
        warnings: [],
        evaluatedAt: new Date().toISOString(),
        message: "Worker heartbeat has no runtimeSafety (start worker with USE_STREAM_RUNTIME=true).",
      });
    }
    return NextResponse.json({
      state: runtimeSafety.state ?? "normal",
      blockingReasons: Array.isArray(runtimeSafety.blockingReasons) ? runtimeSafety.blockingReasons : [],
      warnings: Array.isArray(runtimeSafety.warnings) ? runtimeSafety.warnings : [],
      evaluatedAt: typeof runtimeSafety.evaluatedAt === "string" ? runtimeSafety.evaluatedAt : new Date().toISOString(),
    });
  } catch (error) {
    console.error("[GET /api/ops/runtime-safety]", error);
    return NextResponse.json(
      { error: "Failed to fetch runtime safety" },
      { status: 500 }
    );
  }
}
