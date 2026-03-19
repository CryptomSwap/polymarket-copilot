/**
 * End-to-end paper admission report (bounded, deterministic).
 *
 * Writes:
 * - dump/paper-admission-report.json
 * - dump/paper-admission-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { parseHeartbeatMetadataJson } from "../lib/ops/worker-heartbeat-canonical";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";
const CANDIDATE_RECENT_LIMIT = Number(process.env.PAPER_ADMISSION_RECENT_LIMIT ?? "20") || 20;

type Verdict = "HEALTHY_AND_OPERATING" | "HEALTHY_BUT_IDLE" | "BOOTED_BUT_FROZEN" | "DEGRADED" | "BROKEN";
type RootCauseCategory =
  | "HEALTHY_AND_OPERATING"
  | "HEALTHY_BUT_IDLE"
  | "LEGITIMATE_POLICY_BLOCK"
  | "PAPER_SUBMISSION_PATH_BROKEN"
  | "STALE_OR_INCORRECT_BLOCK_REASON"
  | "PAPER_MODE_CONFIG_MISMATCH"
  | "OTHER_BUG";

function since(msAgo: number): Date {
  return new Date(Date.now() - msAgo);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toReasonArray(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw === "string") return raw.split(/[;,|]/g).map((s) => s.trim()).filter(Boolean);
  return [];
}

function pickBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function pickVerdict(input: {
  runtimeStatus: string | null;
  lifecycleStatus: string | null;
  runtimeSafetyState: string | null;
  automationPermitted: boolean | null;
  safeToAutomate: boolean | null;
  degradedReasons: string[];
}): Verdict {
  if (input.runtimeSafetyState != null && input.runtimeSafetyState !== "normal") return "DEGRADED";
  if (input.runtimeStatus === "degraded" || input.lifecycleStatus === "degraded") return "DEGRADED";
  if (input.automationPermitted === false || input.safeToAutomate === false) return "BOOTED_BUT_FROZEN";
  if (input.runtimeStatus === "ready" && input.lifecycleStatus === "ready") {
    return input.degradedReasons.length === 0 ? "HEALTHY_AND_OPERATING" : "DEGRADED";
  }
  return "BROKEN";
}

async function windowFunnel(windowMs: number): Promise<{
  windowLabel: string;
  runtimeAutomatedCreated: number;
  runtimeAutomatedBlocked: number;
  runtimeAutomatedSubmitted: number;
  paperTradesOpened: number;
  paperTradesOpenNow: number;
  paperTradesClosedInWindow: number;
}> {
  const gte = since(windowMs);
  // Keep this sequential to avoid DB-pool pressure in constrained worker containers.
  const created = await prisma.shadowCandidate.count({
    where: { candidateSource: "runtime_automated", createdAt: { gte } },
  });
  const blocked = await prisma.shadowCandidate.count({
    where: { candidateSource: "runtime_automated", createdAt: { gte }, wasBlocked: true },
  });
  const submitted = await prisma.shadowCandidate.count({
    where: { candidateSource: "runtime_automated", createdAt: { gte }, wasSubmitted: true },
  });
  const paperOpened = await prisma.paperTrade.count({
    where: { createdAt: { gte } },
  });
  const paperOpenNow = await prisma.paperTrade.count({
    where: { status: "open", createdAt: { gte } },
  });
  const paperClosed = await prisma.paperTrade.count({
    where: { status: "closed", exitTime: { gte } },
  });
  const label = windowMs === 30 * 60 * 1000 ? "30m" : windowMs === 2 * 60 * 60 * 1000 ? "2h" : "24h";
  return {
    windowLabel: label,
    runtimeAutomatedCreated: created,
    runtimeAutomatedBlocked: blocked,
    runtimeAutomatedSubmitted: submitted,
    paperTradesOpened: paperOpened,
    paperTradesOpenNow: paperOpenNow,
    paperTradesClosedInWindow: paperClosed,
  };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });
  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? undefined);
  const runtimeHealth = asRecord(meta?.runtimeHealth) ?? null;
  const runtimeSafety = asRecord(meta?.runtimeSafety) ?? null;

  const runtimeStatus = typeof runtimeHealth?.status === "string" ? runtimeHealth.status : null;
  const lifecycleStatus = typeof runtimeHealth?.lifecycleStatus === "string" ? runtimeHealth.lifecycleStatus : null;
  const runtimeMarkedReady = runtimeStatus === "ready" || lifecycleStatus === "ready";
  const globalAutomationEnabled = pickBool(runtimeHealth?.globalAutomationEnabled);
  const degradedReasons = Array.isArray(runtimeHealth?.degradedReasons) ? (runtimeHealth!.degradedReasons as string[]) : [];
  const operatingMode = typeof runtimeHealth?.operatingMode === "string" ? (runtimeHealth!.operatingMode as string) : null;
  const runtimeSafetyState = typeof runtimeSafety?.state === "string" ? (runtimeSafety!.state as string) : null;
  const readiness = asRecord(asRecord(runtimeHealth?.operatorHealth)?.readiness);
  const automationPermitted = pickBool(readiness?.automationPermitted);
  const safeToAutomate = pickBool(readiness?.safeToAutomate);

  const verdict = pickVerdict({
    runtimeStatus,
    lifecycleStatus,
    runtimeSafetyState,
    automationPermitted,
    safeToAutomate,
    degradedReasons,
  });

  // admission funnel windows
  const w30m = await windowFunnel(30 * 60 * 1000);
  const w2h = await windowFunnel(2 * 60 * 60 * 1000);
  const w24h = await windowFunnel(24 * 60 * 60 * 1000);

  const recentCandidatesRaw = await prisma.shadowCandidate.findMany({
    where: { candidateSource: "runtime_automated" },
    orderBy: { createdAt: "desc" },
    take: CANDIDATE_RECENT_LIMIT,
    select: {
      id: true,
      createdAt: true,
      recommendationId: true,
      orderIntentId: true,
      marketId: true,
      assetId: true,
      side: true,
      candidateSource: true,
      wasBlocked: true,
      wasSubmitted: true,
      blockingReasons: true,
    },
  });

  const recIds = Array.from(
    new Set(
      recentCandidatesRaw.map((c) => c.recommendationId).filter((x): x is string => !!x)
    )
  );
  const recRows = recIds.length
    ? await prisma.recommendation.findMany({
        where: { id: { in: recIds } },
        select: { id: true, marketSignal: { select: { marketTitle: true, marketId: true } } },
      })
    : [];
  const recMap = new Map(recRows.map((r) => [r.id, r.marketSignal]));

  const intentIds = Array.from(
    new Set(recentCandidatesRaw.map((c) => c.orderIntentId).filter((x): x is string => !!x))
  );
  const execRows = intentIds.length
    ? await prisma.executedOrder.findMany({
        where: { orderIntentId: { in: intentIds } },
        select: {
          id: true,
          orderIntentId: true,
          createdAt: true,
          updatedAt: true,
          venue: true,
          status: true,
          venueOrderId: true,
        },
      })
    : [];
  const execByIntent = new Map<string, typeof execRows[number][]>();
  for (const e of execRows) {
    if (!e.orderIntentId) continue;
    const arr = execByIntent.get(e.orderIntentId) ?? [];
    arr.push(e);
    execByIntent.set(e.orderIntentId, arr);
  }

  const recentCandidates = recentCandidatesRaw.map((c) => {
    const reasons = toReasonArray(c.blockingReasons).slice(0, 8);
    const market = c.recommendationId ? recMap.get(c.recommendationId) : null;
    const exec = c.orderIntentId ? execByIntent.get(c.orderIntentId) ?? [] : [];
    const reachedSubmission = c.wasSubmitted === true;
    const gateStage = c.wasBlocked
      ? reasons.some((r) => r.startsWith("exposure:") || r.startsWith("execution_quality:"))
        ? "execution_policy:evaluateExecutionPolicy"
        : "runtime_guardrails:DefaultRuntimeGuardrails.evaluate"
      : "runtime_admitted:orderManager.reconcileIntents";
    return {
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      marketId: c.marketId,
      marketTitle: market?.marketTitle ?? null,
      candidateSource: c.candidateSource,
      wasBlocked: c.wasBlocked,
      wasSubmitted: c.wasSubmitted,
      conciseBlockingReasons: reasons,
      reachedSubmission,
      orderIntentId: c.orderIntentId,
      executedOrders: exec.map((e) => ({
        id: e.id,
        venue: e.venue ?? null,
        status: e.status,
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
        venueOrderId: e.venueOrderId ?? null,
      })),
      paperTradeTraceable: false,
      paperTradeTraceNote:
        "runtime_automated candidate path persists to order-intent/executed-order; PaperTrade rows are created by paper_trading_tick pipeline.",
      gatePathAttribution: gateStage,
    };
  });

  const latestSubmitted = recentCandidates.find((c) => c.wasSubmitted === true) ?? null;
  const latestBlocked = recentCandidates.find((c) => c.wasBlocked === true) ?? null;

  const recentPaperTrades = await prisma.paperTrade.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      createdAt: true,
      entryTime: true,
      exitTime: true,
      status: true,
      marketId: true,
      assetId: true,
      side: true,
      modelRunId: true,
      metadataJson: true,
    },
  });

  const recentPaperTradesView = recentPaperTrades.map((t) => {
    const md = t.metadataJson ? asRecord(JSON.parse(t.metadataJson)) : null;
    return {
      id: t.id,
      createdAt: t.createdAt.toISOString(),
      openedAt: t.entryTime.toISOString(),
      closedAt: t.exitTime?.toISOString() ?? null,
      status: t.status,
      marketId: t.marketId,
      assetId: t.assetId,
      side: t.side,
      modelRunId: t.modelRunId,
      recommendationId: typeof md?.recommendationId === "string" ? (md.recommendationId as string) : null,
      sourceHint: "paper_trading_tick",
    };
  });

  const latestPaperTrade = recentPaperTradesView[0] ?? null;

  // Root cause classification (bounded, deterministic)
  let rootCauseCategory: RootCauseCategory = "OTHER_BUG";
  const rootCauseWhy: string[] = [];
  if (verdict === "DEGRADED" || verdict === "BOOTED_BUT_FROZEN") {
    const latestReasons = recentCandidatesRaw.length
      ? toReasonArray(recentCandidatesRaw[0]?.blockingReasons).slice(0, 6)
      : [];
    rootCauseCategory = latestReasons.length > 0 ? "LEGITIMATE_POLICY_BLOCK" : "OTHER_BUG";
    if (latestReasons.length > 0) {
      rootCauseWhy.push(
        `runtime not fully ready; current blocked candidates show active gate reasons: ${latestReasons.join(", ")}`
      );
    } else {
      rootCauseWhy.push("runtime not fully ready for admission path verification");
    }
  } else {
    const created24 = w24h.runtimeAutomatedCreated;
    const submitted24 = w24h.runtimeAutomatedSubmitted;
    const blocked24 = w24h.runtimeAutomatedBlocked;
    const paperOpened24 = w24h.paperTradesOpened;
    if (created24 === 0) {
      rootCauseCategory = "HEALTHY_BUT_IDLE";
      rootCauseWhy.push("no runtime_automated candidates in bounded window");
    } else if (submitted24 > 0 && paperOpened24 > 0) {
      rootCauseCategory = "HEALTHY_AND_OPERATING";
      rootCauseWhy.push("runtime submissions and paper-trade openings both observed in 24h window");
    } else if (submitted24 > 0 && paperOpened24 === 0) {
      rootCauseCategory = "HEALTHY_BUT_IDLE";
      rootCauseWhy.push(
        "runtime submissions observed; PaperTrade openings are on separate paper_trading_tick path and currently absent"
      );
    } else if (blocked24 > 0 && submitted24 === 0) {
      rootCauseCategory = "LEGITIMATE_POLICY_BLOCK";
      rootCauseWhy.push("candidates are being generated but blocked by policy/guardrail reasons");
    } else {
      rootCauseCategory = "OTHER_BUG";
      rootCauseWhy.push("admission outcomes inconclusive in bounded window");
    }
  }

  const report = {
    generatedAt,
    runtimeReadinessSnapshot: {
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
    admissionFunnelSummary: {
      windows: [w30m, w2h, w24h],
    },
    recentCandidateOutcomeWindow: recentCandidates,
    recentPaperTradeSnapshot: {
      count: recentPaperTradesView.length,
      latestPaperTrade,
      trades: recentPaperTradesView,
      noneRecently: recentPaperTradesView.length === 0,
    },
    gatePathAttribution: {
      latestBlockedCandidate: latestBlocked
        ? {
            id: latestBlocked.id,
            createdAt: latestBlocked.createdAt,
            attribution: latestBlocked.gatePathAttribution,
            reasons: latestBlocked.conciseBlockingReasons,
            legitimacy:
              latestBlocked.conciseBlockingReasons.length > 0
                ? "appears_legitimate_policy_or_guardrail_block"
                : "unknown",
          }
        : null,
      latestSubmittedCandidate: latestSubmitted
        ? {
            id: latestSubmitted.id,
            createdAt: latestSubmitted.createdAt,
            attribution: latestSubmitted.gatePathAttribution,
            executedOrdersCount: latestSubmitted.executedOrders.length,
            legitimacy: "admitted_runtime_path",
          }
        : null,
      pathNotes: [
        "Blocked runtime_automated candidates are emitted from worker/stream-runtime.ts at runtime guardrail or execution policy stages.",
        "Submitted runtime_automated candidates proceed to orderManager.reconcileIntents and persist to OrderIntent/ExecutedOrder.",
        "PaperTrade rows are opened by paper_trading_tick in lib/paper-trading/engine.ts; this is a separate admission pipeline.",
      ],
    },
    rootCauseAndFixSummary: {
      category: rootCauseCategory,
      why: rootCauseWhy,
      fixApplied: null as string | null,
    },
    overallVerdict: verdict,
    filesChanged: ["tools/create-paper-admission-report.ts", "package.json"],
  };

  const md: string[] = [];
  md.push("# Paper Admission Report");
  md.push(`Generated at: ${generatedAt}`);
  md.push("");
  md.push("## 1) Runtime readiness snapshot");
  md.push(
    `- runtimeStatus: **${runtimeStatus ?? "—"}** · lifecycleStatus: **${lifecycleStatus ?? "—"}** · runtimeMarkedReady: **${runtimeMarkedReady}**`
  );
  md.push(
    `- globalAutomationEnabled: **${globalAutomationEnabled ?? "—"}** · automationPermitted: **${automationPermitted ?? "—"}** · safeToAutomate: **${safeToAutomate ?? "—"}**`
  );
  md.push(`- runtimeSafetyState: **${runtimeSafetyState ?? "—"}**`);
  md.push(`- degradedReasons: ${degradedReasons.join(", ") || "(none)"}`);
  md.push(`- operatingMode: **${operatingMode ?? "—"}**`);
  md.push("");
  md.push("## 2) Admission funnel summary");
  md.push("| window | runtime_automated created | blocked | submitted | paper trades opened | paper open now | paper closed in window |");
  md.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const w of [w30m, w2h, w24h]) {
    md.push(
      `| ${w.windowLabel} | ${w.runtimeAutomatedCreated} | ${w.runtimeAutomatedBlocked} | ${w.runtimeAutomatedSubmitted} | ${w.paperTradesOpened} | ${w.paperTradesOpenNow} | ${w.paperTradesClosedInWindow} |`
    );
  }
  md.push("");
  md.push("## 3) Recent runtime_automated candidate outcomes");
  md.push("| createdAt | marketId | marketTitle | blocked | submitted | concise blocking reasons | reached submission | paper trade traceable? |");
  md.push("|---|---|---|---:|---:|---|---:|---:|");
  for (const c of recentCandidates) {
    md.push(
      `| ${c.createdAt} | ${c.marketId ?? "—"} | ${c.marketTitle ?? "—"} | ${c.wasBlocked} | ${c.wasSubmitted} | ${c.conciseBlockingReasons.join("; ") || "—"} | ${c.reachedSubmission} | ${c.paperTradeTraceable} |`
    );
  }
  md.push("");
  md.push("## 4) Recent paper trades");
  if (recentPaperTradesView.length === 0) {
    md.push("- No recent paper trades found.");
  } else {
    md.push("| createdAt | openedAt | closedAt | status | marketId | assetId | side | recommendationId |");
    md.push("|---|---|---|---|---|---|---|---|");
    for (const t of recentPaperTradesView) {
      md.push(
        `| ${t.createdAt} | ${t.openedAt} | ${t.closedAt ?? "—"} | ${t.status} | ${t.marketId} | ${t.assetId} | ${t.side} | ${t.recommendationId ?? "—"} |`
      );
    }
  }
  md.push("");
  md.push("## 5) Gate path attribution");
  md.push(`- latest blocked: ${latestBlocked ? `${latestBlocked.id} via ${latestBlocked.gatePathAttribution}` : "(none)"}`);
  md.push(`- latest submitted: ${latestSubmitted ? `${latestSubmitted.id} via ${latestSubmitted.gatePathAttribution}` : "(none)"}`);
  md.push("- runtime_automated submissions persist via OrderIntent/ExecutedOrder; PaperTrade openings are from paper_trading_tick.");
  md.push("");
  md.push("## 6) Root cause and fix summary");
  md.push(`- category: **${rootCauseCategory}**`);
  for (const why of rootCauseWhy) md.push(`- ${why}`);
  md.push("");
  md.push("## 7) Overall verdict");
  md.push(`- verdict: **${verdict}**`);

  await fs.writeFile(path.join(DUMP_DIR, "paper-admission-report.json"), JSON.stringify(report, null, 2), "utf-8");
  await fs.writeFile(path.join(DUMP_DIR, "paper-admission-report.md"), md.join("\n"), "utf-8");

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        overallVerdict: verdict,
        rootCauseCategory,
        runtimeStatus,
        lifecycleStatus,
        automationPermitted,
        safeToAutomate,
        window24h: w24h,
      },
      null,
      2
    )
  );
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("create-paper-admission-report failed", err);
  process.exit(1);
});

