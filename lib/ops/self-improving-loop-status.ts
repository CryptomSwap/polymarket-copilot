/**
 * Operator-facing status for the paper-only self-improving ML loop.
 * Writes dump/self-improving-loop-status.{json,md} (no trading side effects).
 */

import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "@/lib/db";
import { getActiveOrApprovedShadowModel } from "@/lib/ml/shadow-score";
import { JOB_INTERVALS_MS, type JobName } from "./scheduled-jobs";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_OUT = path.join(DUMP_DIR, "self-improving-loop-status.json");
const MD_OUT = path.join(DUMP_DIR, "self-improving-loop-status.md");

const LOOP_JOB_NAMES: JobName[] = [
  "shadow_evaluation",
  "ml_shadow_dataset_build",
  "ml_shadow_path_feature_backfill",
  "ml_shadow_retrain",
  "ml_shadow_bootstrap_activate",
  "ml_shadow_promote",
  "self_improving_paper_loop",
  "paper_trading_tick",
  "paper_trading_close_due",
  "self_improvement_rollback_guard",
  "self_improvement_status_report",
];

async function latestSuccessRun(jobName: string): Promise<{ finishedAt: string; durationMs: number | null } | null> {
  const row = await prisma.scheduledJobRun.findFirst({
    where: { jobName, status: "success" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true, durationMs: true },
  });
  if (!row?.finishedAt) return null;
  return { finishedAt: row.finishedAt.toISOString(), durationMs: row.durationMs };
}

async function latestRunAny(jobName: string): Promise<{
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
} | null> {
  const row = await prisma.scheduledJobRun.findFirst({
    where: { jobName },
    orderBy: { startedAt: "desc" },
    select: { status: true, startedAt: true, finishedAt: true, errorMessage: true },
  });
  if (!row) return null;
  return {
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    errorMessage: row.errorMessage,
  };
}

function staleMs(lastSuccessIso: string | null, intervalMs: number): number | null {
  if (!lastSuccessIso) return null;
  const age = Date.now() - new Date(lastSuccessIso).getTime();
  return age - intervalMs;
}

