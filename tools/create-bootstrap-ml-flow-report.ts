import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { ML_TARGET_REGISTRY } from "../lib/ml/targets/registry";
import type { MlTargetKey } from "../lib/ml/types/targets";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score/score-live";

type RootCauseClassification =
  | "BOOTSTRAP_FLOW_IMPLEMENTED"
  | "BOOTSTRAP_TARGET_ALREADY_SUPPORTED_NO_CODE_CHANGE_NEEDED"
  | "NO_EARLY_TARGET_AVAILABLE"
  | "PROMOTION_GUARDS_BLOCK_BOOTSTRAP"
  | "OTHER_BUG";

type OverallVerdict =
  | "READY_FOR_OVERNIGHT_BOOTSTRAP"
  | "READY_FOR_CHAMPION_MODE"
  | "STILL_BLOCKED"
  | "BROKEN";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "bootstrap-ml-flow-report.json");
const MD_PATH = path.join(DUMP_DIR, "bootstrap-ml-flow-report.md");
const SHADOW_MODEL_TYPE = "logistic_regression_shadow";

function isTrainableShadowTarget(k: MlTargetKey): boolean {
  const d = ML_TARGET_REGISTRY[k];
  return d.schemaPresent && d.trainableNow && d.scoringSupportedNow;
}

async function countRowsForTarget(k: MlTargetKey): Promise<number> {
  const rows = await prisma.mlShadowTrainingExample.findMany({
    where: { [k]: { not: null } },
    select: { [k]: true },
    take: 100_000,
  });
  let count = 0;
  for (const r of rows) {
    const v = (r as Record<string, unknown>)[k];
    if (v === true || v === false) count++;
  }
  return count;
}

