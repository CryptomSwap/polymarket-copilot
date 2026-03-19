import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFunderForRecompute } from "@/lib/polymarket/recompute";
import { getStreamSyncState } from "@/lib/live/streaming-sync";

export const dynamic = "force-dynamic";

const MARKET_FEED_FUNDER = "system";
const WORKER_NAME = "polymarket-copilot-worker";

/**
 * GET /api/live/stream-health
 * Internal health/status for Streaming Sync Layer:
 * user stream connected, market stream connected, tracked asset count,
 * last event time, last reconciliation time.
 * When worker runs with USE_STREAM_RUNTIME, also returns socketOpen, heartbeatHealthy,
 * dataFlowHealthy, operationalReadiness, lastDataEventAt, lastHeartbeatAt, watchdogState.
 */
export async function GET() {
  const funder = await getFunderForRecompute();
  const [userRow, marketRow, syncState, heartbeat] = await Promise.all([
    funder
      ? prisma.websocketConnectionStatus.findUnique({
          where: { funderAddress_channel: { funderAddress: funder.toLowerCase(), channel: "user-feed" } },
        })
      : null,
    prisma.websocketConnectionStatus.findUnique({
      where: { funderAddress_channel: { funderAddress: MARKET_FEED_FUNDER, channel: "market-feed" } },
    }),
    getStreamSyncState(),
    prisma.workerHeartbeat.findFirst({
      where: { workerName: WORKER_NAME },
      orderBy: { lastSeenAt: "desc" },
    }),
  ]);

  const base = {
    userStreamConnected: userRow?.connected ?? false,
    marketStreamConnected: marketRow?.connected ?? false,
    trackedAssetCount: syncState?.trackedAssetCount ?? 0,
    lastEventAt: syncState?.lastEventAt?.toISOString() ?? null,
    lastReconciliationAt: syncState?.lastReconciliationAt?.toISOString() ?? null,
    updatedAt: syncState?.updatedAt?.toISOString() ?? null,
  };

  let runtimeStreams: Record<string, unknown> | null = null;
  let operatorHealth: Record<string, unknown> | null = null;
  let marketSubscriptionCoverage: Record<string, unknown> | null = null;
  if (heartbeat?.metadataJson) {
    try {
      const metadata = JSON.parse(heartbeat.metadataJson) as Record<string, unknown>;
      const runtimeHealth = metadata.runtimeHealth as Record<string, unknown> | undefined;
      if (runtimeHealth?.operatorHealth && typeof runtimeHealth.operatorHealth === "object") {
        operatorHealth = runtimeHealth.operatorHealth as Record<string, unknown>;
      }
      if (runtimeHealth?.marketSubscriptionCoverage && typeof runtimeHealth.marketSubscriptionCoverage === "object") {
        marketSubscriptionCoverage = runtimeHealth.marketSubscriptionCoverage as Record<string, unknown>;
      }
      if (runtimeHealth?.streams && typeof runtimeHealth.streams === "object") {
        const streams = runtimeHealth.streams as Record<string, unknown>;
        runtimeStreams = {
          socketOpen: streams.socketOpen ?? null,
          heartbeatHealthy: streams.heartbeatHealthy ?? null,
          dataFlowHealthy: streams.dataFlowHealthy ?? null,
          operationalReadiness: streams.operationalReadiness ?? null,
          marketLastDataEventAt: streams.marketLastDataEventAt ?? null,
          userLastDataEventAt: streams.userLastDataEventAt ?? null,
          marketLastHeartbeatAt: streams.marketLastHeartbeatAt ?? null,
          userLastHeartbeatAt: streams.userLastHeartbeatAt ?? null,
          watchdogState: runtimeHealth.watchdogState ?? null,
          watchdogReasons: runtimeHealth.watchdogReasons ?? null,
        };
      }
    } catch {
      /* ignore parse errors */
    }
  }

  return NextResponse.json({
    ...base,
    ...(runtimeStreams ? { runtime: runtimeStreams } : {}),
    /** Operator-facing: connection, heartbeat, dataFreshness, reconciliation, readiness, killSwitch. Use to distinguish connected vs heartbeat vs real data vs reconciled vs safeToAutomate. */
    ...(operatorHealth ? { operatorHealth } : {}),
    /** Market WS: desired vs subscribed, pending, churn. */
    ...(marketSubscriptionCoverage ? { marketSubscriptionCoverage } : {}),
  });
}
