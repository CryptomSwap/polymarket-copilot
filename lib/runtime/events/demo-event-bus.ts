/**
 * Demo / sanity check for the runtime event bus.
 * Run with: npx ts-node -r tsconfig-paths/register lib/runtime/events/demo-event-bus.ts
 * Or: node --import tsx lib/runtime/events/demo-event-bus.ts
 *
 * Not wired into production. Verifies:
 * - subscribe by type and wildcard
 * - publish delivers to correct handlers
 * - unsubscribe works
 * - one failing handler does not prevent others from running
 */

import { createRuntimeEventId, RUNTIME_EVENT_BUS_WILDCARD } from "./runtime-events";
import { InMemoryRuntimeEventBus } from "./runtime-event-bus";

function runDemo(): void {
  const bus = new InMemoryRuntimeEventBus();
  const received: string[] = [];

  // 1) Type-specific subscription
  const unsubQuote = bus.subscribe("market.quote.changed", (ev) => {
    received.push(`quote:${ev.payload.assetId}`);
  });

  // 2) Wildcard subscription
  const unsubWild = bus.subscribe(RUNTIME_EVENT_BUS_WILDCARD, (ev) => {
    received.push(`*:${ev.type}`);
  });

  // 3) Publish market.quote.changed
  bus.publish({
    id: createRuntimeEventId(),
    type: "market.quote.changed",
    source: "market_state",
    occurredAt: new Date(),
    payload: {
      assetId: "0xabc",
      marketId: "m1",
      outcome: "Yes",
      bestBid: 0.5,
      bestAsk: 0.52,
      midPrice: 0.51,
      lastTradePrice: 0.5,
    },
  });

  // 4) Publish runtime.tick (only wildcard should see it for our "*" handler; quote handler should not)
  bus.publish({
    id: createRuntimeEventId(),
    type: "runtime.tick",
    source: "system",
    occurredAt: new Date(),
    payload: { tickId: "t1", asOf: new Date() },
  });

  unsubQuote();
  // Publish another quote after unsub - only wildcard should see it
  bus.publish({
    id: createRuntimeEventId(),
    type: "market.quote.changed",
    source: "market_state",
    occurredAt: new Date(),
    payload: {
      assetId: "0xdef",
      marketId: "m2",
      outcome: "No",
      bestBid: 0.48,
      bestAsk: 0.5,
      midPrice: 0.49,
      lastTradePrice: 0.48,
    },
  });

  unsubWild();

  // Expected: quote:0xabc, *:market.quote.changed, *:runtime.tick, *:market.quote.changed
  const expected = ["quote:0xabc", "*:market.quote.changed", "*:runtime.tick", "*:market.quote.changed"];
  const ok =
    received.length === expected.length && received.every((v, i) => v === expected[i]);
  if (ok) {
    console.log("[demo-event-bus] OK: received", received);
  } else {
    console.error("[demo-event-bus] FAIL: expected", expected, "got", received);
    process.exitCode = 1;
  }
}

function runIsolationDemo(): void {
  const bus = new InMemoryRuntimeEventBus();
  const received: string[] = [];

  bus.subscribe("market.trade.printed", (ev) => {
    received.push(`a:${ev.payload.assetId}`);
  });
  bus.subscribe("market.trade.printed", () => {
    throw new Error("Intentional handler error");
  });
  bus.subscribe("market.trade.printed", (ev) => {
    received.push(`b:${ev.payload.assetId}`);
  });

  bus.publish({
    id: createRuntimeEventId(),
    type: "market.trade.printed",
    source: "market_ws",
    occurredAt: new Date(),
    payload: { assetId: "0x123", marketId: "m1", outcome: "Yes", price: 0.5, size: 10, side: "BUY" },
  });

  // Both a and b should be present despite middle handler throwing
  const hasA = received.some((r) => r.startsWith("a:"));
  const hasB = received.some((r) => r.startsWith("b:"));
  if (hasA && hasB) {
    console.log("[demo-event-bus] Isolation OK: received", received);
  } else {
    console.error("[demo-event-bus] Isolation FAIL: expected both a and b, got", received);
    process.exitCode = 1;
  }
}

runDemo();
runIsolationDemo();
