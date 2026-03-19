import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const WORKER_NAME = "polymarket-copilot-worker";

/**
 * GET /api/ops/runtime/health
 * Returns stream runtime health when the worker runs with USE_STREAM_RUNTIME and reports it in heartbeat metadata.
 */
export async function GET() {
  try {
    const heartbeat = await prisma.workerHeartbeat.findFirst({
      where: { workerName: WORKER_NAME },
      orderBy: { lastSeenAt: "desc" },
    });
    if (!heartbeat?.metadataJson) {
      return NextResponse.json({
        status: "no_runtime",
        message: "Stream runtime health not reported (worker may not be running with USE_STREAM_RUNTIME)",
      });
    }
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(heartbeat.metadataJson) as Record<string, unknown>;
    } catch {
      return NextResponse.json({
        status: "no_runtime",
        message: "Invalid heartbeat metadata",
      });
    }
    const runtimeHealth = metadata.runtimeHealth;
    if (runtimeHealth == null) {
      return NextResponse.json({
        status: "no_runtime",
        message: "Worker heartbeat has no runtimeHealth (start worker with USE_STREAM_RUNTIME=true)",
      });
    }
    const health = runtimeHealth as Record<string, unknown>;
    return NextResponse.json({
      status: "ok",
      runtimeHealth,
      /** Operator-facing: connection, heartbeat, dataFreshness, reconciliation, readiness, killSwitch, truthModel, executionContainment. */
      operatorHealth: health?.operatorHealth ?? null,
      /** Exchange-truth authority: freshness, timestamps, truthSourceBySubsystem. */
      truthModelStatus: health?.truthModelStatus ?? null,
      /** Execution failure containment: frozen assets, ambiguity counts, shouldDegradeRuntime, shouldForceCancelOnlyOrFrozen. */
      executionContainment: (health?.operatorHealth as Record<string, unknown> | null)?.executionContainment ?? null,
      /** Latency and data-integrity: stream/processing latencies, integrity counters. */
      latencyAndIntegrity: health?.latencyAndIntegrity ?? null,
      /** Market WS subscription coverage: desired vs subscribed, pending, churn. */
      marketSubscriptionCoverage: health?.marketSubscriptionCoverage ?? null,
      /** Effective operational mode and source (config, phase, guardrail). */
      operatingMode: health?.operatingMode ?? null,
      operatingModeSource: health?.operatingModeSource ?? null,
      lastSeenAt: heartbeat.lastSeenAt.toISOString(),
    });
  } catch (error) {
    console.error("[GET /api/ops/runtime/health]", error);
    return NextResponse.json(
      { error: "Failed to fetch runtime health" },
      { status: 500 }
    );
  }
}
