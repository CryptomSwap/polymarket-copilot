/**
 * Intent emission diagnostics: verify whether the bot loop is active, whether
 * order intents are emitted, and whether ShadowCandidate creation is reachable.
 * Read-only; uses API (dashboard, stream-health) and DB. Run: npm run check:intent-emission
 */

import { prisma } from "../lib/db";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const RECENT_HOURS = 24;

async function fetchJson<T = unknown>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function section(title: string): void {
  console.log("");
  console.log("--- " + title + " ---");
}

async function main(): Promise<void> {
  console.log("Intent emission diagnostics (read-only)");
  console.log("BASE_URL: " + BASE_URL);
  console.log("Database: " + (process.env.DATABASE_URL ? "configured" : "DATABASE_URL not set"));

  // --- API: runtime dashboard (worker heartbeat diagnostics) ---
  section("Runtime dashboard (worker heartbeat)");
  const dashboard = await fetchJson<{
    status?: string;
    lastSeenAt?: string;
    diagnostics?: {
      botEvaluations?: number;
      orderIntentsGenerated?: number;
      decisionTypesByAction?: Record<string, number>;
      noopReasonsByCode?: Record<string, number>;
      intentsBlockedByMode?: Record<string, number>;
      intentsBlockedByGuardrails?: number;
      intentsBlockedByFreshness?: number;
    };
    streams?: { operationalReadiness?: boolean };
    globalAutomationEnabled?: boolean;
  }>(`${BASE_URL}/api/ops/runtime/dashboard`);

  if (!dashboard) {
    console.log("  Dashboard: unreachable or not OK (is Next.js running?)");
  } else {
    console.log("  status:                " + (dashboard.status ?? "—"));
    console.log("  lastSeenAt:            " + (dashboard.lastSeenAt ?? "—"));
    console.log("  globalAutomationEnabled: " + (dashboard.globalAutomationEnabled ?? "—"));
    const diag = dashboard.diagnostics ?? {};
    console.log("  botEvaluations:        " + (diag.botEvaluations ?? 0));
    console.log("  orderIntentsGenerated: " + (diag.orderIntentsGenerated ?? 0));
    if (diag.decisionTypesByAction && Object.keys(diag.decisionTypesByAction).length > 0) {
      console.log("  decisionTypesByAction:  " + JSON.stringify(diag.decisionTypesByAction));
    }
    if (diag.noopReasonsByCode && Object.keys(diag.noopReasonsByCode).length > 0) {
      console.log("  noopReasonsByCode:      " + JSON.stringify(diag.noopReasonsByCode));
    }
    if (diag.intentsBlockedByMode && Object.keys(diag.intentsBlockedByMode).length > 0) {
      console.log("  intentsBlockedByMode:  " + JSON.stringify(diag.intentsBlockedByMode));
    }
    console.log("  intentsBlockedByGuardrails: " + (diag.intentsBlockedByGuardrails ?? 0));
    console.log("  intentsBlockedByFreshness:   " + (diag.intentsBlockedByFreshness ?? 0));
    console.log("  operationalReadiness:   " + (dashboard.streams?.operationalReadiness ?? "—"));
  }

  // --- API: stream health ---
  section("Stream health");
  const streamHealth = await fetchJson<{
    runtime?: { operationalReadiness?: boolean; watchdogState?: string };
    marketSubscriptionCoverage?: { inSync?: boolean };
  }>(`${BASE_URL}/api/live/stream-health`);
  if (!streamHealth) {
    console.log("  Stream health: unreachable");
  } else {
    console.log("  operationalReadiness: " + (streamHealth.runtime?.operationalReadiness ?? "—"));
    console.log("  watchdogState:      " + (streamHealth.runtime?.watchdogState ?? "—"));
    console.log("  marketSubscriptionCoverage.inSync: " + (streamHealth.marketSubscriptionCoverage?.inSync ?? "—"));
  }

  // --- DB: recommendations, intents, executed orders, shadow candidates ---
  section("Database (recent activity)");
  const since = new Date(Date.now() - RECENT_HOURS * 60 * 60 * 1000);

  let recentRecommendations = 0;
  let recentOrderIntents = 0;
  let recentExecutedOrders = 0;
  let shadowCandidateTotal = 0;

  try {
    recentRecommendations = await prisma.recommendation.count({
      where: { createdAt: { gte: since } },
    });
    recentOrderIntents = await prisma.orderIntent.count({
      where: { createdAt: { gte: since } },
    });
    recentExecutedOrders = await prisma.executedOrder.count({
      where: { createdAt: { gte: since } },
    });
    shadowCandidateTotal = await prisma.shadowCandidate.count();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("  DB error: " + msg);
  }

  console.log("  Recommendations (last " + RECENT_HOURS + "h): " + recentRecommendations);
  console.log("  OrderIntent (last " + RECENT_HOURS + "h):     " + recentOrderIntents);
  console.log("  ExecutedOrder (last " + RECENT_HOURS + "h):  " + recentExecutedOrders);
  console.log("  ShadowCandidate (total): " + shadowCandidateTotal);

  // Recent OrderIntent sample
  try {
    const recentIntents = await prisma.orderIntent.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, source: true, status: true, createdAt: true, assetId: true },
    });
    if (recentIntents.length > 0) {
      console.log("");
      console.log("  Recent OrderIntent (up to 5):");
      for (const i of recentIntents) {
        console.log(
          "    " +
            i.id.slice(0, 12) +
            "…  " +
            i.createdAt.toISOString().slice(0, 19) +
            "  source=" +
            (i.source ?? "—") +
            "  status=" +
            i.status +
            "  assetId=" +
            (i.assetId?.slice(0, 12) ?? "—") +
            "…"
        );
      }
    }
  } catch {
    // ignore
  }

  // --- Verdict ---
  section("Verdict: is ShadowCandidate creation reachable?");
  const botEvals = dashboard?.diagnostics?.botEvaluations ?? 0;
  const intentsGenerated = dashboard?.diagnostics?.orderIntentsGenerated ?? 0;
  const noopReasons = dashboard?.diagnostics?.noopReasonsByCode ?? {};

  if (!dashboard || dashboard.status === "no_runtime") {
    console.log("  Worker not running or no runtime health in heartbeat.");
    console.log("  Start the worker (USE_STREAM_RUNTIME=true) to get strategy/intent diagnostics.");
    console.log("  ShadowCandidate creation is only possible when the worker is running and emitting intents.");
  } else if (botEvals === 0) {
    console.log("  No strategy evaluations (botEvaluations=0).");
    console.log("  Market events may not be reaching the bot scheduler, or the runtime may have just started.");
    console.log("  ShadowCandidate creation requires the strategy to run and emit at least one intent (or block at guardrails).");
  } else if (intentsGenerated === 0) {
    console.log("  Strategy is evaluating but orderIntentsGenerated=0 → strategy is always returning NOOP.");
    if (Object.keys(noopReasons).length > 0) {
      console.log("  Dominant NOOP reasons: " + JSON.stringify(noopReasons));
      if (noopReasons["kill_switch"]) {
        console.log("  → Clear the kill switch and ensure watchdogState is not sticky after clear.");
      }
      if (noopReasons["no_signal"]) {
        console.log("  → Ensure market state has quote/spread/liquidity for tracked assets; check market WS → engine → events.");
      }
      if (noopReasons["market_stale"] || noopReasons["market_degraded"]) {
        console.log("  → Market health thresholds may be too strict; or allowDegradedForPaper for paper mode.");
      }
    }
    console.log("  ShadowCandidate creation is NOT reachable until at least one order.intent.created is emitted.");
  } else if (shadowCandidateTotal === 0) {
    console.log("  Intents are being emitted (orderIntentsGenerated>0) but ShadowCandidate total=0.");
    console.log("  Intents may be blocked before the guardrail/record path (e.g. status !== ready or execution policy).");
    console.log("  Check intentsBlockedByMode and that runtime status is 'ready' and execution policy allows runtime_automated.");
  } else {
    console.log("  Yes. Strategy is evaluating, intents are emitted, and ShadowCandidate rows exist.");
    console.log("  ShadowCandidate creation is reachable and has occurred.");
  }

  console.log("");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
