/**
 * Shadow model activation audit for paper_trading_tick / runPaperTradingTick.
 *
 * Writes:
 * - dump/shadow-model-activation-report.json
 * - dump/shadow-model-activation-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score/score-live";

const DUMP_DIR = path.join(process.cwd(), "dump");
const SHADOW_MODEL_TYPE = "logistic_regression_shadow";
const INVENTORY_LIMIT = 40;

type RootCauseClassification =
  | "NO_SHADOW_MODEL_EXISTS"
  | "MODEL_EXISTS_BUT_NOT_ACTIVE"
  | "MODEL_LOOKUP_FILTER_BUG"
  | "MODEL_SCOPE_MISMATCH"
  | "PAPER_TICK_REQUIRES_MODEL_BY_DESIGN"
  | "SAFE_FALLBACK_PATH_NOT_USED"
  | "OTHER_BUG";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Same shape as lib/ml/shadow-score/score-live.ts parseModelFromMetricsJson */
function metricsParseable(metricsJson: string | null): boolean {
  if (!metricsJson) return false;
  try {
    const parsed = JSON.parse(metricsJson) as Record<string, unknown>;
    const coef = parsed.coefficients as number[] | undefined;
    const intercept = parsed.intercept as number | undefined;
    const means = parsed.means as number[] | undefined;
    const stds = parsed.stds as number[] | undefined;
    return (
      Array.isArray(coef) &&
      typeof intercept === "number" &&
      Array.isArray(means) &&
      Array.isArray(stds)
    );
  } catch {
    return false;
  }
}

function eligibilityForPaperTick(row: {
  modelType: string;
  status: string;
  metricsJson: string | null;
}): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (row.modelType !== SHADOW_MODEL_TYPE) {
    reasons.push(`modelType is "${row.modelType}", not ${SHADOW_MODEL_TYPE}`);
    return { eligible: false, reasons };
  }
  if (!["ACTIVE", "APPROVED"].includes(row.status)) {
    reasons.push(`status "${row.status}" not in ACTIVE|APPROVED`);
  }
  if (!row.metricsJson) {
    reasons.push("metricsJson is null");
  } else if (!metricsParseable(row.metricsJson)) {
    reasons.push("metricsJson missing coefficients/intercept/means/stds");
  }
  const eligible =
    row.modelType === SHADOW_MODEL_TYPE &&
    ["ACTIVE", "APPROVED"].includes(row.status) &&
    metricsParseable(row.metricsJson);
  if (eligible) reasons.push("eligible: ACTIVE|APPROVED shadow + parseable logistic artifact");
  return { eligible, reasons };
}

