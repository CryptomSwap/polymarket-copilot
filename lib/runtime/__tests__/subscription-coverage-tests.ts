/**
 * Market subscription coverage: desired vs subscribed, pending, churn, degraded reasons.
 *
 * Run with (from repo root):
 *   npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/runtime/__tests__/subscription-coverage-tests.ts
 */

import assert from "assert";
import { createMarketWs } from "../../polymarket/ws-market";
import { computeDegraded } from "../runtime-degraded";
import { createInitialStreamConnectionState } from "../stream-connection-state";

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

  console.log("\n--- Tracked asset refresh: desired and pending ---");
  {
    const mws = createMarketWs(["a1", "a2", "a3"]);
    const cov = mws.getSubscriptionCoverage();
    check(cov.desiredTrackedAssetIds.length === 3, "desired has 3");
    check(cov.currentlySubscribedAssetIds.length === 0, "currently subscribed 0 before connect");
    check(cov.pendingSubscribeIds.length === 3, "pending subscribe = desired before connect");
    check(cov.pendingUnsubscribeIds.length === 0, "pending unsubscribe 0");
    check(cov.inSync === false, "not in sync before connect");
    mws.setTrackedAssetIds(["a1", "a2", "a4"]);
    const cov2 = mws.getSubscriptionCoverage();
    check(cov2.desiredTrackedAssetIds.length === 3, "desired still 3 after setTracked");
    check(cov2.desiredTrackedAssetIds.includes("a4"), "desired includes a4");
    check(!cov2.desiredTrackedAssetIds.includes("a3"), "desired no longer a3");
    check(cov2.currentlySubscribedAssetIds.length === 0, "still 0 subscribed (ws not open)");
    check(cov2.desiredNotSubscribed.length === 3, "desiredNotSubscribed = all desired");
    check(cov2.lastSubscriptionRefreshAt != null, "lastSubscriptionRefreshAt set");
    mws.close();
  }

  console.log("\n--- Coverage shape and lastSubscriptionRefreshAt ---");
  {
    const mws = createMarketWs(["x", "y"]);
    mws.setTrackedAssetIds(["x", "y", "z"]);
    const cov = mws.getSubscriptionCoverage();
    check(cov.desiredTrackedAssetIds.length === 3, "desired length 3");
    check(cov.lastSubscriptionRefreshAt != null, "lastSubscriptionRefreshAt set after setTrackedAssetIds");
    check(Array.isArray(cov.pendingSubscribeIds), "pendingSubscribeIds is array");
    check(Array.isArray(cov.subscribedButNotDesired), "subscribedButNotDesired is array");
    check(typeof cov.subscriptionChurnCount === "number", "subscriptionChurnCount number");
    mws.close();
  }

  console.log("\n--- Incomplete subscription coverage surfaced ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const r = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 2,
      marketSubscriptionCoverage: {
        inSync: false,
        desiredNotSubscribed: ["missing-id"],
        subscribedButNotDesired: [],
        subscriptionChurnCount: 0,
        lastSuccessfulSubscriptionSyncAt: null,
        desiredTrackedAssetIds: ["a", "missing-id"],
      },
    });
    check(r.degraded === true, "degraded when subscription mismatch");
    check(r.reasons.includes("subscription_mismatch"), "reasons include subscription_mismatch");
    check(r.reasons.includes("incomplete_resubscribe"), "reasons include incomplete_resubscribe (lastSync null)");
  }

  console.log("\n--- No false green when tracked assets exist but coverage incomplete ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const r = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 3,
      marketSubscriptionCoverage: {
        inSync: false,
        desiredNotSubscribed: ["id1", "id2"],
        subscribedButNotDesired: [],
        subscriptionChurnCount: 0,
        lastSuccessfulSubscriptionSyncAt: null,
        desiredTrackedAssetIds: ["id1", "id2", "id3"],
      },
    });
    check(r.degraded === true, "degraded when desired not all subscribed");
    check(r.reasons.includes("subscription_mismatch"), "subscription_mismatch present");
  }

  console.log("\n--- Subscription churn reason ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const r = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 1,
      marketSubscriptionCoverage: {
        inSync: true,
        desiredNotSubscribed: [],
        subscribedButNotDesired: [],
        subscriptionChurnCount: 10,
        lastSuccessfulSubscriptionSyncAt: new Date().toISOString(),
        desiredTrackedAssetIds: ["a"],
      },
      subscriptionChurnThreshold: 8,
    });
    check(r.reasons.includes("subscription_churn"), "subscription_churn when count >= threshold");
  }

  console.log("\n--- In sync: no subscription reasons ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const r = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 2,
      marketSubscriptionCoverage: {
        inSync: true,
        desiredNotSubscribed: [],
        subscribedButNotDesired: [],
        subscriptionChurnCount: 2,
        lastSuccessfulSubscriptionSyncAt: new Date().toISOString(),
        desiredTrackedAssetIds: ["a", "b"],
      },
    });
    check(!r.reasons.includes("subscription_mismatch"), "no subscription_mismatch when inSync");
    check(!r.reasons.includes("subscription_churn"), "no subscription_churn when below threshold");
    check(!r.reasons.includes("incomplete_resubscribe"), "no incomplete_resubscribe when lastSync recent");
  }

  console.log("\n--- Null coverage: no subscription reasons ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const r = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 2,
      marketSubscriptionCoverage: undefined,
    });
    check(!r.reasons.includes("subscription_mismatch"), "no subscription_mismatch when coverage null");
  }

  console.log("\n--- Subscribed but not desired surfaces mismatch ---");
  {
    const openState = {
      ...createInitialStreamConnectionState(),
      status: "open" as const,
      lastOpenAt: new Date(),
      lastMessageAt: new Date(),
      lastDataEventAt: new Date(),
    };
    const r = computeDegraded({
      marketConnection: openState,
      userConnection: openState,
      diagnostics: null,
      schedulerBacklog: 0,
      staleAssetCount: 0,
      degradedAssetCount: 0,
      trackedAssetCount: 1,
      marketSubscriptionCoverage: {
        inSync: false,
        desiredNotSubscribed: [],
        subscribedButNotDesired: ["stale-id"],
        subscriptionChurnCount: 0,
        lastSuccessfulSubscriptionSyncAt: new Date().toISOString(),
        desiredTrackedAssetIds: ["a"],
      },
    });
    check(r.reasons.includes("subscription_mismatch"), "subscription_mismatch when subscribedButNotDesired");
  }

  console.log("\n--- Result ---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