export async function buildSelfImprovingLoopStatus(): Promise<Record<string, unknown>> {
  const generatedAt = new Date().toISOString();

  const stages: Record<string, unknown> = {};
  for (const name of LOOP_JOB_NAMES) {
    const success = await latestSuccessRun(name);
    const anyRun = await latestRunAny(name);
    const intervalMs = JOB_INTERVALS_MS[name] ?? 0;
    const overdueMs = success ? staleMs(success.finishedAt, intervalMs) : null;
    stages[name] = {
      latestSuccessFinishedAt: success?.finishedAt ?? null,
      latestSuccessDurationMs: success?.durationMs ?? null,
      latestRunStatus: anyRun?.status ?? null,
      latestRunStartedAt: anyRun?.startedAt ?? null,
      latestRunError: anyRun?.errorMessage ?? null,
      intervalMs,
      staleOrFailed:
        anyRun?.status === "failure"
          ? "latest_run_failed"
          : overdueMs != null && overdueMs > 0
            ? "success_older_than_interval"
            : anyRun == null
              ? "never_run"
              : "ok",
      overdueMs: overdueMs != null && overdueMs > 0 ? Math.round(overdueMs) : 0,
    };
  }

  const shadowUnevaluated = await prisma.shadowCandidate.count({
    where: { evaluatedAt: null, wasBlocked: false },
  });
  const examplesPathGaps = await prisma.mlShadowTrainingExample.count({
    where: {
      OR: [
        { momentum1hBps: null },
        { momentum6hBps: null },
        { volatility1hBps: null },
        { volatility6hBps: null },
      ],
    },
  });

  const activeStrict = await prisma.mlModelRun.findFirst({
    where: { modelType: "logistic_regression_shadow", status: "ACTIVE" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, targetLabel: true, status: true, createdAt: true, updatedAt: true },
  });

  const championParsed = await getActiveOrApprovedShadowModel();

  const latestTrained = await prisma.mlModelRun.findFirst({
    where: { modelType: "logistic_regression_shadow", status: "TRAINED" },
    orderBy: { createdAt: "desc" },
    select: { id: true, targetLabel: true, createdAt: true, trainCount: true, validationCount: true },
  });

  const { computeShadowPromotionPreview, computeBootstrapActivationPreview } = await import("./self-improvement-loop");
  const promotionPreview = await computeShadowPromotionPreview();
  const bootstrapPreview = await computeBootstrapActivationPreview();

  const paperState = await prisma.paperTradingState.findUnique({
    where: { id: "default" },
    select: { lastOpenTickAt: true, lastOpenTickResultJson: true, lastOpenTickError: true },
  });

  let paperTickOpenedLast = 0;
  let paperTickCandidatesLoaded = 0;
  let paperTickModelBlocked: string | null = null;
  if (paperState?.lastOpenTickResultJson) {
    try {
      const j = JSON.parse(paperState.lastOpenTickResultJson) as {
        opened?: number;
        candidatesLoaded?: number;
        errors?: string[];
      };
      paperTickOpenedLast = j.opened ?? 0;
      paperTickCandidatesLoaded = j.candidatesLoaded ?? 0;
      const errs = j.errors ?? [];
      paperTickModelBlocked = errs.find((e) => /shadow model|ACTIVE or APPROVED/i.test(e)) ?? null;
    } catch {
      // ignore
    }
  }

  const ordering = {
    documentedChain:
      "shadow_evaluation (truth) → ml_shadow_dataset_build | dataset_refresh inside ml_shadow_retrain → ml_shadow_path_feature_backfill (also inside ml_shadow_retrain before train) → ml_shadow_retrain → ml_shadow_bootstrap_activate → ml_shadow_promote → paper_trading_tick (parallel) → paper_trading_close_due → self_improvement_rollback_guard",
    orchestratedJob:
      "self_improving_paper_loop runs: evaluate → dataset_refresh → path_backfill → retrain → bootstrap_activate → promote → rollback_guard (see lib/ops/self-improvement-loop.ts#runSelfImprovingPaperLoopJob)",
  };

  return {
    generatedAt,
    ordering,
    stages,
    backlogs: {
      shadowCandidatesUnevaluatedApprox: shadowUnevaluated,
      mlShadowTrainingExamplesWithPathSlotGapsApprox: examplesPathGaps,
    },
    models: {
      activeRowStrict: activeStrict,
      championFromGate: championParsed?.run ?? null,
      latestTrainedChallenger: latestTrained,
    },
    activationReview: {
      bootstrapWouldApprove: bootstrapPreview.wouldApprove,
      bootstrapReason: bootstrapPreview.reason,
      bootstrapCandidateRunId: bootstrapPreview.candidateRunId,
      promotionWouldPromote: promotionPreview.wouldPromote,
      promotionReason:
        promotionPreview.status === "skipped"
          ? promotionPreview.skipReason ?? promotionPreview.outcomeReason
          : promotionPreview.outcomeReason,
      promotionHoldoutNoisy: promotionPreview.holdout.noisy,
      promotionDeltaAuc: promotionPreview.metrics.deltaAuc,
      promotionDeltaF1: promotionPreview.metrics.deltaF1,
    },
    paperTradingTick: {
      lastOpenTickAt: paperState?.lastOpenTickAt?.toISOString() ?? null,
      lastTickOpened: paperTickOpenedLast,
      lastTickCandidatesLoaded: paperTickCandidatesLoaded,
      appearsBlockedByMissingModel: paperTickModelBlocked != null,
      lastOpenTickError: paperState?.lastOpenTickError ?? null,
    },
  };
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export async function writeSelfImprovingLoopStatusReports(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const data = await buildSelfImprovingLoopStatus();
  await fs.writeFile(JSON_OUT, JSON.stringify(data, null, 2), "utf8");

  const stages = data.stages as Record<string, Record<string, unknown>>;
  const lines: string[] = [
    "# Self-improving paper loop status",
    "",
    `Generated: **${data.generatedAt}**`,
    "",
    "## Documented ordering",
    "",
    `- ${mdEscape(String((data.ordering as { documentedChain: string }).documentedChain))}`,
    `- ${mdEscape(String((data.ordering as { orchestratedJob: string }).orchestratedJob))}`,
    "",
    "## Stages (scheduled jobs)",
    "",
    "| Job | Latest success | Stale/failed | Interval (h) | Latest error |",
    "|-----|----------------|--------------|--------------|-------------|",
  ];

  for (const name of LOOP_JOB_NAMES) {
    const s = stages[name];
    const intervalH = ((s.intervalMs as number) / 3_600_000).toFixed(1);
    lines.push(
      `| ${name} | ${s.latestSuccessFinishedAt ?? "—"} | ${s.staleOrFailed} | ${intervalH} | ${s.latestRunError ? mdEscape(String(s.latestRunError)).slice(0, 80) : "—"} |`
    );
  }

  lines.push(
    "",
    "## Backlogs (approximate)",
    "",
    `- Shadow candidates not yet evaluated: **${(data.backlogs as { shadowCandidatesUnevaluatedApprox: number }).shadowCandidatesUnevaluatedApprox}**`,
    `- ML examples with path-feature gaps: **${(data.backlogs as { mlShadowTrainingExamplesWithPathSlotGapsApprox: number }).mlShadowTrainingExamplesWithPathSlotGapsApprox}**`,
    "",
    "## Models",
    "",
    `- ACTIVE row (strict): ${JSON.stringify((data.models as { activeRowStrict: unknown }).activeRowStrict)}`,
    `- Champion usable by paper tick gate: ${JSON.stringify((data.models as { championFromGate: unknown }).championFromGate)}`,
    `- Latest TRAINED: ${JSON.stringify((data.models as { latestTrainedChallenger: unknown }).latestTrainedChallenger)}`,
    "",
    "## Activation / promotion (read-only preview)",
    "",
    `- Bootstrap would APPROVE: **${(data.activationReview as { bootstrapWouldApprove: boolean }).bootstrapWouldApprove}** — ${mdEscape((data.activationReview as { bootstrapReason: string }).bootstrapReason)}`,
    `- Promotion would run ACTIVE swap: **${(data.activationReview as { promotionWouldPromote: boolean }).promotionWouldPromote}** — ${mdEscape((data.activationReview as { promotionReason: string }).promotionReason)}`,
    "",
    "## Paper trading tick",
    "",
    `- lastOpenTickAt: ${(data.paperTradingTick as { lastOpenTickAt: string | null }).lastOpenTickAt ?? "—"}`,
    `- last tick opened: **${(data.paperTradingTick as { lastTickOpened: number }).lastTickOpened}**, candidates loaded: **${(data.paperTradingTick as { lastTickCandidatesLoaded: number }).lastTickCandidatesLoaded}**`,
    `- blocked by missing model (heuristic): **${(data.paperTradingTick as { appearsBlockedByMissingModel: boolean }).appearsBlockedByMissingModel}**`,
    ""
  );

  await fs.writeFile(MD_OUT, lines.join("\n"), "utf8");
}
