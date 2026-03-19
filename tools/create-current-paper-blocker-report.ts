/**
 * Short-window current blocker attribution for paper admission.
 *
 * Writes:
 * - dump/current-paper-blocker-report.json
 * - dump/current-paper-blocker-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { parseHeartbeatMetadataJson } from "../lib/ops/worker-heartbeat-canonical";
import { DEFAULT_RUNTIME_RISK_LIMITS } from "../lib/runtime/risk/runtime-risk-engine";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";
const RECENT_LIMIT = Number(process.env.CURRENT_BLOCKER_RECENT_LIMIT ?? "1200") || 1200;

type RootCause =
  | "LEGITIMATE_RUNTIME_SAFETY_BLOCK"
  | "LEGITIMATE_CONCENTRATION_BLOCK"
  | "LEGITIMATE_WORKING_ORDER_BLOCK"
  | "LEGITIMATE_TRUTH_FRESHNESS_BLOCK"
  | "STALE_OR_FALSE_BLOCK_SIGNAL"
  | "READINESS_ACCOUNTING_BUG"
  | "PAPER_MODE_CONFIG_MISMATCH"
  | "OTHER_BUG";

function since(msAgo: number): Date {
  return new Date(Date.now() - msAgo);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pickBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function toReasons(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .flatMap((x) => (typeof x === "string" ? x.split(/[;,|]/g) : []))
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") return raw.split(/[;,|]/g).map((x) => x.trim()).filter(Boolean);
  return [];
}

function normalizeReason(reason: string): string {
  if (reason.startsWith("exposure:")) return reason.slice("exposure:".length);
  return reason;
}

function reasonCategory(reason: string): "runtime_safety" | "concentration" | "working_orders" | "truth_freshness" | "other" {
  const r = normalizeReason(reason);
  if (r.includes("runtime_safety_blocked") || r.includes("kill_switch") || r.includes("operational:")) return "runtime_safety";
  if (r.includes("single_market_concentration_breach") || r.includes("single_theme_concentration_breach")) return "concentration";
  if (r.includes("working_orders_breach")) return "working_orders";
  if (r.includes("exchange_truth_stale") || r.includes("market_data_stale") || r.includes("user_data_stale")) return "truth_freshness";
  return "other";
}

function windowFunnel(rows: Array<{ createdAt: Date; wasBlocked: boolean; wasSubmitted: boolean }>, windowMs: number) {
  const cutoff = since(windowMs).getTime();
  const inWin = rows.filter((r) => r.createdAt.getTime() >= cutoff);
  return {
    windowLabel: windowMs === 5 * 60 * 1000 ? "5m" : windowMs === 10 * 60 * 1000 ? "10m" : "30m",
    runtimeAutomatedCreated: inWin.length,
    blocked: inWin.filter((r) => r.wasBlocked).length,
    submitted: inWin.filter((r) => r.wasSubmitted).length,
  };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  // Runtime snapshot
  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });
  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? undefined);
  const rh = asRecord(meta?.runtimeHealth) ?? null;
  const rs = asRecord(meta?.runtimeSafety) ?? null;
  const readiness = asRecord(asRecord(rh?.operatorHealth)?.readiness) ?? null;
  const streams = asRecord(rh?.streams) ?? null;
  const metadata = asRecord(rh?.metadata) ?? null;
  const counts = asRecord(rh?.counts) ?? null;

  const runtimeStatus = typeof rh?.status === "string" ? rh.status : null;
  const lifecycleStatus = typeof rh?.lifecycleStatus === "string" ? rh.lifecycleStatus : null;
  const runtimeMarkedReady = runtimeStatus === "ready" || lifecycleStatus === "ready";
  const globalAutomationEnabled = pickBool(rh?.globalAutomationEnabled);
  const automationPermitted = pickBool(readiness?.automationPermitted);
  const safeToAutomate = pickBool(readiness?.safeToAutomate);
  const runtimeSafetyState = typeof rs?.state === "string" ? rs.state : null;
  const degradedReasons = Array.isArray(rh?.degradedReasons) ? (rh!.degradedReasons as string[]) : [];
  const operatingMode = typeof rh?.operatingMode === "string" ? (rh!.operatingMode as string) : null;

  // Short-window candidate sample (bounded)
  const oldest = since(30 * 60 * 1000);
  const candidates = await prisma.shadowCandidate.findMany({
    where: {
      candidateSource: "runtime_automated",
      createdAt: { gte: oldest },
    },
    orderBy: { createdAt: "desc" },
    take: RECENT_LIMIT,
    select: {
      id: true,
      createdAt: true,
      wasBlocked: true,
      wasSubmitted: true,
      blockingReasons: true,
      executionPolicySnapshotJson: true,
      marketId: true,
    },
  });

  const [paperOpen5m, paperOpen10m, paperOpen30m] = await Promise.all([
    prisma.paperTrade.count({ where: { createdAt: { gte: since(5 * 60 * 1000) } } }),
    prisma.paperTrade.count({ where: { createdAt: { gte: since(10 * 60 * 1000) } } }),
    prisma.paperTrade.count({ where: { createdAt: { gte: since(30 * 60 * 1000) } } }),
  ]);

  const funnel5 = { ...windowFunnel(candidates, 5 * 60 * 1000), paperTradesOpened: paperOpen5m };
  const funnel10 = { ...windowFunnel(candidates, 10 * 60 * 1000), paperTradesOpened: paperOpen10m };
  const funnel30 = { ...windowFunnel(candidates, 30 * 60 * 1000), paperTradesOpened: paperOpen30m };

  const blocked5 = candidates.filter((c) => c.wasBlocked && c.createdAt >= since(5 * 60 * 1000));
  const blocked10 = candidates.filter((c) => c.wasBlocked && c.createdAt >= since(10 * 60 * 1000));
  const blocked30 = candidates.filter((c) => c.wasBlocked);
  const activeBlocked = blocked5.length > 0 ? blocked5 : blocked10.length > 0 ? blocked10 : blocked30;
  const activeWindowLabel = blocked5.length > 0 ? "5m" : blocked10.length > 0 ? "10m" : "30m";

  const reasonCounts = new Map<string, number>();
  const comboCounts = new Map<string, number>();
  for (const c of activeBlocked) {
    const reasons = toReasons(c.blockingReasons).map(normalizeReason);
    for (const r of reasons) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
    const combo = reasons.slice().sort().join(" + ") || "(none)";
    comboCounts.set(combo, (comboCounts.get(combo) ?? 0) + 1);
  }

  const totalBlocked = activeBlocked.length;
  const sortedReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({
      reason,
      count,
      pct: totalBlocked > 0 ? Math.round((count / totalBlocked) * 10000) / 100 : 0,
      category: reasonCategory(reason),
    }));
  const sortedCombos = [...comboCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([combo, count]) => ({
      combo,
      count,
      pct: totalBlocked > 0 ? Math.round((count / totalBlocked) * 10000) / 100 : 0,
    }));

  const dominant = sortedReasons[0] ?? null;
  const runnerUp = sortedReasons[1] ?? null;

  // Gate attribution map (deterministic static mapping)
  const gateForDominant = (() => {
    if (!dominant) return null;
    const r = dominant.reason;
    const cat = reasonCategory(r);
    if (cat === "runtime_safety") {
      return {
        stage: "runtime guardrails",
        module: "lib/runtime/risk/runtime-guardrails.ts",
        function: "DefaultRuntimeGuardrails.evaluate",
        inputState: "runtimeSafety.state + runtime phase/readiness + kill-switch",
      };
    }
    if (cat === "concentration") {
      return {
        stage: "execution policy",
        module: "lib/execution-policy/evaluate.ts",
        function: "evaluateExecutionPolicy / checkExposure",
        inputState: "portfolio-risk concentration metrics vs configured concentration limits",
      };
    }
    if (cat === "working_orders") {
      return {
        stage: "runtime guardrails",
        module: "lib/runtime/risk/runtime-guardrails.ts",
        function: "DefaultRuntimeGuardrails.evaluate",
        inputState: "riskState.workingOrderCount >= limits.maxConcurrentWorkingOrders",
      };
    }
    if (cat === "truth_freshness") {
      return {
        stage: "runtime degraded/truth model + guardrails",
        module: "lib/runtime/runtime-degraded.ts + lib/runtime/risk/runtime-guardrails.ts",
        function: "computeDegraded + DefaultRuntimeGuardrails.evaluate",
        inputState: "exchange/user/market freshness timestamps and truth snapshot staleness",
      };
    }
    return {
      stage: "other policy/guardrail",
      module: "worker/stream-runtime.ts",
      function: "order.intent.created handler block path",
      inputState: "candidate-level block reason propagation",
    };
  })();

  // Supporting state (only dominant category)
  let supportingState: Record<string, unknown> = {};
  let rootCause: RootCause = "OTHER_BUG";
  if (dominant) {
    const cat = reasonCategory(dominant.reason);
    if (cat === "runtime_safety") {
      supportingState = {
        readiness: { runtimeMarkedReady, automationPermitted, safeToAutomate, operatingMode },
        runtimeSafetyState,
        degradedReasons,
      };
      rootCause = "LEGITIMATE_RUNTIME_SAFETY_BLOCK";
    } else if (cat === "concentration") {
      let sampleConcentration: Record<string, unknown> | null = null;
      const withSnapshot = activeBlocked.find((c) => {
        const rs = toReasons(c.blockingReasons).map(normalizeReason);
        return rs.includes("single_market_concentration_breach") || rs.includes("single_theme_concentration_breach");
      });
      if (withSnapshot?.executionPolicySnapshotJson) {
        const snap = asRecord(JSON.parse(withSnapshot.executionPolicySnapshotJson));
        const checks = asRecord(snap?.checks);
        const exposure = asRecord(checks?.exposure);
        sampleConcentration = {
          singleMarketConcentrationVsLimit: exposure?.singleMarketConcentrationVsLimit ?? null,
          singleThemeConcentrationVsLimit: exposure?.singleThemeConcentrationVsLimit ?? null,
          blockReason: exposure?.blockReason ?? null,
        };
      }
      supportingState = {
        sampleExecutionPolicyConcentration: sampleConcentration,
        note: "Concentration breaches are produced in execution-policy exposure checks.",
      };
      rootCause = "LEGITIMATE_CONCENTRATION_BLOCK";
    } else if (cat === "working_orders") {
      supportingState = {
        currentOpenOrderCount: typeof counts?.openOrderCount === "number" ? counts.openOrderCount : null,
        maxConcurrentWorkingOrders: DEFAULT_RUNTIME_RISK_LIMITS.maxConcurrentWorkingOrders,
      };
      rootCause = "LEGITIMATE_WORKING_ORDER_BLOCK";
    } else if (cat === "truth_freshness") {
      supportingState = {
        marketLastDataEventAt: streams?.marketLastDataEventAt ?? null,
        userLastDataEventAt: streams?.userLastDataEventAt ?? null,
        lastExchangeOrdersSnapshotAt: metadata?.lastExchangeOrdersSnapshotAt ?? null,
        lastExchangeFillsSnapshotAt: metadata?.lastExchangeFillsSnapshotAt ?? null,
        degradedReasons,
      };
      rootCause = "LEGITIMATE_TRUTH_FRESHNESS_BLOCK";
    } else {
      rootCause = "OTHER_BUG";
    }
  }

  // False-signal classifier
  if (dominant && reasonCategory(dominant.reason) === "runtime_safety") {
    if (runtimeMarkedReady && automationPermitted === true && safeToAutomate === true && (degradedReasons.length === 0)) {
      rootCause = "STALE_OR_FALSE_BLOCK_SIGNAL";
    }
  }
  if (!dominant && runtimeMarkedReady && safeToAutomate === true) rootCause = "OTHER_BUG";

  const nextTarget = (() => {
    switch (rootCause) {
      case "LEGITIMATE_RUNTIME_SAFETY_BLOCK":
        return "runtime freshness + safety inputs (exchange/user truth + degraded reasons)";
      case "LEGITIMATE_CONCENTRATION_BLOCK":
        return "portfolio concentration / exposure policy calibration";
      case "LEGITIMATE_WORKING_ORDER_BLOCK":
        return "working-order lifecycle + stale-order clearing";
      case "LEGITIMATE_TRUTH_FRESHNESS_BLOCK":
        return "truth snapshot freshness + reconciliation cadence";
      case "STALE_OR_FALSE_BLOCK_SIGNAL":
      case "READINESS_ACCOUNTING_BUG":
        return "readiness/signal accounting consistency";
      default:
        return "dominant blocker re-sample with narrower 2-3 minute window";
    }
  })();

  const report = {
    generatedAt,
    currentRuntimeSnapshot: {
      runtimeStatus,
      lifecycleStatus,
      runtimeMarkedReady,
      globalAutomationEnabled,
      automationPermitted,
      safeToAutomate,
      runtimeSafetyState,
      degradedReasons,
      operatingMode,
    },
    shortWindowAdmissionFunnel: [funnel5, funnel10, funnel30],
    currentBlockerDistribution: {
      sampledWindow: activeWindowLabel,
      totalBlockedInSample: totalBlocked,
      reasonDistribution: sortedReasons.slice(0, 12),
      topBlockerCombinations: sortedCombos,
      dominantBlocker: dominant,
      runnerUp,
    },
    gatePathAttribution: {
      dominantBlocker: dominant?.reason ?? null,
      attribution: gateForDominant,
      driverType: dominant ? reasonCategory(dominant.reason) : null,
      legitimacy:
        rootCause === "STALE_OR_FALSE_BLOCK_SIGNAL" || rootCause === "READINESS_ACCOUNTING_BUG"
          ? "suspicious_or_buggy"
          : "appears_legitimate",
    },
    supportingStateForDominant: supportingState,
    rootCauseClassification: {
      rootCause,
      why:
        dominant == null
          ? "No blocked candidates in short window sample."
          : `Dominant blocker '${dominant.reason}' is ${Math.round((dominant.pct ?? 0) * 100) / 100}% of blocked candidates in ${activeWindowLabel}.`,
    },
    recommendedNextTarget: nextTarget,
    filesChanged: ["tools/create-current-paper-blocker-report.ts", "package.json"],
  };

  const md: string[] = [];
  md.push("# Current Paper Blocker Report");
  md.push(`Generated at: ${generatedAt}`);
  md.push("");
  md.push("## 1) Current runtime snapshot");
  md.push(`- runtimeStatus: **${runtimeStatus ?? "—"}** · lifecycleStatus: **${lifecycleStatus ?? "—"}**`);
  md.push(`- runtimeMarkedReady: **${runtimeMarkedReady}**`);
  md.push(`- globalAutomationEnabled: **${globalAutomationEnabled ?? "—"}**`);
  md.push(`- automationPermitted: **${automationPermitted ?? "—"}** · safeToAutomate: **${safeToAutomate ?? "—"}**`);
  md.push(`- runtimeSafetyState: **${runtimeSafetyState ?? "—"}**`);
  md.push(`- degradedReasons: ${degradedReasons.join(", ") || "(none)"}`);
  md.push(`- operatingMode: **${operatingMode ?? "—"}**`);
  md.push("");
  md.push("## 2) Current admission funnel (short windows)");
  md.push("| window | runtime_automated created | blocked | submitted | paper trades opened |");
  md.push("|---|---:|---:|---:|---:|");
  for (const f of [funnel5, funnel10, funnel30]) {
    md.push(`| ${f.windowLabel} | ${f.runtimeAutomatedCreated} | ${f.blocked} | ${f.submitted} | ${f.paperTradesOpened} |`);
  }
  md.push("");
  md.push("## 3) Current blocker distribution");
  md.push(`- sampled window: **${activeWindowLabel}** · blocked sample size: **${totalBlocked}**`);
  if (sortedReasons.length === 0) {
    md.push("- no blocked candidates in sample");
  } else {
    md.push("| blocker reason | count | share % |");
    md.push("|---|---:|---:|");
    for (const r of sortedReasons.slice(0, 10)) {
      md.push(`| ${r.reason} | ${r.count} | ${r.pct} |`);
    }
  }
  md.push("- top blocker combinations:");
  for (const c of sortedCombos.slice(0, 6)) md.push(`  - ${c.combo}: ${c.count} (${c.pct}%)`);
  md.push(`- dominant blocker: **${dominant?.reason ?? "(none)"}**`);
  md.push(`- runner-up: **${runnerUp?.reason ?? "(none)"}**`);
  md.push("");
  md.push("## 4) Gate path attribution");
  if (gateForDominant) {
    md.push(`- stage: ${gateForDominant.stage}`);
    md.push(`- module/function: ${gateForDominant.module} :: ${gateForDominant.function}`);
    md.push(`- input state: ${gateForDominant.inputState}`);
    md.push(`- legitimacy: ${report.gatePathAttribution.legitimacy}`);
  } else {
    md.push("- no dominant blocker attribution available");
  }
  md.push("");
  md.push("## 5) Supporting state for dominant blocker");
  md.push("```json");
  md.push(JSON.stringify(supportingState, null, 2));
  md.push("```");
  md.push("");
  md.push("## 6) Root cause classification");
  md.push(`- **${rootCause}**`);
  md.push(`- ${report.rootCauseClassification.why}`);
  md.push("");
  md.push("## 7) Recommended next target");
  md.push(`- ${nextTarget}`);

  await fs.writeFile(path.join(DUMP_DIR, "current-paper-blocker-report.json"), JSON.stringify(report, null, 2), "utf-8");
  await fs.writeFile(path.join(DUMP_DIR, "current-paper-blocker-report.md"), md.join("\n"), "utf-8");

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        dominantBlocker: dominant?.reason ?? null,
        dominantSharePct: dominant?.pct ?? null,
        runnerUp: runnerUp?.reason ?? null,
        sampledWindow: activeWindowLabel,
        rootCause,
      },
      null,
      2
    )
  );
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("create-current-paper-blocker-report failed", err);
  process.exit(1);
});

