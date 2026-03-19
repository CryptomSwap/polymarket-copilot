/**
 * Bounded audit: MlShadowTrainingExample population and labelGoodDecision (and related labels).
 *
 * Writes:
 * - dump/shadow-training-data-report.json
 * - dump/shadow-training-data-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getFunderForRecompute } from "../lib/polymarket/recompute";

const DUMP_DIR = path.join(process.cwd(), "dump");
const MIN_EVAL_AGE_MS = 25 * 60 * 60 * 1000;

type NullLabelDiagnosis =
  | "NO_EXAMPLES_EXIST"
  | "EXAMPLES_EXIST_LABELS_NULL"
  | "LABEL_JOB_NOT_RUNNING"
  | "LABEL_WINDOW_NOT_MATURED_YET"
  | "FUNDER_SCOPE_MISMATCH"
  | "QUERY_FILTER_BUG"
  | "OTHER_BUG";

function since(ms: number): Date {
  return new Date(Date.now() - ms);
}

function redactFunder(f: string | null | undefined): string | null {
  if (!f || f.length < 12) return f ?? null;
  return `${f.slice(0, 6)}…${f.slice(-4)}`;
}

async function jobEvidence(jobName: string, windowMs: number) {
  const gte = since(windowMs);
  const runs = await prisma.scheduledJobRun.findMany({
    where: { jobName, startedAt: { gte } },
    orderBy: { startedAt: "desc" },
    take: 15,
    select: {
      id: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      errorMessage: true,
    },
  });
  const success = runs.filter((r) => r.status === "success").length;
  const failure = runs.filter((r) => r.status === "failure").length;
  return {
    windowLabel: `${Math.round(windowMs / 3600000)}h`,
    runsInWindow: runs.length,
    successCount: success,
    failureCount: failure,
    recent: runs.slice(0, 5).map((r) => ({
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      durationMs: r.durationMs,
      errorExcerpt: r.errorMessage ? String(r.errorMessage).slice(0, 200) : null,
    })),
  };
}

function classifyNullLabelDiagnosis(input: {
  totalExamples: number;
  labelGoodDecisionPopulated: number;
  labelGoodDecision12hPopulated: number;
  unevaluatedOldEnough: number;
  evaluatedWithNullOutcome: number;
  shadowEvalRuns7d: number;
  datasetBuildRuns7d: number;
  funderMismatchSignal: boolean;
}): { diagnosis: NullLabelDiagnosis; rationale: string[] } {
  const r: string[] = [];
  if (input.labelGoodDecisionPopulated > 0) {
    r.push(
      `labelGoodDecision is populated on ${input.labelGoodDecisionPopulated} row(s). If training still fails, check --funder/--limit or use dump:shadow-training-data-report.`
    );
    return { diagnosis: "OTHER_BUG", rationale: r };
  }
  if (input.totalExamples === 0) {
    r.push("No MlShadowTrainingExample rows. persistShadowTrainingExamples has not created any (or DB empty).");
    if (input.datasetBuildRuns7d === 0) {
      r.push("No ml_shadow_dataset_build job runs in 7d window (check worker schedule or run POST /api/ops/ml-shadow-dataset).");
    }
    return { diagnosis: "NO_EXAMPLES_EXIST", rationale: r };
  }
  if (input.labelGoodDecisionPopulated === 0 && input.totalExamples > 0) {
    r.push("Examples exist but labelGoodDecision is null on all sampled/all rows.");
    r.push(
      "labelGoodDecision is derived from ShadowCandidate.outcomeClassification (24h markout via evaluateShadowCandidates). If markout24h is missing, classification stays null."
    );
    if (input.labelGoodDecision12hPopulated > 0) {
      r.push(
        `labelGoodDecision12h has ${input.labelGoodDecision12hPopulated} populated rows — train with --target labelGoodDecision12h for paper-aligned 12h horizon without waiting on 24h classification.`
      );
    }
    return { diagnosis: "EXAMPLES_EXIST_LABELS_NULL", rationale: r };
  }
  if (input.funderMismatchSignal) {
    r.push("Shadow candidate counts for credentials funder differ materially from global (possible train --funder mismatch).");
    return { diagnosis: "FUNDER_SCOPE_MISMATCH", rationale: r };
  }
  if (input.unevaluatedOldEnough > 50 && input.shadowEvalRuns7d === 0) {
    r.push("Many candidates are old enough for evaluation but shadow_evaluation shows no runs in 7d.");
    return { diagnosis: "LABEL_JOB_NOT_RUNNING", rationale: r };
  }
  if (input.unevaluatedOldEnough === 0 && input.evaluatedWithNullOutcome > 0) {
    r.push("Candidates may still be younger than minAgeMs (25h) for shadow_evaluation, or prices at 24h missing.");
    return { diagnosis: "LABEL_WINDOW_NOT_MATURED_YET", rationale: r };
  }
  r.push("See inventory and job evidence for detail.");
  return { diagnosis: "OTHER_BUG", rationale: r };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const credsFunder = await getFunderForRecompute();

  const w5m = since(5 * 60 * 1000);
  const w30m = since(30 * 60 * 1000);
  const w24h = since(24 * 60 * 60 * 1000);
  const w7d = since(7 * 24 * 60 * 60 * 1000);
  const evalCutoff = since(MIN_EVAL_AGE_MS);

  const [
    totalExamples,
    examples5m,
    examples30m,
    examples24h,
    examples7d,
    labelGdPopulated,
    labelGd12Populated,
    labelGd6Populated,
    labelMoPopulated,
    totalShadowCandidates,
    evaluatedCandidates,
    unevaluatedOldEnough,
    evaluatedNullOutcome,
    examplesForFunder,
    candidatesForFunder,
  ] = await Promise.all([
    prisma.mlShadowTrainingExample.count(),
    prisma.mlShadowTrainingExample.count({ where: { createdAt: { gte: w5m } } }),
    prisma.mlShadowTrainingExample.count({ where: { createdAt: { gte: w30m } } }),
    prisma.mlShadowTrainingExample.count({ where: { createdAt: { gte: w24h } } }),
    prisma.mlShadowTrainingExample.count({ where: { createdAt: { gte: w7d } } }),
    prisma.mlShadowTrainingExample.count({ where: { labelGoodDecision: { not: null } } }),
    prisma.mlShadowTrainingExample.count({ where: { labelGoodDecision12h: { not: null } } }),
    prisma.mlShadowTrainingExample.count({ where: { labelGoodDecision6h: { not: null } } }),
    prisma.mlShadowTrainingExample.count({ where: { labelMissedOpportunity: { not: null } } }),
    prisma.shadowCandidate.count(),
    prisma.shadowCandidate.count({ where: { evaluatedAt: { not: null } } }),
    prisma.shadowCandidate.count({
      where: { evaluatedAt: null, createdAt: { lte: evalCutoff } },
    }),
    prisma.shadowCandidate.count({
      where: { evaluatedAt: { not: null }, outcomeClassification: null },
    }),
    credsFunder
      ? prisma.mlShadowTrainingExample.count({ where: { funderAddress: credsFunder.toLowerCase() } })
      : Promise.resolve(0),
    credsFunder
      ? prisma.shadowCandidate.count({ where: { funderAddress: credsFunder.toLowerCase() } })
      : Promise.resolve(0),
  ]);

  const [shadowEval7d, datasetBuild7d, shadowEval24h, datasetBuild24h] = await Promise.all([
    jobEvidence("shadow_evaluation", 7 * 24 * 60 * 60 * 1000),
    jobEvidence("ml_shadow_dataset_build", 7 * 24 * 60 * 60 * 1000),
    jobEvidence("shadow_evaluation", 24 * 60 * 60 * 1000),
    jobEvidence("ml_shadow_dataset_build", 24 * 60 * 60 * 1000),
  ]);

  const funderMismatchSignal =
    !!credsFunder &&
    totalShadowCandidates > 10 &&
    candidatesForFunder === 0 &&
    totalExamples > 0;

  const { diagnosis, rationale } = classifyNullLabelDiagnosis({
    totalExamples,
    labelGoodDecisionPopulated: labelGdPopulated,
    labelGoodDecision12hPopulated: labelGd12Populated,
    unevaluatedOldEnough: unevaluatedOldEnough,
    evaluatedWithNullOutcome: evaluatedNullOutcome,
    shadowEvalRuns7d: shadowEval7d.runsInWindow,
    datasetBuildRuns7d: datasetBuild7d.runsInWindow,
    funderMismatchSignal,
  });

  const stages = [
    {
      stage: "ShadowCandidate write",
      module: "lib/shadow-telemetry/record.ts",
      function: "recordShadowCandidate",
      expected: "Runtime/paper paths persist candidates",
      observed: `totalShadowCandidates=${totalShadowCandidates}`,
      health: totalShadowCandidates > 0 ? "healthy" : "missing",
    },
    {
      stage: "Post-trade evaluation (24h markout + outcomeClassification)",
      module: "lib/shadow-evaluation/evaluate.ts",
      function: "evaluateShadowCandidates",
      expected: "Sets evaluatedAt; sets outcomeClassification when markout24h computable",
      observed: `evaluated=${evaluatedCandidates}, unevaluatedAge>=25h=${unevaluatedOldEnough}, evaluatedButOutcomeNull=${evaluatedNullOutcome}`,
      health:
        shadowEval7d.failureCount > shadowEval7d.successCount && shadowEval7d.runsInWindow > 0
          ? "failing"
          : shadowEval7d.runsInWindow === 0
            ? "stale_or_absent"
            : "ok",
    },
    {
      stage: "ML example persist",
      module: "lib/ml/shadow-dataset/build.ts",
      function: "persistShadowTrainingExamples",
      expected: "evaluatedOnly default true: only ShadowCandidate.evaluatedAt != null",
      observed: `MlShadowTrainingExample total=${totalExamples}, labelGoodDecision populated=${labelGdPopulated}`,
      health: totalExamples > 0 ? "ok" : datasetBuild7d.runsInWindow === 0 ? "missing" : "no_rows_yet",
    },
    {
      stage: "labelGoodDecision derivation",
      module: "lib/ml/shadow-dataset/build.ts",
      function: "deriveLabels(outcomeClassification, ...)",
      expected: "Non-null only when outcomeClassification from 24h classify() is set",
      observed: `populated=${labelGdPopulated} of ${totalExamples}`,
      health: labelGdPopulated > 0 ? "healthy" : totalExamples === 0 ? "n/a" : "null_labels",
    },
    {
      stage: "labelGoodDecision12h (snapshot-based at persist)",
      module: "lib/ml/shadow-dataset/build.ts",
      function: "persist loop / markout 12h",
      expected: "Set when MarketPriceSnapshot covers decision+12h",
      observed: `populated=${labelGd12Populated}`,
      health: labelGd12Populated > 0 ? "healthy" : "null_or_no_snapshots",
    },
  ];

  const report = {
    generatedAt,
    nullLabelDiagnosis: diagnosis,
    nullLabelRationale: rationale,
    credentialsFunderRedacted: redactFunder(credsFunder),
    funderScope: {
      shadowCandidatesForCredsFunder: candidatesForFunder,
      mlExamplesForCredsFunder: examplesForFunder,
      funderMismatchSignal,
    },
    inventory: {
      mlShadowTrainingExample: {
        totalRows: totalExamples,
        createdLast5m: examples5m,
        createdLast30m: examples30m,
        createdLast24h: examples24h,
        createdLast7d: examples7d,
        labelGoodDecisionPopulated: labelGdPopulated,
        labelGoodDecision12hPopulated: labelGd12Populated,
        labelGoodDecision6hPopulated: labelGd6Populated,
        labelMissedOpportunityPopulated: labelMoPopulated,
      },
      shadowCandidate: {
        total: totalShadowCandidates,
        evaluated: evaluatedCandidates,
        unevaluatedButOlderThan25h: unevaluatedOldEnough,
        evaluatedWithNullOutcomeClassification: evaluatedNullOutcome,
      },
    },
    pipelineStages: stages,
    jobEvidence: {
      shadow_evaluation: { last24h: shadowEval24h, last7d: shadowEval7d },
      ml_shadow_dataset_build: { last24h: datasetBuild24h, last7d: datasetBuild7d },
    },
    designNotes: {
      paperTickModelRequiresTraining:
        "paper_trading_tick needs ACTIVE/APPROVED shadow model; training requires labeled MlShadowTrainingExample rows.",
      labelGoodDecisionSemantics:
        "Requires evaluateShadowCandidates to produce markout24h and outcomeClassification (good_allow | bad_allow | good_block | bad_block).",
      labelGoodDecision12hSemantics:
        "Computed at dataset persist from 12h MarketPriceSnapshot markout; can be populated when 24h classification is still null.",
      scheduledJobs: "shadow_evaluation and ml_shadow_dataset_build (lib/ops/scheduled-jobs.ts); default intervals 6h.",
    },
    recommendedOperatorActions: [
      "Ensure market_snapshot_capture / snapshots exist for candidate markets (24h and 12h horizons).",
      "Run or wait for shadow_evaluation (evaluates candidates >= 25h old).",
      "POST /api/ops/ml-shadow-dataset body {} to persist examples (evaluatedOnly true by default).",
      "If labelGoodDecision remains null but labelGoodDecision12h has rows: npx tsx tools/train-shadow-model.ts --target labelGoodDecision12h",
      "Activate model after train: POST /api/ml/activate-latest-shadow",
    ],
    codeFixesThisPass: {
      description:
        "Observability: shadow training data report; trainShadowModel hints when labelGoodDecision empty but labelGoodDecision12h trainable; JSDoc fix for evaluatedOnly.",
      files: [
        "tools/create-shadow-training-data-report.ts",
        "lib/ml/shadow-train/train.ts",
        "lib/ml/shadow-dataset/types.ts",
        "package.json",
      ],
    },
  };

  const jsonPath = path.join(DUMP_DIR, "shadow-training-data-report.json");
  const mdPath = path.join(DUMP_DIR, "shadow-training-data-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Shadow training data report");
  md.push("");
  md.push(`Generated: ${generatedAt}`);
  md.push("");
  md.push("## Null-label diagnosis");
  md.push("");
  md.push(`**${diagnosis}**`);
  md.push("");
  for (const x of rationale) md.push(`- ${x}`);
  md.push("");
  md.push("## MlShadowTrainingExample inventory");
  md.push("");
  md.push("| Metric | Count |");
  md.push("| --- | ---: |");
  md.push(`| Total rows | ${totalExamples} |`);
  md.push(`| Created (5m / 30m / 24h / 7d) | ${examples5m} / ${examples30m} / ${examples24h} / ${examples7d} |`);
  md.push(`| labelGoodDecision populated | ${labelGdPopulated} |`);
  md.push(`| labelGoodDecision12h populated | ${labelGd12Populated} |`);
  md.push("");
  md.push("## ShadowCandidate inventory");
  md.push("");
  md.push(`- Total: **${totalShadowCandidates}**`);
  md.push(`- Evaluated: **${evaluatedCandidates}**`);
  md.push(`- Unevaluated and ≥25h old: **${unevaluatedOldEnough}**`);
  md.push(`- Evaluated but outcomeClassification null: **${evaluatedNullOutcome}**`);
  md.push("");
  md.push("## Job evidence (bounded)");
  md.push("");
  md.push("### shadow_evaluation (7d)");
  md.push(`- Runs: ${shadowEval7d.runsInWindow}, success: ${shadowEval7d.successCount}, failure: ${shadowEval7d.failureCount}`);
  md.push("### ml_shadow_dataset_build (7d)");
  md.push(`- Runs: ${datasetBuild7d.runsInWindow}, success: ${datasetBuild7d.successCount}, failure: ${datasetBuild7d.failureCount}`);
  md.push("");
  md.push("## Pipeline stages");
  md.push("");
  for (const s of stages) {
    md.push(`### ${s.stage}`);
    md.push(`- **${s.module}** \`${s.function}\``);
    md.push(`- Observed: ${s.observed}`);
    md.push(`- Health: **${s.health}**`);
    md.push("");
  }
  md.push("## Recommended next steps");
  md.push("");
  for (const a of report.recommendedOperatorActions) md.push(`- ${a}`);
  md.push("");

  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
