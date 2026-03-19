/**
 * Bounded audit: runtime_automated submitted ShadowCandidate → PaperTrade opening.
 *
 * Writes:
 * - dump/paper-trade-opening-report.json
 * - dump/paper-trade-opening-report.md
 *
 * Prefers persisted DB state (ShadowCandidate, OrderIntent, ExecutedOrder, PaperTrade,
 * ScheduledJobRun, PaperTradingState). No log scraping.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getFunderForRecompute } from "../lib/polymarket/recompute";
import { getFunderForDecisionRecompute, getFunderForPaperTradingTick } from "../lib/decision/recompute";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WINDOWS = [
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "10m", ms: 10 * 60 * 1000 },
  { label: "30m", ms: 30 * 60 * 1000 },
] as const;

const LAST_SUBMITTED = 20;

type RootCauseClassification =
  | "PAPER_SUBMISSION_NOT_PERSISTED"
  | "ORDER_TO_PAPER_HANDOFF_MISSING"
  | "PAPER_TRADING_TICK_NOT_PICKING_UP_SUBMISSIONS"
  | "PAPER_ENGINE_REJECTING_SUBMITTED_ITEMS"
  | "PAPER_TRADE_WRITE_FAILURE"
  | "LINKAGE_TELEMETRY_MISSING"
  | "OTHER_BUG";

function since(ms: number): Date {
  return new Date(Date.now() - ms);
}

function redactFunder(f: string | null | undefined): string | null {
  if (!f || f.length < 12) return f ?? null;
  return `${f.slice(0, 6)}…${f.slice(-4)}`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parsePaperTradeMeta(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function windowFunnel(windowMs: number): Promise<{
  windowLabel: string;
  runtimeAutomatedSubmitted: number;
  runtimeAutomatedCreated: number;
  orderIntentsLinkedToSubmitted: number;
  executedOrdersLinked: number;
  paperTradingTickRuns: number;
  paperTradingTickSuccess: number;
  paperTradingTickFailure: number;
  paperTradesOpened: number;
}> {
  const gte = since(windowMs);
  const label = WINDOWS.find((w) => w.ms === windowMs)?.label ?? `${Math.round(windowMs / 60000)}m`;

  const [created, submitted, tickRuns, tickOk, tickFail, paperOpened] = await Promise.all([
    prisma.shadowCandidate.count({
      where: { candidateSource: "runtime_automated", createdAt: { gte } },
    }),
    prisma.shadowCandidate.count({
      where: { candidateSource: "runtime_automated", createdAt: { gte }, wasSubmitted: true },
    }),
    prisma.scheduledJobRun.count({
      where: { jobName: "paper_trading_tick", startedAt: { gte } },
    }),
    prisma.scheduledJobRun.count({
      where: { jobName: "paper_trading_tick", startedAt: { gte }, status: "success" },
    }),
    prisma.scheduledJobRun.count({
      where: { jobName: "paper_trading_tick", startedAt: { gte }, status: "failure" },
    }),
    prisma.paperTrade.count({ where: { createdAt: { gte } } }),
  ]);

  const submittedIds = await prisma.shadowCandidate.findMany({
    where: {
      candidateSource: "runtime_automated",
      createdAt: { gte },
      wasSubmitted: true,
      orderIntentId: { not: null },
    },
    select: { orderIntentId: true },
  });
  const intentSet = new Set(
    submittedIds.map((r) => r.orderIntentId).filter((x): x is string => !!x)
  );
  const orderIntentsLinkedToSubmitted = intentSet.size;

  let executedOrdersLinked = 0;
  if (intentSet.size > 0) {
    executedOrdersLinked = await prisma.executedOrder.count({
      where: { orderIntentId: { in: [...intentSet] }, createdAt: { gte } },
    });
  }

  return {
    windowLabel: label,
    runtimeAutomatedCreated: created,
    runtimeAutomatedSubmitted: submitted,
    orderIntentsLinkedToSubmitted,
    executedOrdersLinked,
    paperTradingTickRuns: tickRuns,
    paperTradingTickSuccess: tickOk,
    paperTradingTickFailure: tickFail,
    paperTradesOpened: paperOpened,
  };
}

function classifyRootCause(input: {
  missingIntentShare: number;
  submitted5m: number;
  lastTick: Record<string, unknown> | null;
  paperTickFunderVsRuntimeMismatch: boolean;
  writeFailureSignals: boolean;
}): { rootCause: RootCauseClassification; rationale: string[] } {
  const rationale: string[] = [];
  const tick = input.lastTick;

  if (input.missingIntentShare >= 0.5 && input.submitted5m > 0) {
    rationale.push("≥50% of recent submitted rows lack orderIntentId (unexpected after submission path).");
    return { rootCause: "LINKAGE_TELEMETRY_MISSING", rationale };
  }

  if (input.writeFailureSignals) {
    rationale.push("Last tick errors mention paper trade create / DB constraint.");
    return { rootCause: "PAPER_TRADE_WRITE_FAILURE", rationale };
  }

  const candidatesLoaded = typeof tick?.candidatesLoaded === "number" ? tick.candidatesLoaded : null;
  const opened = typeof tick?.opened === "number" ? tick.opened : null;
  const aboveTh = typeof tick?.aboveThresholdCount === "number" ? tick.aboveThresholdCount : null;
  const errors = Array.isArray(tick?.errors) ? (tick!.errors as string[]) : [];

  if (input.paperTickFunderVsRuntimeMismatch && input.submitted5m > 0) {
    rationale.push(
      "Paper tick funder (from persisted lastOpenTickResultJson or resolver) does not match runtime/credentials funder — recommendation universe for scoring would not match automation submissions."
    );
    return { rootCause: "ORDER_TO_PAPER_HANDOFF_MISSING", rationale };
  }

  if (input.submitted5m > 0 && candidatesLoaded === 0) {
    rationale.push("Submitted runtime_automated candidates in window but last tick loaded 0 paper candidates.");
    return { rootCause: "PAPER_TRADING_TICK_NOT_PICKING_UP_SUBMISSIONS", rationale };
  }

  if (
    input.submitted5m > 0 &&
    candidatesLoaded != null &&
    candidatesLoaded > 0 &&
    opened === 0 &&
    aboveTh === 0
  ) {
    rationale.push("Tick loaded candidates and scored, but none reached score ≥ minScore (threshold+buffer).");
    return { rootCause: "PAPER_ENGINE_REJECTING_SUBMITTED_ITEMS", rationale };
  }

  if (
    input.submitted5m > 0 &&
    candidatesLoaded != null &&
    candidatesLoaded > 0 &&
    opened === 0 &&
    aboveTh != null &&
    aboveTh > 0
  ) {
    rationale.push(
      "Candidates above threshold existed but opened=0 — likely cooldown, dedupe, caps, or budget (see decisionTraceBundle)."
    );
    return { rootCause: "PAPER_ENGINE_REJECTING_SUBMITTED_ITEMS", rationale };
  }

  if (errors.some((e) => /persist|prisma|unique|constraint/i.test(String(e)))) {
    rationale.push("Tick result carried persistence-related errors.");
    return { rootCause: "PAPER_TRADE_WRITE_FAILURE", rationale };
  }

  rationale.push(
    "PaperTrade rows are only created inside runPaperTradingTick after ML scoring of recommendation-based candidates; runtime order submission is a separate durable path (OrderIntent → paper reconcile). Default residual bucket."
  );
  return { rootCause: "ORDER_TO_PAPER_HANDOFF_MISSING", rationale };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const [runtimeFunder, decisionRecomputeFunder, paperTickFunder] = await Promise.all([
    getFunderForRecompute(),
    getFunderForDecisionRecompute(),
    getFunderForPaperTradingTick(),
  ]);

  const funderMismatch =
    !!runtimeFunder &&
    !!decisionRecomputeFunder &&
    runtimeFunder.toLowerCase() !== decisionRecomputeFunder.toLowerCase();

  const funnels = await Promise.all(WINDOWS.map((w) => windowFunnel(w.ms)));

  const state = await prisma.paperTradingState.findUnique({
    where: { id: "default" },
    select: { lastOpenTickAt: true, lastOpenTickResultJson: true, lastOpenTickError: true },
  });

  let lastTickParsed: Record<string, unknown> | null = null;
  if (state?.lastOpenTickResultJson) {
    try {
      lastTickParsed = asRecord(JSON.parse(state.lastOpenTickResultJson));
    } catch {
      lastTickParsed = null;
    }
  }

  const tickFunderRaw =
    typeof lastTickParsed?.funderUsedForCandidateLoad === "string"
      ? lastTickParsed.funderUsedForCandidateLoad.toLowerCase()
      : null;
  const rt = runtimeFunder?.toLowerCase() ?? null;
  const ptr = paperTickFunder?.toLowerCase() ?? null;
  /** True if persisted tick used a different funder than the runtime wallet, or tick predates field and resolver still disagrees with runtime. */
  const paperTickFunderVsRuntimeMismatch = !!(
    rt &&
    ((tickFunderRaw && tickFunderRaw !== rt) || (!tickFunderRaw && ptr && ptr !== rt))
  );

  const traceRecIds = new Set<string>();
  const bundle = lastTickParsed?.decisionTraceBundle as Record<string, unknown> | undefined;
  const traces = bundle?.traces;
  if (Array.isArray(traces)) {
    for (const t of traces) {
      const tr = asRecord(t);
      const rid = tr?.recommendationId;
      if (typeof rid === "string" && rid) traceRecIds.add(rid);
    }
  }

  const lastErrors = Array.isArray(lastTickParsed?.errors)
    ? (lastTickParsed!.errors as string[]).map(String)
    : [];
  const writeFailureSignals = lastErrors.some((e) =>
    /create paper trade|paper trade failed|Unique constraint|dedupeKey|P2002/i.test(e)
  );

  const recentSubmitted = await prisma.shadowCandidate.findMany({
    where: { candidateSource: "runtime_automated", wasSubmitted: true },
    orderBy: { createdAt: "desc" },
    take: LAST_SUBMITTED,
    select: {
      id: true,
      createdAt: true,
      funderAddress: true,
      recommendationId: true,
      orderIntentId: true,
      marketId: true,
      assetId: true,
      side: true,
      wasSubmitted: true,
    },
  });

  const recIds = [...new Set(recentSubmitted.map((c) => c.recommendationId).filter(Boolean))] as string[];
  const recRows = recIds.length
    ? await prisma.recommendation.findMany({
        where: { id: { in: recIds } },
        select: { id: true, marketSignal: { select: { marketTitle: true, marketId: true } } },
      })
    : [];
  const recMap = new Map(recRows.map((r) => [r.id, r.marketSignal]));

  const intentIds = [...new Set(recentSubmitted.map((c) => c.orderIntentId).filter(Boolean))] as string[];
  const intents = intentIds.length
    ? await prisma.orderIntent.findMany({
        where: { id: { in: intentIds } },
        select: { id: true, status: true, source: true, createdAt: true },
      })
    : [];
  const intentMap = new Map(intents.map((i) => [i.id, i]));

  const execRows = intentIds.length
    ? await prisma.executedOrder.findMany({
        where: { orderIntentId: { in: intentIds } },
        select: {
          id: true,
          orderIntentId: true,
          venue: true,
          status: true,
          createdAt: true,
        },
      })
    : [];
  const execByIntent = new Map<string, typeof execRows>();
  for (const e of execRows) {
    if (!e.orderIntentId) continue;
    const arr = execByIntent.get(e.orderIntentId) ?? [];
    arr.push(e);
    execByIntent.set(e.orderIntentId, arr);
  }

  const missingIntentCount = recentSubmitted.filter((c) => !c.orderIntentId).length;
  const missingIntentShare = recentSubmitted.length ? missingIntentCount / recentSubmitted.length : 0;

  const submitted5m = funnels[0]?.runtimeAutomatedSubmitted ?? 0;

  const { rootCause, rationale } = classifyRootCause({
    missingIntentShare,
    submitted5m,
    lastTick: lastTickParsed,
    paperTickFunderVsRuntimeMismatch,
    writeFailureSignals,
  });

  const lastTwenty = await Promise.all(
    recentSubmitted.map(async (c) => {
      const market = c.recommendationId ? recMap.get(c.recommendationId) : null;
      const intent = c.orderIntentId ? intentMap.get(c.orderIntentId) : undefined;
      const execs = c.orderIntentId ? execByIntent.get(c.orderIntentId) ?? [] : [];

      const after = c.createdAt;
      const windowEnd = new Date(after.getTime() + 48 * 60 * 60 * 1000);
      const paperMatches = await prisma.paperTrade.findMany({
        where: {
          assetId: c.assetId,
          side: c.side,
          createdAt: { gte: after, lte: windowEnd },
        },
        orderBy: { createdAt: "asc" },
        take: 5,
        select: { id: true, createdAt: true, metadataJson: true, status: true },
      });

      let paperTradeId: string | null = null;
      let paperMatchReason = "none_in_48h_window_asset_side";
      for (const p of paperMatches) {
        const md = parsePaperTradeMeta(p.metadataJson);
        const prid = md && typeof md.recommendationId === "string" ? md.recommendationId : null;
        if (c.recommendationId && prid && prid === c.recommendationId) {
          paperTradeId = p.id;
          paperMatchReason = "matched_metadata_recommendationId+asset+side+time";
          break;
        }
        if (!c.recommendationId && paperMatches.length === 1) {
          paperTradeId = p.id;
          paperMatchReason = "matched_asset_side_time_only_no_rec_on_candidate";
          break;
        }
      }
      if (!paperTradeId && paperMatches.length > 0 && c.recommendationId) {
        paperMatchReason = "ambiguous_or_recId_mismatch_in_metadata";
      }

      const tickSawRecommendation =
        !!c.recommendationId && traceRecIds.has(c.recommendationId) ? true : c.recommendationId ? false : null;

      let missingLinkStage: string;
      if (!c.orderIntentId) {
        missingLinkStage = "shadow_row_missing_orderIntentId_after_submit_anomaly";
      } else if (!intent) {
        missingLinkStage = "order_intent_row_not_found_for_shadow_orderIntentId";
      } else if (execs.length === 0) {
        missingLinkStage = "no_executed_order_yet_for_intent_paper_reconcile_may_be_async_or_failed";
      } else if (!paperTradeId) {
        missingLinkStage =
          "no_paper_trade_row; PaperTrade_only_opened_from_runPaperTradingTick_not_from_order_intent";
      } else {
        missingLinkStage = "paper_trade_present";
      }

      return {
        decidedAt: c.createdAt.toISOString(),
        candidateId: c.id,
        wasSubmitted: c.wasSubmitted,
        marketId: c.marketId,
        marketTitle: market?.marketTitle ?? null,
        recommendationId: c.recommendationId,
        orderIntentId: c.orderIntentId,
        orderIntentStatus: intent?.status ?? null,
        executedOrders: execs.map((e) => ({
          id: e.id,
          venue: e.venue ?? null,
          status: e.status,
          createdAt: e.createdAt.toISOString(),
        })),
        paperTradingTickSawRecommendationInLastTrace: tickSawRecommendation,
        paperTradeId,
        paperMatchReason,
        missingLinkStage,
        funderAddressRedacted: redactFunder(c.funderAddress),
      };
    })
  );

  const pathNotes = [
    "1) stream-runtime: order.intent.created → guardrails → create OrderIntent → execution policy → recordShadowCandidate(wasSubmitted) → orderManager.reconcileIntents (paper mode).",
    "2) PaperTrade: ONLY prisma.paperTrade.create inside lib/paper-trading/engine.ts after scoreShadowCandidate ≥ threshold (+ caps/cooldown/dedupe).",
    "3) Candidates for scoring: lib/paper-trading/candidates.ts (recommendations + DecisionPolicySnapshot for the tick funder).",
    "4) There is no direct bridge from OrderIntent / runtime_automated ShadowCandidate to PaperTrade without passing through the paper tick scoring pipeline.",
  ];

  const report = {
    generatedAt,
    rootCauseClassification: rootCause,
    rootCauseRationale: rationale,
    funderResolution: {
      runtimeWorkerFunderRedacted: redactFunder(runtimeFunder),
      decisionRecomputeFunderRedacted: redactFunder(decisionRecomputeFunder),
      paperTradingTickFunderRedacted: redactFunder(paperTickFunder),
      runtimeVsDecisionRecomputeMismatch: funderMismatch,
      note:
        "paper_trading_tick now uses getFunderForPaperTradingTick() (wallet first) so candidate load aligns with stream-runtime when credentials exist.",
    },
    paperTradingState: {
      lastOpenTickAt: state?.lastOpenTickAt?.toISOString() ?? null,
      lastOpenTickError: state?.lastOpenTickError ?? null,
      lastOpenTickSummary: lastTickParsed
        ? {
            opened: lastTickParsed.opened,
            skipped: lastTickParsed.skipped,
            candidatesLoaded: lastTickParsed.candidatesLoaded,
            candidatesScored: lastTickParsed.candidatesScored,
            aboveThresholdCount: lastTickParsed.aboveThresholdCount,
            enabled: lastTickParsed.enabled,
            errors: lastTickParsed.errors,
            funderUsedForCandidateLoadRedacted: redactFunder(
              typeof lastTickParsed.funderUsedForCandidateLoad === "string"
                ? lastTickParsed.funderUsedForCandidateLoad
                : null
            ),
          }
        : null,
    },
    funnelByWindow: funnels,
    lastSubmittedRuntimeAutomated: lastTwenty,
    auditPath: pathNotes,
    fixAppliedInThisPass: {
      description:
        "Align paper_trading_tick funder with stream-runtime wallet (getFunderForPaperTradingTick); persist funderUsedForCandidateLoad on tick results.",
      files: [
        "lib/decision/recompute.ts — getFunderForPaperTradingTick",
        "lib/ops/scheduled-jobs.ts — paper_trading_tick case",
        "app/api/paper-trading/tick/route.ts — POST handler",
        "lib/paper-trading/engine.ts — funderUsedForCandidateLoad on PaperTradingTickResult",
      ],
    },
  };

  const jsonPath = path.join(DUMP_DIR, "paper-trade-opening-report.json");
  const mdPath = path.join(DUMP_DIR, "paper-trade-opening-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper trade opening report (runtime_automated → PaperTrade)");
  md.push("");
  md.push(`Generated: ${generatedAt}`);
  md.push("");
  md.push("## Root cause (single classification)");
  md.push("");
  md.push(`**${rootCause}**`);
  md.push("");
  for (const r of rationale) md.push(`- ${r}`);
  md.push("");
  md.push("## Funder resolution");
  md.push("");
  md.push(`| Key | Value |`);
  md.push(`| --- | --- |`);
  md.push(`| Runtime / credentials funder | ${redactFunder(runtimeFunder) ?? "—"} |`);
  md.push(`| Decision recompute heuristic funder | ${redactFunder(decisionRecomputeFunder) ?? "—"} |`);
  md.push(`| Paper tick funder (current API) | ${redactFunder(paperTickFunder) ?? "—"} |`);
  md.push(`| Runtime vs decision-recompute mismatch | ${funderMismatch} |`);
  md.push("");
  md.push("## Funnel (by window)");
  md.push("");
  md.push(
    "| Window | submitted | created | intents linked | executed (window) | tick runs | tick OK | tick fail | PaperTrades opened |"
  );
  md.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const f of funnels) {
    md.push(
      `| ${f.windowLabel} | ${f.runtimeAutomatedSubmitted} | ${f.runtimeAutomatedCreated} | ${f.orderIntentsLinkedToSubmitted} | ${f.executedOrdersLinked} | ${f.paperTradingTickRuns} | ${f.paperTradingTickSuccess} | ${f.paperTradingTickFailure} | ${f.paperTradesOpened} |`
    );
  }
  md.push("");
  md.push("## Last paper tick (persisted)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(report.paperTradingState, null, 2));
  md.push("```");
  md.push("");
  md.push("## Last 20 submitted runtime_automated candidates");
  md.push("");
  md.push(
    "| decidedAt | candidateId | market | recId | intentId | exec # | tick saw rec (last trace) | PaperTrade | missing stage |"
  );
  md.push("| --- | --- | --- | --- | --- | ---: | --- | --- | --- |");
  for (const row of lastTwenty) {
    const title = (row.marketTitle ?? row.marketId ?? "—").toString().slice(0, 40);
    md.push(
      `| ${row.decidedAt} | ${row.candidateId.slice(0, 12)}… | ${title} | ${row.recommendationId ?? "—"} | ${row.orderIntentId ?? "—"} | ${row.executedOrders.length} | ${String(row.paperTradingTickSawRecommendationInLastTrace)} | ${row.paperTradeId ?? "—"} | ${row.missingLinkStage} |`
    );
  }
  md.push("");
  md.push("## End-to-end path (audit)");
  md.push("");
  for (const p of pathNotes) md.push(`- ${p}`);
  md.push("");
  md.push("## Fix applied (this pass)");
  md.push("");
  for (const f of report.fixAppliedInThisPass.files) md.push(`- \`${f}\``);
  md.push("");

  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
