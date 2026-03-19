/**
 * NOOP reasons diagnostic: report why the strategy returns NOOP and why intents are not emitted.
 * Read-only; uses runtime dashboard API. Run: npm run check:noop-reasons
 *
 * Reports:
 * - Top NOOP reasons (from noopReasonsByCode)
 * - Runtime fields that drive market_not_tradable / market_stale / no_signal
 * - Evaluation counts that resulted in each reason (cumulative since last diagnostics reset)
 * - Whether any assets currently look intent-eligible (inferred from reasons + config)
 * - Plain-English verdict
 *
 * Per-asset field inspection (e.g. liquidity.isTradable, health.isStale for specific assets)
 * requires worker-side state; see audit-dumps/noop-market-tradability-debug-map.md.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

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

interface DashboardResponse {
  status?: string;
  lastSeenAt?: string;
  globalAutomationEnabled?: boolean;
  streams?: { operationalReadiness?: boolean; trackedAssetCount?: number };
  watchdogState?: string;
  diagnostics?: {
    botEvaluations?: number;
    orderIntentsGenerated?: number;
    decisionTypesByAction?: Record<string, number>;
    noopReasonsByCode?: Record<string, number>;
    intentsBlockedByMode?: Record<string, number>;
    intentsBlockedByGuardrails?: number;
  };
}

async function main(): Promise<void> {
  console.log("NOOP reasons diagnostic (read-only)");
  console.log("BASE_URL: " + BASE_URL);

  section("Runtime dashboard");
  const dashboard = await fetchJson<DashboardResponse>(
    `${BASE_URL}/api/ops/runtime/dashboard`
  );

  if (!dashboard) {
    console.log("  Dashboard unreachable (is the app and worker running?).");
    console.log("  Verdict: Cannot diagnose NOOP reasons without runtime dashboard.");
    return;
  }

  console.log("  status:                   " + (dashboard.status ?? "—"));
  console.log("  lastSeenAt:                " + (dashboard.lastSeenAt ?? "—"));
  console.log("  globalAutomationEnabled:  " + (dashboard.globalAutomationEnabled ?? "—"));
  console.log("  operationalReadiness:     " + (dashboard.streams?.operationalReadiness ?? "—"));
  console.log("  watchdogState:            " + (dashboard.watchdogState ?? "—"));
  console.log("  trackedAssetCount:        " + (dashboard.streams?.trackedAssetCount ?? "—"));

  const diag = dashboard.diagnostics ?? {};
  const botEvals = diag.botEvaluations ?? 0;
  const intentsGenerated = diag.orderIntentsGenerated ?? 0;
  const noopReasons = diag.noopReasonsByCode ?? {};
  const decisionTypes = diag.decisionTypesByAction ?? {};

  console.log("  botEvaluations:           " + botEvals);
  console.log("  orderIntentsGenerated:    " + intentsGenerated);
  if (Object.keys(decisionTypes).length > 0) {
    console.log("  decisionTypesByAction:    " + JSON.stringify(decisionTypes));
  }

  section("Top NOOP reasons (cumulative since last diagnostics reset)");
  if (Object.keys(noopReasons).length === 0) {
    console.log("  No NOOP reasons recorded (no evaluations yet or no NOOPs).");
  } else {
    const entries = Object.entries(noopReasons).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of entries) {
      console.log("  " + reason + ": " + count);
    }
    const totalNoop = entries.reduce((s, [, c]) => s + c, 0);
    console.log("  (Total NOOP evaluations: " + totalNoop + ")");
  }

  section("Runtime fields that drive market_not_tradable / market_stale / no_signal");
  console.log("  market_not_tradable  → asset.liquidity.isTradable === false");
  console.log("                        (set by engine from quote+depth; quote-only or zero depth → false)");
  console.log("  market_stale        → asset.health.isStale === true");
  console.log("                        (lastMarketEventAt null or older than staleAfterMs 120s)");
  console.log("  no_signal (early)    → asset is null (asset not in market state store)");
  console.log("                        (no quote/depth/trade/repair update ever for that assetId)");
  console.log("  no_signal (late)    → spreadBps < 5 or qualityScore < 0.3 or mid missing");
  console.log("  See: audit-dumps/noop-market-tradability-debug-map.md");

  section("Evaluations blocked by each reason");
  if (Object.keys(noopReasons).length === 0) {
    console.log("  No data (run worker and trigger evaluations).");
  } else {
    console.log("  Counts below are evaluation counts (same asset can be evaluated many times).");
    for (const [reason, count] of Object.entries(noopReasons).sort((a, b) => b[1] - a[1])) {
      console.log("  " + reason + ": " + count + " evaluations");
    }
  }

  section("Intent-eligibility (inferred)");
  if (intentsGenerated > 0) {
    console.log("  Some intents are being generated; at least some assets are intent-eligible.");
  } else if (botEvals === 0) {
    console.log("  No evaluations yet; cannot infer intent-eligibility.");
  } else {
    const topReason = Object.entries(noopReasons).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (topReason === "market_not_tradable") {
      console.log("  Likely no assets are intent-eligible: most NOOPs are market_not_tradable.");
      console.log("  → liquidity.isTradable is false for most evaluated assets (e.g. quote-only or zero depth).");
      console.log("  → Ensure market state engine receives both quote and depth updates for tracked assets.");
      console.log("  → Or enable paper-only relaxation: allowQuoteOnlyForPaper (see docs/NOOP_MARKET_TRADABILITY_ROOT_CAUSE.md).");
    } else if (topReason === "market_stale" || topReason === "market_degraded") {
      console.log("  Likely no assets are intent-eligible: most NOOPs are " + topReason + ".");
      console.log("  → health.isStale/isDegraded true (no recent updates or last update > 120s ago).");
      console.log("  → Ensure feed is sending updates and tick() is not marking all assets stale.");
    } else if (topReason === "no_signal") {
      console.log("  Likely no assets are intent-eligible: most NOOPs are no_signal.");
      console.log("  → Either assets missing from store (no updates) or spread/quality/mid fail thresholds.");
    } else {
      console.log("  Dominant NOOP reason: " + (topReason ?? "—") + ". See docs for that reason code.");
    }
  }

  section("Verdict: why intents are not being emitted");
  if (!dashboard || dashboard.status === "no_runtime") {
    console.log("  Worker/runtime not reported. Start worker with USE_STREAM_RUNTIME to get strategy evaluations and intents.");
  } else if (dashboard.globalAutomationEnabled !== true) {
    console.log("  globalAutomationEnabled is not true; strategy returns NOOP for kill_switch. Clear kill switch and ensure health reflects it.");
  } else if (botEvals === 0) {
    console.log("  No strategy evaluations yet. Market/risk events may not be enqueueing assets, or runtime just started.");
  } else if (intentsGenerated === 0) {
    console.log("  Strategy is running but every evaluation returns NOOP. Order intents are never emitted.");
    console.log("  Dominant reasons (see above) show why: fix market state (tradable/stale) or relax paper thresholds.");
    console.log("  Recommended: docs/NOOP_MARKET_TRADABILITY_ROOT_CAUSE.md §6 (allowQuoteOnlyForPaper).");
  } else {
    console.log("  Intents are being emitted (" + intentsGenerated + "). If ShadowCandidate is still 0, check guardrails/execution policy/status.");
  }

  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
