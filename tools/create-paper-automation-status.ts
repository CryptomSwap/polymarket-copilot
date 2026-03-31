/**
 * Paper trading automation status: worker scheduler wiring + optional DB health.
 *
 * Writes:
 * - dump/paper-automation-status.json
 * - dump/paper-automation-status.md
 *
 * Run: npx tsx tools/create-paper-automation-status.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score";
import { enablePaperBotBudgetAllocatorV1 } from "../lib/ml/config";
import { JOB_INTERVALS_MS } from "../lib/ops/scheduled-jobs";
import { getPaperTradingConfig, getPaperTradingMaxHoldHours } from "../lib/paper-trading/config";
import { normalizeCloseTickResult } from "../lib/paper-trading/normalize-close-tick-result";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "paper-automation-status.json");
const MD_PATH = path.join(DUMP_DIR, "paper-automation-status.md");

function optNum(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function dominantBlocker(row: {
  cooldown: number;
  risk: number;
  spread: number;
  slip: number;
}): { label: string; count: number } {
  const entries: [string, number][] = [
    ["cooldown", row.cooldown],
    ["risk_limit", row.risk],
    ["spread_guard", row.spread],
    ["slippage_guard", row.slip],
  ];
  let best = entries[0]!;
  for (const e of entries) {
    if (e[1] > best[1]) best = e;
  }
  return { label: best[0], count: best[1] };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const cfg = getPaperTradingConfig();
  const maxHoldHours = getPaperTradingMaxHoldHours();
  const allocatorOn = enablePaperBotBudgetAllocatorV1();
  const RUNTIME_MODE = process.env.RUNTIME_MODE ?? "paper";

  const schedulerFindings = {
    autonomousPaperTickJobName: "paper_trading_tick" as const,
    autonomousPaperTickDrivenBy:
      "lib/ops/scheduled-jobs.ts executeJob → runPaperTradingTick (worker/worker/index.ts scheduleJobs → runScheduledJob).",
    paperTradingTickIntervalMs: JOB_INTERVALS_MS.paper_trading_tick,
    paperTradingTickIntervalMinutes: JOB_INTERVALS_MS.paper_trading_tick / 60_000,
    paperCloseDueJobName: "paper_trading_close_due" as const,
    paperCloseDueDrivenBy:
      "executeJob → closeDuePaperTrades({ persistState: true }); backup to per-tick closes inside runPaperTradingTick.",
    paperCloseDueIntervalMs: JOB_INTERVALS_MS.paper_trading_close_due,
    paperCloseDueIntervalMinutes: JOB_INTERVALS_MS.paper_trading_close_due / 60_000,
    manualHttpTickOptional:
      "POST /api/paper-trading/tick is optional; worker schedule is the primary driver when npm run worker is running.",
    envRuntimeModeWorkerDefault: RUNTIME_MODE,
    note: "Automation requires the worker process to be running; the Next.js app alone does not execute scheduled jobs.",
  };

  const gates: {
    paperTradingConfigEnabled: boolean;
    paperOpenAutomationWouldRun: boolean | null;
    modelActiveOrApproved: boolean | null;
    gatedBy: string;
  } = {
    paperTradingConfigEnabled: cfg.enabled,
    paperOpenAutomationWouldRun: null,
    modelActiveOrApproved: null,
    gatedBy:
      "runPaperTradingTick returns early when PAPER_TRADING_ENABLED is off or there is no ACTIVE/APPROVED shadow model.",
  };

  let dbAvailable = true;
  let dbError: string | null = null;
  let lastJobTick: Record<string, unknown> | null = null;
  let lastJobCloseDue: Record<string, unknown> | null = null;
  let latestOpenTickSummary: Record<string, unknown> = {};
  let latestCloseTickSummary: Record<string, unknown> = {};
  let openBookSummary: Record<string, unknown> = {};
  let selfRunningAssessment: Record<string, unknown> = {};

  try {
    try {
      const active = await getActiveOrApprovedShadowModel();
      gates.modelActiveOrApproved = active != null;
    } catch {
      gates.modelActiveOrApproved = null;
    }
    gates.paperOpenAutomationWouldRun =
      gates.modelActiveOrApproved === null ? null : cfg.enabled && gates.modelActiveOrApproved;

    const [tickRun, closeRun] = await Promise.all([
      prisma.scheduledJobRun.findFirst({
        where: { jobName: "paper_trading_tick", status: "success" },
        orderBy: { finishedAt: "desc" },
        select: {
          id: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
        },
      }),
      prisma.scheduledJobRun.findFirst({
        where: { jobName: "paper_trading_close_due", status: "success" },
        orderBy: { finishedAt: "desc" },
        select: {
          id: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
        },
      }),
    ]);

    lastJobTick = tickRun
      ? {
          runId: tickRun.id,
          startedAt: tickRun.startedAt.toISOString(),
          finishedAt: tickRun.finishedAt?.toISOString() ?? null,
          durationMs: tickRun.durationMs,
        }
      : null;
    lastJobCloseDue = closeRun
      ? {
          runId: closeRun.id,
          startedAt: closeRun.startedAt.toISOString(),
          finishedAt: closeRun.finishedAt?.toISOString() ?? null,
          durationMs: closeRun.durationMs,
        }
      : null;

    const state = await prisma.paperTradingState.findUnique({ where: { id: "default" } });
    const lastOpenTickAt = state?.lastOpenTickAt?.toISOString() ?? null;
    let openParsed: Record<string, unknown> | null = null;
    if (state?.lastOpenTickResultJson) {
      try {
        openParsed = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
      } catch {
        openParsed = null;
      }
    }
    const cd = optNum(openParsed?.rejectedByCooldownCount) ?? 0;
    const risk = optNum(openParsed?.rejectedByRiskLimitCount) ?? 0;
    const spread = optNum(openParsed?.rejectedBySpreadGuardCount) ?? 0;
    const slip = optNum(openParsed?.rejectedBySlippageGuardCount) ?? 0;
    const rejectTotal = cd + risk + spread + slip;
    const dom = rejectTotal > 0 ? dominantBlocker({ cooldown: cd, risk, spread, slip }) : null;

    latestOpenTickSummary = {
      lastOpenTickAt,
      lastOpenTickError: state?.lastOpenTickError ?? null,
      opened: optNum(openParsed?.opened),
      candidatesLoaded: optNum(openParsed?.candidatesLoaded),
      candidatesScored: optNum(openParsed?.candidatesScored),
      rejectedByCooldownCount: optNum(openParsed?.rejectedByCooldownCount),
      rejectedByRiskLimitCount: optNum(openParsed?.rejectedByRiskLimitCount),
      rejectedBySpreadGuardCount: optNum(openParsed?.rejectedBySpreadGuardCount),
      rejectedBySlippageGuardCount: optNum(openParsed?.rejectedBySlippageGuardCount),
      dominantBlockerFromLatestOpenTick: dom,
    };

    let closeParsed: Record<string, unknown> | null = null;
    if (state?.lastCloseTickResultJson) {
      try {
        closeParsed = JSON.parse(state.lastCloseTickResultJson) as Record<string, unknown>;
      } catch {
        closeParsed = null;
      }
    }
    const closeNorm = normalizeCloseTickResult(closeParsed);
    const lastCloseTickAt = state?.lastCloseTickAt?.toISOString() ?? null;
    latestCloseTickSummary = {
      lastCloseTickAt,
      lastCloseTickError: state?.lastCloseTickError ?? null,
      openTotalCount: closeNorm.openTotalCount,
      dueCount: closeNorm.dueCount,
      closed: closeNorm.closed,
      maxHoldHours:
        typeof closeParsed?.maxHoldHours === "number" ? closeParsed.maxHoldHours : maxHoldHours,
    };

    const openRows = await prisma.paperTrade.findMany({
      where: { status: "open" },
      select: { botType: true },
    });
    const byBot = new Map<string, number>();
    for (const row of openRows) {
      byBot.set(row.botType, (byBot.get(row.botType) ?? 0) + 1);
    }
    openBookSummary = {
      openTradeCount: openRows.length,
      openTradesByBot: Object.fromEntries([...byBot.entries()].sort((a, b) => b[1] - a[1])),
    };

    const now = Date.now();
    const staleAfterMs = 15 * 60 * 1000;
    const lastOpenMs = state?.lastOpenTickAt ? state.lastOpenTickAt.getTime() : null;
    const tickJobMs = tickRun?.finishedAt ? tickRun.finishedAt.getTime() : null;
    const openTickFresh =
      lastOpenMs != null && now - lastOpenMs <= staleAfterMs
        ? true
        : tickJobMs != null && now - tickJobMs <= staleAfterMs;

    const closeAutomationEnabled = maxHoldHours > 0;
    const selfRunning =
      gates.paperOpenAutomationWouldRun === true &&
      openTickFresh &&
      (state?.lastOpenTickError == null || state.lastOpenTickError === "");

    selfRunningAssessment = {
      appearsSelfRunning: selfRunning,
      reasons: {
        configAndModelOk: gates.paperOpenAutomationWouldRun,
        recentOpenTickOrSuccessfulJob: openTickFresh,
        noLastOpenTickError: state?.lastOpenTickError == null || state.lastOpenTickError === "",
        closeAutomationEnabled,
      },
      stalenessWindowMinutes: staleAfterMs / 60_000,
      lastScheduledPaperTickSuccess: lastJobTick,
      lastScheduledCloseDueSuccess: lastJobCloseDue,
    };
  } catch (e) {
    dbAvailable = false;
    dbError = e instanceof Error ? e.message : String(e);
    gates.modelActiveOrApproved = null;
    gates.paperOpenAutomationWouldRun = null;
    latestOpenTickSummary = { error: "db_unavailable", dbError };
    latestCloseTickSummary = { error: "db_unavailable", dbError };
    openBookSummary = { error: "db_unavailable", dbError };
    selfRunningAssessment = {
      appearsSelfRunning: null,
      note: "DB unavailable; scheduler findings above still apply when the worker runs.",
      dbError,
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dbAvailable,
    dbError,
    paperAutomationEnabled: cfg.enabled,
    closeAutomationEnabled: maxHoldHours > 0,
    schedulerFindings,
    gates,
    effectiveConfig: {
      maxOpenTotal: cfg.maxOpenTotal,
      cooldownHours: cfg.cooldownHours,
      maxHoldHours,
      maxSpreadBps: cfg.paperMaxSpreadBps,
      maxEstimatedSlippageBps: cfg.paperMaxEstimatedSlippageBps,
      budgetAllocatorEnabled: allocatorOn,
    },
    latestOpenTickSummary,
    latestCloseTickSummary,
    openBookSummary,
    selfRunningAssessment,
  };

  await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper automation status");
  md.push("");
  md.push(`Generated: \`${report.generatedAt}\``);
  md.push(`DB available: **${dbAvailable}**${dbError ? ` — ${dbError}` : ""}`);
  md.push("");
  md.push("## Scheduler (code path)");
  md.push("");
  md.push("| Item | Value |");
  md.push("|------|-------|");
  md.push(`| Open tick job | \`${schedulerFindings.autonomousPaperTickJobName}\` |`);
  md.push(`| Open tick interval | ${schedulerFindings.paperTradingTickIntervalMinutes} min |`);
  md.push(`| Close-due job | \`${schedulerFindings.paperCloseDueJobName}\` |`);
  md.push(`| Close-due interval | ${schedulerFindings.paperCloseDueIntervalMinutes} min |`);
  md.push("");
  md.push(`_${schedulerFindings.manualHttpTickOptional}_`);
  md.push("");
  md.push("## Gates");
  md.push("");
  md.push(JSON.stringify(gates, null, 2));
  md.push("");
  md.push("## Effective config");
  md.push("");
  md.push(JSON.stringify(report.effectiveConfig, null, 2));
  md.push("");
  md.push("## Latest open tick summary");
  md.push("");
  md.push(JSON.stringify(latestOpenTickSummary, null, 2));
  md.push("");
  md.push("## Latest close tick summary");
  md.push("");
  md.push(JSON.stringify(latestCloseTickSummary, null, 2));
  md.push("");
  md.push("## Open book");
  md.push("");
  md.push(JSON.stringify(openBookSummary, null, 2));
  md.push("");
  md.push("## Self-running assessment");
  md.push("");
  md.push(JSON.stringify(selfRunningAssessment, null, 2));
  md.push("");

  await fs.writeFile(MD_PATH, md.join("\n"), "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
