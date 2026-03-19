/**
 * Working orders breach audit (bounded, deterministic).
 *
 * Goal: explain why paper candidates are blocked by `working_orders_breach`.
 * Reads persisted state (ShadowCandidate + executedOrder) and the worker heartbeat.
 * Does not mutate runtime.
 *
 * Writes:
 * - dump/working-orders-breach-report.json
 * - dump/working-orders-breach-report.md
 *
 * npm run dump:working-orders-breach-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import {
  extractCanonicalWorkerRuntime,
  heartbeatIsFresh,
  parseHeartbeatMetadataJson,
} from "../lib/ops/worker-heartbeat-canonical";
import { DEFAULT_RUNTIME_RISK_LIMITS } from "../lib/runtime/risk/runtime-risk-engine";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";
const HEARTBEAT_FRESH_MS = Number(process.env.WORKING_ORDERS_BREACH_HEARTBEAT_FRESH_MS ?? "90000") || 90_000;

const CANDIDATES_LIMIT = Number(process.env.WORKING_ORDERS_BREACH_CANDIDATES_LIMIT ?? "20") || 20;
const CANDIDATES_WINDOW_MS =
  Number(process.env.WORKING_ORDERS_BREACH_CANDIDATES_WINDOW_MS ?? String(8 * 60 * 60 * 1000)) || 8 * 60 * 60 * 1000;
const CANDIDATES_FETCH_LIMIT = Math.max(50, CANDIDATES_LIMIT * 5);

const INVENTORY_LIMIT = Number(process.env.WORKING_ORDERS_BREACH_INVENTORY_LIMIT ?? "60") || 60;
const WORKING_STALE_MS = Number(process.env.WORKING_ORDERS_WORKING_STALE_MS ?? "120000") || 120_000;
const PENDING_SUBMIT_ACK_THRESHOLD_MS =
  Number(process.env.WORKING_ORDERS_PENDING_SUBMIT_ACK_THRESHOLD_MS ?? "30000") || 30_000;

type Verdict = "HEALTHY_AND_OPERATING" | "HEALTHY_BUT_IDLE" | "BOOTED_BUT_FROZEN" | "DEGRADED" | "BROKEN";

type RootCauseCategory =
  | "LEGITIMATE_WORKING_ORDER_CAP"
  | "STALE_WORKING_ORDER_STATE"
  | "DOUBLE_COUNTING"
  | "WRONG_DATA_SOURCE"
  | "PAPER_MODE_CONFIG_MISMATCH"
  | "READINESS_PERMISSION_MISMATCH"
  | "OTHER_BUG";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function excerpt(s: string | null | undefined, max = 240): string | null {
  if (s == null || s === "") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function toReasonArray(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return toReasonArray(parsed);
    } catch {
      return raw
        .split(/[;|,]/g)
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function parseBlockingReasonsJson(raw: unknown): string[] {
  return toReasonArray(raw).slice(0, 30);
}

function computeRuntimeVerdict(input: {
  runtimeStatus: string | null;
  lifecycleStatus: string | null;
  runtimeSafetyState: string | null;
  degradedReasons: string[];
  globalAutomationEnabled: boolean | null;
  automationPermitted: boolean | null;
  safeToAutomate: boolean | null;
  paperTradesOpenCount: number;
  candidateWorkingOrdersBreachedCount: number;
}): { verdict: Verdict; why: string[] } {
  const why: string[] = [];
  if (input.runtimeSafetyState && input.runtimeSafetyState !== "normal") {
    why.push(`runtimeSafety.state=${input.runtimeSafetyState}`);
    return { verdict: "DEGRADED", why };
  }
  if (input.runtimeStatus === "degraded" || input.lifecycleStatus === "degraded") {
    why.push("runtime status/lifecycle degraded");
    if (input.degradedReasons.length > 0) why.push(`degradedReasons=${input.degradedReasons.slice(0, 6).join(", ")}`);
    return { verdict: "DEGRADED", why };
  }
  if (input.candidateWorkingOrdersBreachedCount > 0 && input.paperTradesOpenCount === 0) {
    why.push("paper pipeline blocked by working_orders_breach while no PaperTrades are open");
    return { verdict: "DEGRADED", why };
  }
  if (input.paperTradesOpenCount === 0) {
    if (input.automationPermitted === false || input.safeToAutomate === false) {
      why.push("automation not permitted / safeToAutomate false");
      return { verdict: "BOOTED_BUT_FROZEN", why };
    }
    why.push("no open PaperTrades (pipeline idle)");
    return { verdict: "HEALTHY_BUT_IDLE", why };
  }
  why.push("paper trades appear to be flowing");
  return { verdict: "HEALTHY_AND_OPERATING", why };
}

function pickTitle(map: Map<string, string>, marketId: string | null | undefined): string | null {
  if (!marketId) return null;
  return map.get(marketId) ?? null;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const nowMs = Date.now();

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, status: true, metadataJson: true },
  });
  const dbOk = !!hb;
  const hbLastSeenAt = hb?.lastSeenAt ?? null;
  const hbFresh = hb ? heartbeatIsFresh(hb.lastSeenAt, nowMs, HEARTBEAT_FRESH_MS) : false;

  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? undefined);
  const runtimeHealth = asRecord(meta?.runtimeHealth) ?? null;
  const runtimeSafety = asRecord(meta?.runtimeSafety) ?? null;
  const canonical = extractCanonicalWorkerRuntime(meta);

  const runtimeStatus = runtimeHealth?.status && typeof runtimeHealth.status === "string" ? runtimeHealth.status : null;
  const lifecycleStatus = runtimeHealth?.lifecycleStatus && typeof runtimeHealth.lifecycleStatus === "string" ? runtimeHealth.lifecycleStatus : null;
  const runtimeMarkedReady = runtimeStatus === "ready" || lifecycleStatus === "ready";

  const globalAutomationEnabled =
    runtimeHealth?.globalAutomationEnabled && typeof runtimeHealth.globalAutomationEnabled === "boolean"
      ? runtimeHealth.globalAutomationEnabled
      : null;

  const operatorHealth = runtimeHealth?.operatorHealth ? asRecord(runtimeHealth.operatorHealth) : null;
  const readiness = operatorHealth?.readiness ? asRecord(operatorHealth.readiness) : null;
  const automationPermitted = readiness && typeof readiness.automationPermitted === "boolean" ? readiness.automationPermitted : null;
  const safeToAutomate = readiness && typeof readiness.safeToAutomate === "boolean" ? readiness.safeToAutomate : null;

  const runtimeSafetyState =
    runtimeSafety && runtimeSafety.state && typeof runtimeSafety.state === "string" ? runtimeSafety.state : null;

  const degradedReasons = Array.isArray(runtimeHealth?.degradedReasons)
    ? ((runtimeHealth.degradedReasons as unknown[]).filter((x) => typeof x === "string") as string[])
    : [];

  const runtimeMode = runtimeHealth?.runtimeMode && typeof runtimeHealth.runtimeMode === "string" ? runtimeHealth.runtimeMode : null;

  const openOrderCount =
    runtimeHealth?.counts && typeof runtimeHealth.counts === "object" && "openOrderCount" in (runtimeHealth.counts as any)
      ? Number((runtimeHealth.counts as any).openOrderCount ?? 0)
      : null;

  // Guardrail uses DEFAULT_RUNTIME_RISK_LIMITS unless explicitly overridden (stream-runtime currently does not override).
  const configuredMaxConcurrentWorkingOrders = DEFAULT_RUNTIME_RISK_LIMITS.maxConcurrentWorkingOrders;

  const paperTradesOpenCount = await prisma.paperTrade.count({ where: { status: "open" } });

  // ---- Recent blocked candidates (runtime_automated + working_orders_breach) ----
  const candidateWindowStart = new Date(nowMs - CANDIDATES_WINDOW_MS);
  const candidatesRaw = await prisma.shadowCandidate.findMany({
    where: {
      candidateSource: "runtime_automated",
      wasBlocked: true,
      createdAt: { gte: candidateWindowStart },
    },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES_FETCH_LIMIT,
    select: {
      id: true,
      funderAddress: true,
      recommendationId: true,
      orderIntentId: true,
      createdAt: true,
      candidateSource: true,
      assetId: true,
      marketId: true,
      side: true,
      intendedPrice: true,
      intendedSize: true,
      wasBlocked: true,
      wasSubmitted: true,
      blockingReasons: true,
    },
  });

  const candidatesParsed = candidatesRaw
    .map((c) => {
      const reasons = parseBlockingReasonsJson(c.blockingReasons);
      const hasWorkingBreach = reasons.includes("working_orders_breach");
      return { c, reasons, hasWorkingBreach };
    })
    .filter((x) => x.hasWorkingBreach);

  const recentBlockedCandidates = candidatesParsed
    .slice(0, CANDIDATES_LIMIT)
    .map((x) => x.c);

  const candidateWorkingOrdersBreachedCount = candidatesParsed.length;

  const inventoryFunderAddress = recentBlockedCandidates[0]?.funderAddress ?? null;

  // ---- Market title mapping (best effort) ----
  const marketIds = new Set<string>();
  for (const c of recentBlockedCandidates) {
    if (c.marketId) marketIds.add(c.marketId);
  }

  const markets = marketIds.size
    ? await prisma.syncedMarket.findMany({
        where: { id: { in: [...marketIds] } },
        select: { id: true, title: true },
      })
    : [];
  const marketTitleById = new Map(markets.map((m) => [m.id, m.title]));

  // ---- Working-order inventory snapshot (executedOrder.status='open') ----
  const openExecutedOrders = inventoryFunderAddress
    ? await prisma.executedOrder.findMany({
        where: { funderAddress: inventoryFunderAddress, status: "open", venue: "paper" },
        orderBy: { updatedAt: "desc" },
        take: INVENTORY_LIMIT,
        select: {
          id: true,
          polymarketOrderId: true,
          orderIntentId: true,
          marketId: true,
          assetId: true,
          side: true,
          price: true,
          size: true,
          originalSize: true,
          remainingSize: true,
          createdAt: true,
          updatedAt: true,
          venue: true,
          cancelRequests: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, status: true, reason: true, createdAt: true, updatedAt: true },
          },
        },
      })
    : [];

  const openExecutedOrdersCountTotal = inventoryFunderAddress
    ? await prisma.executedOrder.count({
        where: { funderAddress: inventoryFunderAddress, status: "open", venue: "paper" },
      })
    : 0;

  const openInventoryCount = openExecutedOrdersCountTotal;

  const oldestOpenUpdatedAt = openExecutedOrders.length ? openExecutedOrders[openExecutedOrders.length - 1]!.updatedAt : null;
  const oldestOpenUpdatedAtAgeMs = oldestOpenUpdatedAt ? nowMs - oldestOpenUpdatedAt.getTime() : null;

  const staleInventory = openExecutedOrders
    .map((o) => {
      const ageMs = nowMs - o.updatedAt.getTime();
      const createdAgeMs = nowMs - o.createdAt.getTime();
      const wouldBeWorkingTooOld = ageMs >= WORKING_STALE_MS;
      const wouldBePendingSubmitNoAck = createdAgeMs >= PENDING_SUBMIT_ACK_THRESHOLD_MS;
      return {
        order: o,
        ageMs,
        createdAgeMs,
        wouldBeWorkingTooOld,
        wouldBePendingSubmitNoAck,
        staleHeuristic: wouldBeWorkingTooOld ? "working_too_old" : wouldBePendingSubmitNoAck ? "pending_submit_no_ack" : null,
        staleSuspicious:
          runtimeMode === "paper" && (wouldBeWorkingTooOld || wouldBePendingSubmitNoAck) ? true : false,
      };
    })
    .sort((a, b) => b.ageMs - a.ageMs);

  const staleCount = staleInventory.filter((x) => x.staleSuspicious).length;

  // ---- Double-count / mismatch checks ----
  const workingOrderCountReported = openOrderCount != null ? openOrderCount : null;
  const mismatchWorkingVsInventory =
    workingOrderCountReported != null ? workingOrderCountReported - openInventoryCount : null;

  // ---- Root cause category ----
  let rootCauseCategory: RootCauseCategory = "OTHER_BUG";
  const hasStalePaperSignals =
    runtimeMode === "paper" &&
    (staleCount > 0 || (oldestOpenUpdatedAtAgeMs != null && oldestOpenUpdatedAtAgeMs >= WORKING_STALE_MS) || openExecutedOrdersCountTotal === 0);

  if (workingOrderCountReported != null && workingOrderCountReported >= configuredMaxConcurrentWorkingOrders) {
    if (hasStalePaperSignals) rootCauseCategory = "STALE_WORKING_ORDER_STATE";
    else rootCauseCategory = "LEGITIMATE_WORKING_ORDER_CAP";
  } else {
    if (hasStalePaperSignals) rootCauseCategory = "STALE_WORKING_ORDER_STATE";
    else rootCauseCategory = "OTHER_BUG";
  }

  // ---- Gate path attribution: latest blocked candidates ----
  const latestCandidates = recentBlockedCandidates.slice(0, Math.min(5, recentBlockedCandidates.length));

  // ---- Verdict ----
  const compute = computeRuntimeVerdict({
    runtimeStatus,
    lifecycleStatus,
    runtimeSafetyState,
    degradedReasons,
    globalAutomationEnabled,
    automationPermitted,
    safeToAutomate,
    paperTradesOpenCount,
    candidateWorkingOrdersBreachedCount,
  });

  const verdict = compute.verdict;
  const why = compute.why;

  // ---- Build candidate rows ----
  const candidatesReport = recentBlockedCandidates.map((cand) => {
    const reasons = parseBlockingReasonsJson(cand.blockingReasons);
    const hasWorkingBreach = reasons.includes("working_orders_breach");
    const marketTitle = pickTitle(marketTitleById, cand.marketId);
    return {
      id: cand.id,
      createdAt: cand.createdAt.toISOString(),
      market: { id: cand.marketId, title: marketTitle },
      candidateSource: cand.candidateSource,
      wasBlocked: cand.wasBlocked,
      wasSubmitted: cand.wasSubmitted ?? false,
      blockingReasons: reasons.slice(0, 10),
      workingOrdersBreachPresent: hasWorkingBreach,
      workingOrderCountObservedByGate: workingOrderCountReported,
      workingOrderLimitConfigured: configuredMaxConcurrentWorkingOrders,
    };
  });

  // ---- Working inventory rows ----
  const inventoryReport = staleInventory.slice(0, Math.min(INVENTORY_LIMIT, 40)).map((x) => {
    const o = x.order;
    const ageMs = x.ageMs;
    const createdAgeMs = x.createdAgeMs;
    const marketTitle = pickTitle(marketTitleById, o.marketId);
    const latestCancel = o.cancelRequests[0] ?? null;
    return {
      identifier: o.id,
      source: { venue: o.venue ?? null, orderId: o.polymarketOrderId ?? null, orderIntentId: o.orderIntentId ?? null },
      status: o.status,
      market: { id: o.marketId, title: marketTitle },
      assetId: o.assetId,
      side: o.side,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
      ageMsFromUpdatedAt: ageMs,
      staleHeuristic: x.staleHeuristic,
      appearsStaleOrSuspicious: x.staleSuspicious,
      whyStillCountedAsWorking: [
        `executedOrder.status='open' (paper)`,
        x.wouldBeWorkingTooOld ? `updatedAt is older than workingStaleMs=${WORKING_STALE_MS}` : null,
        x.wouldBePendingSubmitNoAck ? `createdAt is older than pendingSubmitAckThresholdMs=${PENDING_SUBMIT_ACK_THRESHOLD_MS}` : null,
        latestCancel ? `latestCancelRequest.status='${latestCancel.status}' (executedOrder still open)` : null,
      ].filter(Boolean),
    };
  });

  const report = {
    generatedAt,
    dbOk,
    heartbeat: {
      workerName: WORKER_NAME,
      lastSeenAt: hbLastSeenAt ? hbLastSeenAt.toISOString() : null,
      heartbeatFresh: hbFresh,
      workerHeartbeatStatus: hb?.status ?? null,
      canonicalRuntime: canonical,
    },
    runtimeSnapshot: {
      runtimeStatus,
      lifecycleStatus,
      runtimeMarkedReady,
      runtimeMode,
      globalAutomationEnabled,
      automationPermitted,
      safeToAutomate,
      runtimeSafetyState,
      degradedReasons,
      openOrderCountFromHeartbeat: openOrderCount,
      configuredMaxConcurrentWorkingOrders,
      workingOrderSourceSummary: {
        // In-memory orderStore statuses that count toward riskState.workingOrderCount:
        includedOrderStatusesInGate: ["pending_submit", "working", "partially_filled", "pending_cancel"],
        // The tool cannot observe in-memory stores directly; this is what the gate uses.
        gateCountsWorkingOrdersFrom: "StreamRuntime in-memory OrderLifecycleStore (orderStore.getAll() filtered by included statuses)",
        gateCountFreshnessApprox: {
          computedAsOf: hbLastSeenAt ? hbLastSeenAt.toISOString() : null,
          oldestOpenInventoryUpdatedAt: oldestOpenUpdatedAt ? oldestOpenUpdatedAt.toISOString() : null,
          oldestOpenInventoryUpdatedAtAgeMs: oldestOpenUpdatedAtAgeMs,
        },
        paperModeWorkingOrderLogic: "Same guardrails/risk engine path as live; difference is that paper mode can accumulate open executed orders if stale cancellation is not applied.",
      },
    },
    blockedCandidates: {
      windowMs: CANDIDATES_WINDOW_MS,
      limit: CANDIDATES_LIMIT,
      fetchedCandidates: candidatesRaw.length,
      totalMatchingWorkingBreachCandidatesInWindow: candidateWorkingOrdersBreachedCount,
      inventoryFunderAddress,
      items: candidatesReport,
    },
    workingOrderInventorySnapshot: {
      inventoryFunderAddress,
      openExecutedOrdersCount: openInventoryCount,
      workingOrderCountReportedFromHeartbeat: workingOrderCountReported,
      mismatchWorkingVsInventory: mismatchWorkingVsInventory,
      workingStaleMs: WORKING_STALE_MS,
      pendingSubmitAckThresholdMs: PENDING_SUBMIT_ACK_THRESHOLD_MS,
      items: inventoryReport,
    },
    gatePathAttribution: {
      producedBy: {
        module: "lib/runtime/risk/runtime-guardrails.ts",
        function: "DefaultRuntimeGuardrails.evaluate",
        reasonCode: "working_orders_breach",
        condition: "riskState.workingOrderCount >= limits.maxConcurrentWorkingOrders",
      },
      dataPath: [
        "StreamRuntime: updateRiskExposureFromStores() -> getExposureFromStores() counts orderStore.getAll() open statuses",
        "riskState.workingOrderCount is updated in-memory (no DB reads on hot path)",
        "Guardrails reads riskState.workingOrderCount and blocks new entries with GUARDRAIL_REASON_CODES.WORKING_ORDERS_BREACH",
      ],
      legitimacyAssessment: {
        expectedInPaperMode: "stale open working orders should be canceled by the stale order sweeper (paper mode) so the working-order count reflects active working intent",
        observedSignals: {
          runtimeMode,
          staleInventoryCount: staleCount,
          oldestOpenInventoryUpdatedAt: oldestOpenUpdatedAt ? oldestOpenUpdatedAt.toISOString() : null,
        },
        blockedCandidateLegitimacy: rootCauseCategory === "STALE_WORKING_ORDER_STATE" ? "likely false block (stale working state)" : "could be legitimate (working cap exceeded)",
      },
    },
    rootCause: {
      rootCauseCategory,
      explainWhy: [
        `heartbeat openOrderCount=${openOrderCount} vs configuredMaxConcurrentWorkingOrders=${configuredMaxConcurrentWorkingOrders}`,
        `inventory: openExecutedOrders=${openInventoryCount} (mismatchWorkingVsInventory=${mismatchWorkingVsInventory})`,
        runtimeMode === "paper" ? `paper stale heuristic matches ${staleCount} inventory items older than configured stale thresholds` : "runtimeMode is not paper; stale heuristic not prioritized",
        rootCauseCategory === "STALE_WORKING_ORDER_STATE"
          ? `DefaultOrderStaleSweeper should cancel stale orders in paper mode, but if it only sweeps without applying cancel, the in-memory working-order count can remain inflated and repeatedly trip working_orders_breach.`
          : `No clear stale-working-state signature; likely a genuine cap due to active working orders.`,
      ],
    },
    overallVerdict: {
      verdict,
      why,
      recommendedFixPlan:
        "In paper mode, ensure the stale order sweeper interval uses `sweepAndApply()` (not only `sweep()`), so stale working/pending orders are actually canceled and removed from the in-memory orderStore. Preserve fail-closed risk/guardrails behavior; do not relax limits.",
      filesChanged: ["worker/stream-runtime.ts"],
    },
  };

  const jsonPath = path.join(DUMP_DIR, "working-orders-breach-report.json");
  const mdPath = path.join(DUMP_DIR, "working-orders-breach-report.md");

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");

  // ---- Markdown summary (bounded, readable) ----
  const md: string[] = [];
  md.push(`# Working Orders Breach Report`);
  md.push(`Generated at: ${generatedAt}`);
  md.push(``);
  md.push(`## 1) Runtime / permission snapshot`);
  md.push(`- runtimeStatus: **${runtimeStatus ?? "—"}** · lifecycleStatus: **${lifecycleStatus ?? "—"}**`);
  md.push(`- runtimeMarkedReady: **${runtimeMarkedReady}** · runtimeMode: **${runtimeMode ?? "—"}**`);
  md.push(`- globalAutomationEnabled: **${globalAutomationEnabled ?? "—"}**`);
  md.push(`- automationPermitted: **${automationPermitted ?? "—"}** · safeToAutomate: **${safeToAutomate ?? "—"}**`);
  md.push(`- runtimeSafetyState: **${runtimeSafetyState ?? "—"}**`);
  md.push(`- current degraded reasons: ${degradedReasons.length ? degradedReasons.slice(0, 8).join(", ") : "(none)"}`);
  md.push(`- heartbeatFresh: **${hbFresh}** · lastSeenAt: **${hbLastSeenAt ? hbLastSeenAt.toISOString() : "—"}**`);
  md.push(``);
  md.push(`## 2) Working-order state used by admission / gating`);
  md.push(`- gate working-order count (heartbeat openOrderCount): **${openOrderCount ?? "—"}**`);
  md.push(`- configured working-order limit (maxConcurrentWorkingOrders): **${configuredMaxConcurrentWorkingOrders}**`);
  md.push(`- included order statuses in gate: \`${["pending_submit", "working", "partially_filled", "pending_cancel"].join(", ")}\``);
  md.push(`- oldest open inventory updatedAt (executedOrder.status='open'): **${oldestOpenUpdatedAt ? oldestOpenUpdatedAt.toISOString() : "—"}**`);
  md.push(`- paper mode working-order logic: **${"Same guardrails/risk engine path; difference is stale cancellation behavior."}**`);
  md.push(``);
  md.push(`## 3) Recent blocked candidates (runtime_automated; working_orders_breach)`);
  md.push(
    `- candidates window: last ${(CANDIDATES_WINDOW_MS / (60 * 60 * 1000)).toFixed(1)}h · limit: ${CANDIDATES_LIMIT} · matched: ${candidateWorkingOrdersBreachedCount}`
  );
  if (candidatesReport.length === 0) {
    md.push(`- (none found)`);
  } else {
    md.push(`| createdAt | market | blockingReasons | working_orders_breach? | observed working/limit |`);
    md.push(`|---|---|---|---|---|`);
    for (const r of candidatesReport) {
      md.push(
        `| ${r.createdAt} | ${r.market.title ? `${r.market.title} (${r.market.id})` : r.market.id ?? "—"} | ${excerpt(r.blockingReasons.join("; "), 120) ?? "—"} | ${r.workingOrdersBreachPresent} | ${r.workingOrderCountObservedByGate ?? "—"}/${r.workingOrderLimitConfigured} |`
      );
    }
  }
  md.push(``);
  md.push(`## 4) Working-order inventory snapshot (executedOrder.status='open', paper venue)`);
  md.push(`- inventoryFunderAddress: **${inventoryFunderAddress ?? "—"}** · openExecutedOrders=${openInventoryCount}`);
  md.push(`- mismatchWorkingVsInventory: **${mismatchWorkingVsInventory ?? "—"}** (heartbeat openOrderCount - inventory openExecutedOrders)`);
  md.push(`- stale heuristics: workingStaleMs=${WORKING_STALE_MS} · pendingSubmitAckThresholdMs=${PENDING_SUBMIT_ACK_THRESHOLD_MS}`);
  md.push(`- staleInventoryCount=${staleCount}`);
  if (inventoryReport.length === 0) {
    md.push(`- (no open paper executed orders found for inventoryFunderAddress)`);
  } else {
    md.push(`| updatedAt | ageMs | market | side | status | stale? | whyStillCountedAsWorking |`);
    md.push(`|---|---:|---|---|---|---|---|`);
    for (const it of inventoryReport.slice(0, 25)) {
      md.push(
        `| ${it.updatedAt} | ${Math.round(it.ageMsFromUpdatedAt / 1000)}s | ${it.market.title ? `${it.market.title} (${it.market.id})` : it.market.id} | ${it.side} | ${it.status} | ${it.appearsStaleOrSuspicious} | ${excerpt(it.whyStillCountedAsWorking.join("; "), 140) ?? "—"} |`
      );
    }
  }
  md.push(``);
  md.push(`## 5) Gate path attribution`);
  md.push(`- produced by: \`${"lib/runtime/risk/runtime-guardrails.ts"}\` :: \`${"DefaultRuntimeGuardrails.evaluate"}\``);
  md.push(`- condition: \`riskState.workingOrderCount >= limits.maxConcurrentWorkingOrders\``);
  md.push(`- data path: orderStore open statuses -> updateRiskExposureFromStores/getExposureFromStores -> riskState.workingOrderCount -> guardrails block`);
  md.push(``);
  md.push(`## 6) Root cause & fix summary`);
  md.push(`- rootCauseCategory: **${rootCauseCategory}**`);
  for (const x of report.rootCause.explainWhy.slice(0, 6)) {
    md.push(`- ${x}`);
  }
  md.push(``);
  md.push(`## 7) Overall verdict`);
  md.push(`- verdict: **${verdict}**`);
  for (const x of why.slice(0, 6)) md.push(`- ${x}`);
  md.push(``);
  md.push(`### Recommended minimal safe fix`);
  md.push(`- ${report.overallVerdict.recommendedFixPlan}`);
  md.push(``);

  await fs.writeFile(mdPath, md.join("\n"), "utf-8");

  // Console output (useful when running inside docker exec).
  // Keep it short and deterministic.
  console.log(
    JSON.stringify(
      {
        verdict,
        rootCauseCategory,
        runtimeStatus,
        lifecycleStatus,
        openOrderCountFromHeartbeat: openOrderCount,
        configuredMaxConcurrentWorkingOrders,
        candidateWorkingOrdersBreachedCount,
        paperTradesOpenCount,
        staleInventoryCount: staleCount,
      },
      null,
      2
    )
  );
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("working-orders-breach-report failed", err);
  process.exit(1);
});

