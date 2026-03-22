/**
 * Runtime intent EQ snapshot for ShadowCandidate persistence.
 * Run: npx tsx lib/execution-quality/__tests__/runtime-intent-eq-snapshot.test.ts
 */

import assert from "assert";
import { evaluateExecutionQualityForRuntimeIntentRecord } from "../runtime-intent-eq-snapshot";

function check(cond: boolean, msg: string): void {
  assert.strictEqual(cond, true, msg);
}

function run(): void {
  console.log("\n--- assetLiveState missing => non-null JSON, null spread/quotes ---");
  {
    const r = evaluateExecutionQualityForRuntimeIntentRecord({
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      intendedPrice: 0.55,
      intendedSize: 10,
      assetLiveState: undefined,
    });
    check(typeof r.snapshotJson === "string" && r.snapshotJson.length > 0, "snapshotJson non-empty string");
    const o = JSON.parse(r.snapshotJson) as Record<string, unknown>;
    check(o.spreadBps === null, "spreadBps null");
    check(o.bestBid === null, "bestBid null");
    check(o.bestAsk === null, "bestAsk null");
    check(o.midPrice === null, "midPrice null");
  }

  console.log("\n--- assetLiveState present => numeric quotes and spreadBps ---");
  {
    const r = evaluateExecutionQualityForRuntimeIntentRecord({
      assetId: "a1",
      marketId: "m1",
      side: "BUY",
      intendedPrice: 0.5,
      intendedSize: 5,
      assetLiveState: {
        quote: {
          bestBid: 0.48,
          bestAsk: 0.52,
          spreadBps: undefined,
          updatedAt: new Date(),
        },
        depth: { bidTopSize: 100, askTopSize: 100 },
        liquidity: { qualityScore: 0.9, isTradable: true },
      },
    });
    const o = JSON.parse(r.snapshotJson) as Record<string, unknown>;
    check(typeof o.spreadBps === "number" && Number.isFinite(o.spreadBps as number), "spreadBps is finite number");
    check(o.bestBid === 0.48, "bestBid preserved");
    check(o.bestAsk === 0.52, "bestAsk preserved");
    check(typeof o.midPrice === "number" && (o.midPrice as number) > 0, "midPrice numeric");
  }

  console.log("\n--- all runtime-intent-eq-snapshot tests passed ---\n");
}

run();
