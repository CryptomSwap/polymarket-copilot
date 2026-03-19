/**
 * Stream Watchdog and data-freshness degraded tests:
 * - socket open + heartbeat only + no data => degraded
 * - market data resumes => recovered
 * - working orders + stale user stream => degraded
 * - severe stream silence => kill switch
 * - heartbeat alone never counts as real data flow
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/stream-watchdog-degraded-tests.ts
 */

import assert from "assert";
import {
  createInitialStreamConnectionState,
  type StreamConnectionState,
} from "../stream-connection-state";
import { computeDegraded } from "../runtime-degraded";
import { evaluateStreamWatchdog } from "../stream-watchdog";
import { DEFAULT_STREAM_WATCHDOG_CONFIG } from "../stream-watchdog-config";

function ok(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  function check(cond: boolean, msg: string): void {
    if (cond) {
      passed++;
      console.log("  OK:", msg);
    } else {
      failed++;
      console.error("  FAIL:", msg);
    }
  }

  const now = Date.now();
  const oneMinuteAgo = new Date(now - 60_000);
  const twoMinutesAgo = new Date(now - 120_000);

  console.log("\n--- Socket open + heartbeat only + no data => degraded ---");
  {
    const marketOpenHeartbeatOnly: StreamConnectionState = {
      ...createInitialStreamConnectionState(),
      status: "open",
      lastOpenAt: oneMinuteAgo,
      lastMessageAt: oneMinuteAgo,
      lastSocketFrameAt: oneMinuteAgo,
      lastHeartbeatAt: new Date(now - 5_000),
      lastDataEventAt: null as unknown as undefined,
    };
    const userOpenHeartbeatOnly: StreamConnectionState = {
      ...createInitialStreamConnectionState(),
      status: "open",
      lastOpenAt: oneMinuteAgo,
      lastMessageAt: oneMinuteAgo,
      lastHeartbeatAt: new Date(now - 5_000),
      lastDataEventAt: null as unknown as undefined,
    };
    const r = computeDegraded({
      marketConnection: marketOpenHeartbeatOnly,
      userConnection: userOpenHeartbeatOnly,
      marketDataStaleThresholdMs: 60_000,
      userDataStaleThresholdMs: 90_000,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 5,
    });
    check(r.degraded === true, "degraded when socket open but no real data (only heartbeat)");
    check(r.reasons.includes("market_data_silence") || r.reasons.includes("market_data_stale"), "market data silence or stale");
  }

  console.log("\n--- Heartbeat alone never counts as real data flow ---");
  {
    const stateWithOnlyHeartbeat: StreamConnectionState = {
      ...createInitialStreamConnectionState(),
      status: "open",
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastDataEventAt: undefined,
    };
    ok(stateWithOnlyHeartbeat.lastDataEventAt == null, "lastDataEventAt not set by heartbeat");
    const r = computeDegraded({
      marketConnection: stateWithOnlyHeartbeat,
      userConnection: stateWithOnlyHeartbeat,
      marketDataStaleThresholdMs: 30_000,
      userDataStaleThresholdMs: 30_000,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 1,
    });
    check(r.degraded === true, "degraded when only heartbeat (tracked assets > 0)");
    check(r.reasons.some((x) => x.includes("market") || x.includes("user")), "reason mentions stream");
  }

  console.log("\n--- Market data resumes => recovered ---");
  {
    const recentData = new Date(now - 10_000);
    const marketWithData: StreamConnectionState = {
      ...createInitialStreamConnectionState(),
      status: "open",
      lastOpenAt: oneMinuteAgo,
      lastMessageAt: recentData,
      lastDataEventAt: recentData,
      lastHeartbeatAt: new Date(now - 2_000),
    };
    const userWithData: StreamConnectionState = {
      ...createInitialStreamConnectionState(),
      status: "open",
      lastOpenAt: oneMinuteAgo,
      lastMessageAt: recentData,
      lastDataEventAt: recentData,
    };
    const r = computeDegraded({
      marketConnection: marketWithData,
      userConnection: userWithData,
      marketDataStaleThresholdMs: 60_000,
      userDataStaleThresholdMs: 90_000,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 5,
      lastExchangeOrdersSnapshotAt: new Date(now - 10_000),
      lastExchangeFillsSnapshotAt: new Date(now - 10_000),
    });
    check(r.degraded === false, "not degraded when both streams have recent real data");
    check(r.reasons.length === 0, "no reasons when recovered");
  }

  console.log("\n--- Working orders + stale user stream => degraded ---");
  {
    const userStale: StreamConnectionState = {
      ...createInitialStreamConnectionState(),
      status: "open",
      lastOpenAt: oneMinuteAgo,
      lastMessageAt: twoMinutesAgo,
      lastHeartbeatAt: new Date(now - 5_000),
      lastDataEventAt: twoMinutesAgo,
    };
    const r = computeDegraded({
      marketConnection: {
        ...createInitialStreamConnectionState(),
        status: "open",
        lastOpenAt: new Date(),
        lastMessageAt: new Date(),
        lastDataEventAt: new Date(),
      },
      userConnection: userStale,
      marketDataStaleThresholdMs: 60_000,
      userDataStaleThresholdMs: 90_000,
      openOrderCount: 2,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 5,
    });
    check(r.degraded === true, "degraded when user data stale");
    check(r.reasons.includes("user_data_stale"), "reason user_data_stale");
  }

  console.log("\n--- User data silence with working orders => user_data_silence_with_orders ---");
  {
    const userOpenNoData: StreamConnectionState = {
      ...createInitialStreamConnectionState(),
      status: "open",
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastDataEventAt: undefined,
    };
    const r = computeDegraded({
      marketConnection: { ...createInitialStreamConnectionState(), status: "open", lastOpenAt: new Date(), lastMessageAt: new Date(), lastDataEventAt: new Date() },
      userConnection: userOpenNoData,
      marketDataStaleThresholdMs: 60_000,
      userDataStaleThresholdMs: 90_000,
      openOrderCount: 1,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 5,
    });
    check(r.degraded === true, "degraded when user has working orders but no user data events");
    check(r.reasons.includes("user_data_silence_with_orders"), "reason user_data_silence_with_orders");
  }

  console.log("\n--- Recent user_sync (REST) + open orders + no WS data => not user_data_silence_with_orders ---");
  {
    const userOpenNoData: StreamConnectionState = {
      ...createInitialStreamConnectionState(),
      status: "open",
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastDataEventAt: undefined,
    };
    const r = computeDegraded({
      marketConnection: { ...createInitialStreamConnectionState(), status: "open", lastOpenAt: new Date(), lastMessageAt: new Date(), lastDataEventAt: new Date() },
      userConnection: userOpenNoData,
      marketDataStaleThresholdMs: 60_000,
      userDataStaleThresholdMs: 90_000,
      openOrderCount: 1,
      lastSuccessfulUserTruthFetchAt: new Date(now - 10_000),
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 5,
      lastExchangeOrdersSnapshotAt: new Date(now - 10_000),
      lastExchangeFillsSnapshotAt: new Date(now - 10_000),
    });
    check(!r.reasons.includes("user_data_silence_with_orders"), "REST user truth counts as user data for silence rule");
  }

  console.log("\n--- Watchdog: severe stream silence => kill switch ---");
  {
    const config = { ...DEFAULT_STREAM_WATCHDOG_CONFIG, marketDataKillSwitchThresholdMs: 120_000, userDataKillSwitchWithOrdersThresholdMs: 60_000 };
    const marketStale = new Date(now - 180_000);
    const w = evaluateStreamWatchdog({
      marketConnection: {
        ...createInitialStreamConnectionState(),
        status: "open",
        lastOpenAt: marketStale,
        lastMessageAt: marketStale,
        lastHeartbeatAt: new Date(now - 10_000),
        lastDataEventAt: marketStale,
      },
      userConnection: {
        ...createInitialStreamConnectionState(),
        status: "open",
        lastOpenAt: new Date(),
        lastMessageAt: new Date(),
        lastDataEventAt: new Date(now - 90_000),
      },
      trackedAssetCount: 3,
      openOrderCount: 1,
      config,
    });
    check(w.degraded === true, "watchdog degraded");
    check(w.triggerKillSwitch === true, "watchdog suggests kill switch on severe silence");
    ok(w.killSwitchReason != null, "kill switch reason set");
  }

  console.log("\n--- Watchdog: reconnect churn ---");
  {
    const w = evaluateStreamWatchdog({
      marketConnection: {
        ...createInitialStreamConnectionState(),
        status: "open",
        lastOpenAt: new Date(),
        lastMessageAt: new Date(),
        lastDataEventAt: new Date(),
        reconnectAttempts: 8,
      },
      userConnection: {
        ...createInitialStreamConnectionState(),
        status: "open",
        lastOpenAt: new Date(),
        lastDataEventAt: new Date(),
      },
      trackedAssetCount: 2,
      openOrderCount: 0,
      config: DEFAULT_STREAM_WATCHDOG_CONFIG,
    });
    check(w.reasons.includes("reconnect_churn"), "watchdog reports reconnect_churn");
  }

  console.log("\n--- Watchdog: recent user truth fetch counts as user data (no false kill-switch) ---");
  {
    const userOpenNoWsData: StreamConnectionState = {
      ...createInitialStreamConnectionState(),
      status: "open",
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: undefined,
    };
    const recentUserTruth = new Date(now - 30_000);
    const w = evaluateStreamWatchdog({
      marketConnection: { ...createInitialStreamConnectionState(), status: "open", lastOpenAt: new Date(), lastMessageAt: new Date(), lastDataEventAt: new Date() },
      userConnection: userOpenNoWsData,
      trackedAssetCount: 2,
      openOrderCount: 1,
      config: DEFAULT_STREAM_WATCHDOG_CONFIG,
      lastSuccessfulUserTruthFetchAt: recentUserTruth,
    });
    check(!w.reasons.includes("user_data_silence_with_orders"), "no user_data_silence_with_orders when user truth fetch is recent");
    check(w.triggerKillSwitch === false, "no kill switch when user truth is fresh");
  }

  console.log("\n--- Summary ---");
  console.log("Passed:", passed, "Failed:", failed);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
