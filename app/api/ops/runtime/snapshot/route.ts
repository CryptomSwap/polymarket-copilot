import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getTradingExecutionPolicy,
  type TradingExecutionPolicy,
} from "@/lib/runtime/trading-execution-policy";

export const dynamic = "force-dynamic";

const WORKER_NAME = "polymarket-copilot-worker";

/**
 * GET /api/ops/runtime/snapshot
 * Returns a concise runtime snapshot for paper validation: mode, tracked assets count,
 * sample health, open orders count, position count, exposure, risk summary, adapter.
 * Read-only. Use for quick inspection during validation sessions.
 */
export async function GET() {
  try {
    const heartbeat = await prisma.workerHeartbeat.findFirst({
      where: { workerName: WORKER_NAME },
      orderBy: { lastSeenAt: "desc" },
    });
    if (!heartbeat?.metadataJson) {
      const policy = getTradingExecutionPolicy();
      return NextResponse.json({
        status: "no_runtime",
        message: "Stream runtime not reported",
        mode: null,
        liveTradingBlocked: !policy.liveOrManualExecutionAllowed,
        executionPolicy: policy,
      });
    }
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(heartbeat.metadataJson) as Record<string, unknown>;
    } catch {
      const policy = getTradingExecutionPolicy();
      return NextResponse.json({
        status: "no_runtime",
        message: "Invalid heartbeat metadata",
        liveTradingBlocked: !policy.liveOrManualExecutionAllowed,
      });
    }
    const runtimeHealth = metadata.runtimeHealth as Record<string, unknown> | null | undefined;
    if (runtimeHealth == null) {
      const policy = getTradingExecutionPolicy();
      return NextResponse.json({
        status: "no_runtime",
        message: "No runtimeHealth in heartbeat",
        liveTradingBlocked: !policy.liveOrManualExecutionAllowed,
        executionPolicy: policy,
      });
    }

    const counts = (runtimeHealth.counts ?? {}) as Record<string, unknown>;
    const streams = (runtimeHealth.streams ?? {}) as Record<string, unknown>;
    const executionPolicy = runtimeHealth.executionPolicy as TradingExecutionPolicy | undefined;
    const liveTradingBlocked = executionPolicy
      ? !executionPolicy.liveOrManualExecutionAllowed
      : !getTradingExecutionPolicy().liveOrManualExecutionAllowed;

    const snapshot = {
      status: (runtimeHealth.status as string) ?? "ok",
      lifecycleStatus: runtimeHealth.lifecycleStatus ?? runtimeHealth.status,
      lastSeenAt: heartbeat.lastSeenAt.toISOString(),
      mode: runtimeHealth.runtimeMode ?? runtimeHealth.mode,
      adapterMode: runtimeHealth.mode ?? "paper",
      liveTradingBlocked,
      executionPolicy: executionPolicy ?? getTradingExecutionPolicy(),
      degradedReasons: (runtimeHealth.degradedReasons as string[]) ?? [],
      trackedAssetCount: streams.trackedAssetCount ?? 0,
      openOrderCount: counts.openOrderCount ?? 0,
      positionCount: counts.positionCount ?? 0,
      grossExposure: counts.grossExposure ?? 0,
      netExposure: counts.netExposure ?? 0,
      staleAssetCount: counts.staleAssetCount ?? 0,
      degradedAssetCount: counts.degradedAssetCount ?? 0,
      schedulerBacklog: counts.schedulerBacklog ?? 0,
      globalAutomationEnabled: runtimeHealth.globalAutomationEnabled,
      components: runtimeHealth.components,
      streams: {
        marketWsConnected: streams.marketWsConnected,
        userWsConnected: streams.userWsConnected,
        marketConnection: streams.marketConnection ?? null,
        userConnection: streams.userConnection ?? null,
        operationalReadiness: streams.operationalReadiness ?? false,
        trackedAssetCount: streams.trackedAssetCount ?? 0,
      },
    };

    return NextResponse.json(snapshot);
  } catch (error) {
    console.error("[GET /api/ops/runtime/snapshot]", error);
    const policy = getTradingExecutionPolicy();
    return NextResponse.json(
      {
        error: "Failed to fetch runtime snapshot",
        liveTradingBlocked: !policy.liveOrManualExecutionAllowed,
      },
      { status: 500 }
    );
  }
}
