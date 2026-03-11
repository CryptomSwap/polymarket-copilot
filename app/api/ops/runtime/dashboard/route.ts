import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getTradingExecutionPolicy,
  type TradingExecutionPolicy,
} from "@/lib/runtime/trading-execution-policy";

export const dynamic = "force-dynamic";

const WORKER_NAME = "polymarket-copilot-worker";

/**
 * GET /api/ops/runtime/dashboard
 * Returns a concise runtime dashboard for paper validation: mode, adapter, counts,
 * diagnostics summary, risk state, component health. Read-only; no side effects.
 * Live trading is never enabled; dashboard explicitly reflects fail-closed state.
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
        message: "Stream runtime not reported (worker may not be running with USE_STREAM_RUNTIME)",
        liveTradingBlocked: !policy.liveOrManualExecutionAllowed,
        automatedExecutionAllowed: policy.automatedExecutionAllowed,
        executionPolicy: policy,
        adapterMode: null,
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
        message: "Worker heartbeat has no runtimeHealth (start worker with USE_STREAM_RUNTIME=true)",
        liveTradingBlocked: !policy.liveOrManualExecutionAllowed,
        executionPolicy: policy,
        adapterMode: null,
      });
    }

    const counts = (runtimeHealth.counts ?? {}) as Record<string, unknown>;
    const streams = (runtimeHealth.streams ?? {}) as Record<string, unknown>;
    const diagnostics = (runtimeHealth.diagnostics ?? {}) as Record<string, unknown>;

    const executionPolicy = runtimeHealth.executionPolicy as TradingExecutionPolicy | undefined;
    const liveTradingBlocked = executionPolicy
      ? !executionPolicy.liveOrManualExecutionAllowed
      : true;
    const automatedExecutionAllowed = executionPolicy?.automatedExecutionAllowed ?? false;

    const dashboard = {
      status: (runtimeHealth.status as string) ?? "ok",
      lifecycleStatus: runtimeHealth.lifecycleStatus ?? runtimeHealth.status,
      lastSeenAt: heartbeat.lastSeenAt.toISOString(),
      liveTradingBlocked,
      automatedExecutionAllowed,
      executionPolicy: executionPolicy ?? getTradingExecutionPolicy(),
      adapterMode: (runtimeHealth.mode as string) ?? "paper",
      runtimeMode: runtimeHealth.runtimeMode ?? runtimeHealth.mode,
      globalAutomationEnabled: runtimeHealth.globalAutomationEnabled,
      degradedReasons: (runtimeHealth.degradedReasons as string[]) ?? [],
      components: runtimeHealth.components,
      streams: {
        marketWsConnected: streams.marketWsConnected,
        userWsConnected: streams.userWsConnected,
        marketConnection: streams.marketConnection ?? null,
        userConnection: streams.userConnection ?? null,
        operationalReadiness: streams.operationalReadiness ?? false,
        trackedAssetCount: streams.trackedAssetCount ?? 0,
      },
      counts: {
        staleAssetCount: counts.staleAssetCount ?? 0,
        degradedAssetCount: counts.degradedAssetCount ?? 0,
        openOrderCount: counts.openOrderCount ?? 0,
        positionCount: counts.positionCount ?? 0,
        grossExposure: counts.grossExposure ?? 0,
        netExposure: counts.netExposure ?? 0,
        schedulerBacklog: counts.schedulerBacklog ?? 0,
      },
      diagnostics: {
        botEvaluations: diagnostics.botEvaluations ?? 0,
        orderIntentsGenerated: diagnostics.orderIntentsGenerated ?? 0,
        intentsBlockedByMode: diagnostics.intentsBlockedByMode ?? {},
        intentsBlockedByGuardrails: diagnostics.intentsBlockedByGuardrails ?? 0,
        reconciliationActionsByKind: diagnostics.reconciliationActionsByKind ?? {},
        fillsHandled: diagnostics.fillsHandled ?? 0,
        partialFillsApplied: diagnostics.partialFillsApplied ?? 0,
        fullFillsApplied: diagnostics.fullFillsApplied ?? 0,
        positionUpdates: diagnostics.positionUpdates ?? 0,
        exposureUpdates: diagnostics.exposureUpdates ?? 0,
        staleOrderDetections: diagnostics.staleOrderDetections ?? 0,
        riskBlocks: diagnostics.riskBlocks ?? 0,
        killSwitchChanges: diagnostics.killSwitchChanges ?? 0,
        reconcileFailureCount: diagnostics.reconcileFailureCount ?? 0,
        lastReconcileFailureAt: diagnostics.lastReconcileFailureAt ?? null,
        lastReconcileFailureReason: diagnostics.lastReconcileFailureReason ?? null,
        lastReconcileFailureIntentId: diagnostics.lastReconcileFailureIntentId ?? null,
      },
      asOf: (diagnostics.asOf as string) ?? new Date().toISOString(),
    };

    return NextResponse.json(dashboard);
  } catch (error) {
    console.error("[GET /api/ops/runtime/dashboard]", error);
    const policy = getTradingExecutionPolicy();
    return NextResponse.json(
      {
        error: "Failed to fetch runtime dashboard",
        liveTradingBlocked: !policy.liveOrManualExecutionAllowed,
      },
      { status: 500 }
    );
  }
}