function classifyRootCause(input: {
  shadowRunCount: number;
  activeOrApprovedCount: number;
  hasParseableActiveOrApproved: boolean;
  resolverFoundModel: boolean;
}): { rootCause: RootCauseClassification; rationale: string[] } {
  const r: string[] = [];
  if (input.shadowRunCount === 0) {
    r.push("No MlModelRun rows with modelType logistic_regression_shadow.");
    return { rootCause: "NO_SHADOW_MODEL_EXISTS", rationale: r };
  }
  if (input.resolverFoundModel) {
    r.push("getActiveOrApprovedShadowModel() returned a parseable ACTIVE/APPROVED shadow run; paper_trading_tick can score candidates (subject to paper config and data).");
    return { rootCause: "PAPER_TICK_REQUIRES_MODEL_BY_DESIGN", rationale: r };
  }
  if (input.activeOrApprovedCount === 0) {
    r.push("Shadow runs exist but none have status ACTIVE or APPROVED (training persists TRAINED until activate/approve).");
    r.push("Operator action: POST /api/ml/activate-latest-shadow or POST /api/ml/approve-run { runId }.");
    return { rootCause: "MODEL_EXISTS_BUT_NOT_ACTIVE", rationale: r };
  }
  if (input.activeOrApprovedCount > 0 && !input.hasParseableActiveOrApproved) {
    r.push("ACTIVE/APPROVED shadow rows exist but none have parseable metricsJson (coefficients/intercept/means/stds).");
    return { rootCause: "MODEL_LOOKUP_FILTER_BUG", rationale: r };
  }
  r.push("Unexpected: counts suggest a parseable champion should exist but resolver returned null.");
  return { rootCause: "OTHER_BUG", rationale: r };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const paperConfig = getPaperTradingConfig();

  const state = await prisma.paperTradingState.findUnique({
    where: { id: "default" },
    select: { lastOpenTickAt: true, lastOpenTickResultJson: true, lastOpenTickError: true },
  });

  let lastTick: Record<string, unknown> | null = null;
  if (state?.lastOpenTickResultJson) {
    try {
      lastTick = asRecord(JSON.parse(state.lastOpenTickResultJson));
    } catch {
      lastTick = null;
    }
  }

  const inventory = await prisma.mlModelRun.findMany({
    where: { modelType: SHADOW_MODEL_TYPE },
    orderBy: { updatedAt: "desc" },
    take: INVENTORY_LIMIT,
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      modelType: true,
      targetLabel: true,
      featureSetName: true,
      status: true,
      trainCount: true,
      metricsJson: true,
    },
  });

  const shadowRunCount = await prisma.mlModelRun.count({
    where: { modelType: SHADOW_MODEL_TYPE },
  });

  const statusGroups = await prisma.mlModelRun.groupBy({
    by: ["status"],
    where: { modelType: SHADOW_MODEL_TYPE },
    _count: { id: true },
  });
  const statusCountMap = Object.fromEntries(statusGroups.map((g) => [g.status, g._count.id]));
  const activeOrApprovedCount =
    (statusCountMap.ACTIVE ?? 0) + (statusCountMap.APPROVED ?? 0);

  const activeOrApprovedRuns = await prisma.mlModelRun.findMany({
    where: { modelType: SHADOW_MODEL_TYPE, status: { in: ["ACTIVE", "APPROVED"] } },
    orderBy: { updatedAt: "desc" },
    take: 25,
    select: { metricsJson: true },
  });
  const hasParseableActiveOrApproved = activeOrApprovedRuns.some((row) => metricsParseable(row.metricsJson));

  const inventoryRows = inventory.map((row) => {
    const { eligible, reasons } = eligibilityForPaperTick(row);
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      modelType: row.modelType,
      targetLabel: row.targetLabel,
      featureSetName: row.featureSetName,
      status: row.status,
      trainCount: row.trainCount,
      hasMetricsJson: row.metricsJson != null,
      metricsParseable: metricsParseable(row.metricsJson),
      eligibleForPaperTradingTick: eligible,
      eligibilityNotes: reasons,
    };
  });

  const hasEligibleRow = inventoryRows.some((r) => r.eligibleForPaperTradingTick);

  const resolved = await getActiveOrApprovedShadowModel();
  const resolverFoundModel = resolved != null;

  const { rootCause, rationale } = classifyRootCause({
    shadowRunCount,
    activeOrApprovedCount,
    hasParseableActiveOrApproved,
    resolverFoundModel,
  });

  const paperTickRequirement = {
    lastOpenTickError: state?.lastOpenTickError ?? null,
    paperTradingEnabled: paperConfig.enabled,
    shadowModelRequiredForPaperTick: true,
    enforcingModule: "lib/ml/shadow-score/score-live.ts",
    enforcingFunction: "getActiveOrApprovedShadowModel",
    engineGate: "lib/paper-trading/engine.ts",
    engineGateFunction: "runPaperTradingTick — returns early before candidate load if no model",
    lookupWhereClause: {
      modelType: SHADOW_MODEL_TYPE,
      statusIn: ["ACTIVE", "APPROVED"],
      orderBy: "updatedAt desc",
      take: 25,
      note: "First row with parseable metricsJson wins (batch scan; no TRAINED fallback).",
    },
    scoreShadowCandidateGate: "scoreShadowCandidate also calls getActiveOrApprovedShadowModel",
  };

  const candidateDependency = {
    intendedDesign:
      "runPaperTradingTick loads recommendation-based candidates then scores each with scoreShadowCandidate; both require an ACTIVE/APPROVED shadow model with valid logistic coefficients in metricsJson.",
    zeroCandidatesBecauseModelFailed:
      lastTick != null &&
      typeof lastTick.candidatesLoaded === "number" &&
      (lastTick.candidatesLoaded as number) === 0 &&
      (state?.lastOpenTickError?.includes("No ACTIVE or APPROVED shadow model") ?? false),
    couldLoadCandidatesWithoutModel: false,
    safeFallbackTrainedModelInCode: false,
  };

  const report = {
    generatedAt,
    rootCauseClassification: rootCause,
    rootCauseRationale: rationale,
    paperTickModelRequirementSnapshot: paperTickRequirement,
    resolverResult: resolverFoundModel
      ? {
          ok: true,
          modelRunId: resolved!.run.id,
          targetLabel: resolved!.run.targetLabel,
          featureSetName: resolved!.run.featureSetName,
        }
      : { ok: false },
    lastPersistedPaperTick: {
      lastOpenTickAt: state?.lastOpenTickAt?.toISOString() ?? null,
      lastOpenTickError: state?.lastOpenTickError ?? null,
      summary: lastTick
        ? {
            enabled: lastTick.enabled,
            candidatesLoaded: lastTick.candidatesLoaded,
            candidatesScored: lastTick.candidatesScored,
            opened: lastTick.opened,
            errors: lastTick.errors,
          }
        : null,
    },
    shadowModelInventory: {
      totalShadowRunsInDb: shadowRunCount,
      statusCounts: statusCountMap,
      sampleLimit: INVENTORY_LIMIT,
      rows: inventoryRows,
    },
    modelLookupAttribution: {
      prismaModel: "MlModelRun",
      filtersEliminatingModels:
        shadowRunCount === 0
          ? ["no rows for modelType logistic_regression_shadow"]
          : activeOrApprovedCount === 0
            ? ["status must be ACTIVE or APPROVED (TRAINED/VALIDATED excluded)"]
            : !hasParseableActiveOrApproved
              ? ["ACTIVE/APPROVED rows lack parseable metricsJson"]
              : resolverFoundModel
                ? ["none — resolver selected a run"]
                : ["unexpected resolver miss"],
    },
    candidateLoadDependency: candidateDependency,
    coldStartNote:
      "trainShadowModel persists status TRAINED. Self-improve promote job previously required an existing champion; it now skips with a report if none. First activation is still manual: POST /api/ml/activate-latest-shadow.",
    codeFixesThisPass: {
      description:
        "Harden getActiveOrApprovedShadowModel with a batch of up to 25 ACTIVE/APPROVED runs (newest first) and first parseable metricsJson; self-improve promote skips instead of throwing when no champion.",
      files: [
        "lib/ml/shadow-score/score-live.ts",
        "lib/ops/self-improvement-loop.ts",
        "tools/create-shadow-model-activation-report.ts",
        "package.json — dump:shadow-model-activation-report",
      ],
    },
  };

  const jsonPath = path.join(DUMP_DIR, "shadow-model-activation-report.json");
  const mdPath = path.join(DUMP_DIR, "shadow-model-activation-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Shadow model activation report (paper_trading_tick)");
  md.push("");
  md.push(`Generated: ${generatedAt}`);
  md.push("");
  md.push("## Root cause (single classification)");
  md.push("");
  md.push(`**${rootCause}**`);
  md.push("");
  for (const x of rationale) md.push(`- ${x}`);
  md.push("");
  md.push("## Paper tick requirement");
  md.push("");
  md.push(`- **lastOpenTickError:** ${paperTickRequirement.lastOpenTickError ?? "—"}`);
  md.push(`- **paperTradingEnabled:** ${paperConfig.enabled}`);
  md.push(`- **Shadow model required:** ${paperTickRequirement.shadowModelRequiredForPaperTick}`);
  md.push(`- **Gate:** \`${paperTickRequirement.enforcingModule}\` → \`${paperTickRequirement.enforcingFunction}\``);
  md.push(`- **Engine:** \`${paperTickRequirement.engineGate}\` → \`${paperTickRequirement.engineGateFunction}\``);
  md.push("");
  md.push("## Resolver (current DB)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(report.resolverResult, null, 2));
  md.push("```");
  md.push("");
  md.push("## Status counts (all shadow runs in DB)");
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(statusCountMap, null, 2));
  md.push("```");
  md.push("");
  md.push("## Shadow model inventory (bounded sample)");
  md.push("");
  md.push("| id | status | target | parseable | eligible for tick |");
  md.push("| --- | --- | --- | --- | --- |");
  for (const row of inventoryRows) {
    md.push(
      `| ${row.id.slice(0, 10)}… | ${row.status} | ${row.targetLabel} | ${row.metricsParseable} | ${row.eligibleForPaperTradingTick} |`
    );
  }
  md.push("");
  md.push("## Lookup attribution");
  md.push("");
  md.push(`- Total shadow runs: **${shadowRunCount}**`);
  for (const line of report.modelLookupAttribution.filtersEliminatingModels) {
    md.push(`- ${line}`);
  }
  md.push("");
  md.push("## Candidate load dependency");
  md.push("");
  md.push(`- **Zero candidates solely due to model gate:** ${candidateDependency.zeroCandidatesBecauseModelFailed}`);
  md.push(`- **Can load candidates without model (design):** ${candidateDependency.couldLoadCandidatesWithoutModel}`);
  md.push("");
  md.push("## Fixes applied (this pass)");
  md.push("");
  for (const f of report.codeFixesThisPass.files) md.push(`- \`${f}\``);
  md.push("");

  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
