import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  evaluateLiveReadiness,
  buildLiveReadinessInputFromRuntime,
  getLiveReadinessState,
} from "@/lib/live-readiness";

export const dynamic = "force-dynamic";

const WORKER_NAME = "polymarket-copilot-worker";

/**
 * GET /api/ops/live-readiness
 *
 * Returns the current live-readiness evaluation: overallState, allowLiveTrading (always false),
 * blockingReasons, warnings, passedChecks, failedChecks, evaluatedAt.
 * If the worker has reported readiness in heartbeat metadata, that is used; otherwise
 * evaluates from the latest heartbeat (runtime safety, health) and defaults.
 */
export async function GET() {
  try {
    const heartbeat = await prisma.workerHeartbeat.findFirst({
      where: { workerName: WORKER_NAME },
      orderBy: { lastSeenAt: "desc" },
    });

    let payload: {
      overallState: string;
      allowLiveTrading: boolean;
      blockingReasons: string[];
      warnings: string[];
      passedChecks: string[];
      failedChecks: string[];
      evaluatedAt: string;
      checklist?: { passed: string[]; failed: string[] };
      source?: "heartbeat" | "evaluated";
    };

    let metadata: Record<string, unknown> = {};
    if (heartbeat?.metadataJson) {
      try {
        metadata = JSON.parse(heartbeat.metadataJson) as Record<string, unknown>;
      } catch {
        // ignore
      }
    }

    const liveReadinessFromHeartbeat = metadata.liveReadiness as
      | {
          overallState?: string;
          allowLiveTrading?: boolean;
          blockingReasons?: string[];
          warnings?: string[];
          passedChecks?: string[];
          failedChecks?: string[];
          evaluatedAt?: string;
        }
      | undefined;

    if (
      liveReadinessFromHeartbeat &&
      typeof liveReadinessFromHeartbeat.overallState === "string" &&
      typeof liveReadinessFromHeartbeat.evaluatedAt === "string"
    ) {
      payload = {
        overallState: liveReadinessFromHeartbeat.overallState,
        allowLiveTrading: liveReadinessFromHeartbeat.allowLiveTrading === true ? true : false,
        blockingReasons: Array.isArray(liveReadinessFromHeartbeat.blockingReasons)
          ? liveReadinessFromHeartbeat.blockingReasons
          : [],
        warnings: Array.isArray(liveReadinessFromHeartbeat.warnings) ? liveReadinessFromHeartbeat.warnings : [],
        passedChecks: Array.isArray(liveReadinessFromHeartbeat.passedChecks) ? liveReadinessFromHeartbeat.passedChecks : [],
        failedChecks: Array.isArray(liveReadinessFromHeartbeat.failedChecks) ? liveReadinessFromHeartbeat.failedChecks : [],
        evaluatedAt: liveReadinessFromHeartbeat.evaluatedAt,
        checklist: {
          passed: Array.isArray(liveReadinessFromHeartbeat.passedChecks) ? liveReadinessFromHeartbeat.passedChecks : [],
          failed: Array.isArray(liveReadinessFromHeartbeat.failedChecks) ? liveReadinessFromHeartbeat.failedChecks : [],
        },
        source: "heartbeat",
      };
    } else {
      const runtimeSafety = metadata.runtimeSafety as { state?: string } | undefined;
      const runtimeHealth = metadata.runtimeHealth as {
        streams?: { heartbeatHealthy?: boolean };
        reconciliation?: { status?: string; lastAt?: string };
      } | undefined;
      const runtimeSafetyState = runtimeSafety?.state ?? "normal";
      const exchangeTruthHealthy = runtimeHealth?.streams?.heartbeatHealthy ?? false;
      const reconciliationOk =
        runtimeHealth?.reconciliation?.status === "ok" && runtimeHealth?.reconciliation?.lastAt != null;

      const input = buildLiveReadinessInputFromRuntime({
        runtimeSafetyState: runtimeSafetyState as "normal" | "degraded" | "blocked" | "kill_switch",
        exchangeTruthHealthy,
        reconciliationOk,
        operatorMode: "paper_only",
        manualLiveEnableRequested: false,
      });

      const result = evaluateLiveReadiness(input);
      payload = {
        overallState: result.overallState,
        allowLiveTrading: result.allowLiveTrading,
        blockingReasons: result.blockingReasons,
        warnings: result.warnings,
        passedChecks: result.passedChecks,
        failedChecks: result.failedChecks,
        evaluatedAt: result.evaluatedAt,
        checklist: { passed: result.passedChecks, failed: result.failedChecks },
        source: "evaluated",
      };
    }

    return NextResponse.json(payload);
  } catch (error) {
    console.error("[GET /api/ops/live-readiness]", error);
    const fallback = getLiveReadinessState();
    return NextResponse.json(
      {
        overallState: fallback.overallState,
        allowLiveTrading: fallback.allowLiveTrading,
        blockingReasons: fallback.blockingReasons,
        warnings: fallback.warnings,
        passedChecks: fallback.passedChecks,
        failedChecks: fallback.failedChecks,
        evaluatedAt: fallback.evaluatedAt,
        error: error instanceof Error ? error.message : "Live readiness evaluation failed",
      },
      { status: 200 }
    );
  }
}