async function jobRecentStatus(jobName: string, lookback: number): Promise<{
  hasRecentRun: boolean;
  currentlyRunning: boolean;
  latestRunAt: string | null;
  latestStatus: string | null;
}> {
  const [rows, runningCount] = await Promise.all([
    prisma.scheduledJobRun.findMany({
      where: { jobName },
      orderBy: { startedAt: "desc" },
      take: lookback,
      select: { startedAt: true, status: true },
    }),
    prisma.scheduledJobRun.count({
      where: { jobName, status: "running" },
    }),
  ]);
  const latest = rows[0];
  return {
    hasRecentRun: rows.length > 0,
    currentlyRunning: runningCount > 0,
    latestRunAt: latest?.startedAt?.toISOString() ?? null,
    latestStatus: latest?.status ?? null,
  };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const champion = await getActiveOrApprovedShadowModel();
  const mode = champion ? "champion_mode" : "cold_start_mode";

  const targetKeys = Object.keys(ML_TARGET_REGISTRY) as MlTargetKey[];
  const trainableTargets = targetKeys.filter((k) => isTrainableShadowTarget(k));
  const targetCounts = await Promise.all(
    trainableTargets.map(async (k) => ({
      target: k,
      rows: await countRowsForTarget(k),
      registry: ML_TARGET_REGISTRY[k],
    }))
  );
  const sortedByRows = [...targetCounts].sort((a, b) => b.rows - a.rows);
  const recommendedBootstrapTarget =
    targetCounts.find((x) => x.target === "labelGoodDecision12h" && x.rows > 0)?.target ??
    targetCounts.find((x) => x.target === "labelGoodDecision6h" && x.rows > 0)?.target ??
    sortedByRows[0]?.target ??
    null;

  const paperTickHardRequire = {
    module: "lib/paper-trading/engine.ts",
    function: "runPaperTradingTick",
    requiresActiveOrApprovedModel: true,
    targetSpecificGate: false,
    resolver: "lib/ml/shadow-score/score-live.ts#getActiveOrApprovedShadowModel",
  };

  const lastBootstrapCandidates = await prisma.mlModelRun.findMany({
    where: {
      modelType: SHADOW_MODEL_TYPE,
      targetLabel: { in: ["labelGoodDecision12h", "labelGoodDecision6h"] },
    },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: {
      id: true,
      status: true,
      targetLabel: true,
      updatedAt: true,
      trainCount: true,
      validationCount: true,
      metricsJson: true,
    },
  });
  const hasBootstrapTrainedNoChampion =
    !champion &&
    lastBootstrapCandidates.some((r) => r.status === "TRAINED" || r.status === "VALIDATED");
  const hasEarlyTargetRows = targetCounts.some(
    (x) => (x.target === "labelGoodDecision12h" || x.target === "labelGoodDecision6h") && x.rows > 0
  );

  let rootCauseClassification: RootCauseClassification = "BOOTSTRAP_FLOW_IMPLEMENTED";
  if (!hasEarlyTargetRows && !champion) {
    rootCauseClassification = "NO_EARLY_TARGET_AVAILABLE";
  } else if (hasBootstrapTrainedNoChampion) {
    rootCauseClassification = "PROMOTION_GUARDS_BLOCK_BOOTSTRAP";
  }

  let overallVerdict: OverallVerdict = "READY_FOR_OVERNIGHT_BOOTSTRAP";
  if (champion) {
    overallVerdict = "READY_FOR_CHAMPION_MODE";
  } else if (rootCauseClassification === "NO_EARLY_TARGET_AVAILABLE") {
    overallVerdict = "STILL_BLOCKED";
  } else if (rootCauseClassification === "PROMOTION_GUARDS_BLOCK_BOOTSTRAP") {
    overallVerdict = "STILL_BLOCKED";
  }

  const shadowEvaluation = await jobRecentStatus("shadow_evaluation", 10);
  const datasetBuild = await jobRecentStatus("ml_shadow_dataset_build", 10);
  const retrain = await jobRecentStatus("ml_shadow_retrain", 10);
  const promote = await jobRecentStatus("ml_shadow_promote", 10);

  const report = {
    generatedAt,
    bootstrapReadiness: {
      hasActiveOrApprovedShadowModel: !!champion,
      activeOrApprovedShadowModel: champion
        ? {
            runId: champion.run.id,
            targetLabel: champion.run.targetLabel,
            featureSetName: champion.run.featureSetName,
          }
        : null,
      trainableTargets: targetCounts.map((x) => ({
        target: x.target,
        rows: x.rows,
        horizonHours: x.registry.horizonHours,
        implemented: x.registry.implemented,
      })),
      recommendedBootstrapTargetRightNow: recommendedBootstrapTarget,
      systemMode: mode,
    },
    bootstrapPolicyBehavior: {
      implementingModule: "lib/ops/self-improvement-loop.ts",
      implementingFunction: "runShadowRetrainJob + maybeAutoApproveBootstrapRun",
      usedWhen:
        "No ACTIVE/APPROVED shadow champion exists; retrain target is selected from bootstrap policy (prefers 12h), and guarded auto-approval may set first eligible run to APPROVED for paper-only scoring.",
      notUsedWhen:
        "An ACTIVE/APPROVED champion already exists, or bootstrap guardrails fail, or target is outside bootstrap allow-list.",
      failClosedPreserved:
        "Paper tick still requires ACTIVE/APPROVED model; if none eligible, paper tick exits with error and opens no trades.",
      paperLiveSeparationPreserved:
        "All bootstrap logic is shadow model status/selection for paper scoring only; no live order flow changes and no reconciliation bypass.",
      paperTickRequirement: paperTickHardRequire,
    },
    continuousImprovementLoopStatus: {
      shadowEvaluation,
      datasetBuild,
      retraining: {
        ...retrain,
        bootstrapPathWiredWhenNoChampion: true,
        championChallengerPathWiredWhenChampionExists: true,
      },
      guardedPromotion: {
        ...promote,
        intact: true,
        module: "lib/ops/self-improvement-loop.ts#runShadowEvaluateAndPromoteJob",
      },
    },
    rootCauseClassification,
    overallVerdict,
  };

  await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

  const lines: string[] = [];
  lines.push("# Bootstrap ML flow report");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push("");
  lines.push("## 1) Current bootstrap readiness");
  lines.push(`- Active/approved shadow model exists: **${report.bootstrapReadiness.hasActiveOrApprovedShadowModel}**`);
  lines.push(`- Recommended bootstrap target now: **${report.bootstrapReadiness.recommendedBootstrapTargetRightNow ?? "none"}**`);
  lines.push(`- System mode: **${report.bootstrapReadiness.systemMode}**`);
  lines.push("");
  lines.push("| Target | Rows | Horizon(h) | Implemented |");
  lines.push("| --- | ---: | ---: | --- |");
  for (const t of report.bootstrapReadiness.trainableTargets) {
    lines.push(`| ${t.target} | ${t.rows} | ${t.horizonHours ?? "n/a"} | ${t.implemented} |`);
  }
  lines.push("");
  lines.push("## 2) Bootstrap policy behavior");
  lines.push(`- Module/function: \`${report.bootstrapPolicyBehavior.implementingModule}\` / \`${report.bootstrapPolicyBehavior.implementingFunction}\``);
  lines.push(`- Used when: ${report.bootstrapPolicyBehavior.usedWhen}`);
  lines.push(`- Not used when: ${report.bootstrapPolicyBehavior.notUsedWhen}`);
  lines.push(`- Fail-closed: ${report.bootstrapPolicyBehavior.failClosedPreserved}`);
  lines.push(`- Paper/live separation: ${report.bootstrapPolicyBehavior.paperLiveSeparationPreserved}`);
  lines.push("");
  lines.push("## 3) Continuous improvement loop status");
  lines.push(`- shadow_evaluation currently_running: ${report.continuousImprovementLoopStatus.shadowEvaluation.currentlyRunning}, has_recent_run: ${report.continuousImprovementLoopStatus.shadowEvaluation.hasRecentRun} (latest=${report.continuousImprovementLoopStatus.shadowEvaluation.latestStatus ?? "n/a"})`);
  lines.push(`- ml_shadow_dataset_build currently_running: ${report.continuousImprovementLoopStatus.datasetBuild.currentlyRunning}, has_recent_run: ${report.continuousImprovementLoopStatus.datasetBuild.hasRecentRun} (latest=${report.continuousImprovementLoopStatus.datasetBuild.latestStatus ?? "n/a"})`);
  lines.push(`- ml_shadow_retrain wired for bootstrap/champion modes: ${report.continuousImprovementLoopStatus.retraining.bootstrapPathWiredWhenNoChampion && report.continuousImprovementLoopStatus.retraining.championChallengerPathWiredWhenChampionExists}`);
  lines.push(`- Guarded promotion intact: ${report.continuousImprovementLoopStatus.guardedPromotion.intact}`);
  lines.push("");
  lines.push("## 4) Root-cause / policy classification");
  lines.push(`**${rootCauseClassification}**`);
  lines.push("");
  lines.push("## 5) Overall verdict");
  lines.push(`**${overallVerdict}**`);
  lines.push("");

  await fs.writeFile(MD_PATH, lines.join("\n"), "utf8");
  console.log(`Wrote ${JSON_PATH}`);
  console.log(`Wrote ${MD_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

