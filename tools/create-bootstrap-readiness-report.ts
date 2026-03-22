import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score/score-live";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "bootstrap-readiness-report.json");
const MD_PATH = path.join(DUMP_DIR, "bootstrap-readiness-report.md");
const SHADOW_MODEL_TYPE = "logistic_regression_shadow";

type Verdict = "green" | "yellow" | "red";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true";
}

async function countLabel(target: "labelGoodDecision6h" | "labelGoodDecision12h") {
  const nonNull = await prisma.mlShadowTrainingExample.count({ where: { [target]: { not: null } } });
  const pos = await prisma.mlShadowTrainingExample.count({ where: { [target]: true } });
  const neg = await prisma.mlShadowTrainingExample.count({ where: { [target]: false } });
  return { nonNull, pos, neg };
}

function asHours(ms: number): number {
  return Math.max(0, ms / (60 * 60 * 1000));
}

function isPrismaPoolExhaustion(err: string): boolean {
  return err.includes("P2024") || err.toLowerCase().includes("timed out fetching a new connection from the pool");
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  // Lightweight preflight so DB-offline cases produce operator-friendly output.
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const fallback = {
      generatedAt,
      dbReachable: false,
      blockingStage: "runtime_db",
      verdict: {
        color: "red" as Verdict,
        reason: "Runtime database is unreachable; bootstrap readiness cannot be verified from live data.",
      },
      recommendedChecks: [
        "Verify PostgreSQL is running and listening on the configured host/port.",
        "Check DATABASE_URL in .env matches the intended runtime DB.",
        "Confirm network/firewall access to the DB endpoint from this host.",
        "Run `npx prisma db pull` or a simple SQL probe to validate connectivity.",
        "If using Docker, verify DB container health and mapped port availability.",
      ],
      technicalDetails: err,
    };
    await fs.writeFile(JSON_PATH, JSON.stringify(fallback, null, 2), "utf8");
    await fs.writeFile(
      MD_PATH,
      [
        "# Bootstrap readiness report",
        "",
        `Generated: ${generatedAt}`,
        "",
        "- dbReachable: **false**",
        "- blockingStage: **runtime_db**",
        "- Verdict: **RED** - Runtime database is unreachable; bootstrap readiness cannot be verified from live data.",
        "",
        "## Recommended checks",
        "- Verify PostgreSQL is running and listening on the configured host/port.",
        "- Check `DATABASE_URL` in `.env` matches the intended runtime DB.",
        "- Confirm network/firewall access to the DB endpoint from this host.",
        "- Run `npx prisma db pull` or a simple SQL probe to validate connectivity.",
        "- If using Docker, verify DB container health and mapped port availability.",
        "",
        "## Technical details",
        "```",
        err,
        "```",
        "",
      ].join("\n"),
      "utf8"
    );
    return;
  }

  try {
    const now = Date.now();
    const t1h = new Date(now - 1 * 60 * 60 * 1000);
    const t6h = new Date(now - 6 * 60 * 60 * 1000);
    const t12h = new Date(now - 12 * 60 * 60 * 1000);
    const t24h = new Date(now - 24 * 60 * 60 * 1000);
    const t48h = new Date(now - 48 * 60 * 60 * 1000);

    const champion = await getActiveOrApprovedShadowModel();
    const coldStart = !champion;
    const allow6h = envBool("SELF_IMPROVE_BOOTSTRAP_ALLOW_6H", true);
    const minRows = envInt("SELF_IMPROVE_BOOTSTRAP_MIN_ROWS", 25);
    const minDataset = envInt("SELF_IMPROVE_BOOTSTRAP_MIN_DATASET", 25);
    const minValidation = envInt("SELF_IMPROVE_BOOTSTRAP_MIN_VALIDATION", 10);
    const minAuc = envNum("SELF_IMPROVE_BOOTSTRAP_MIN_ROC_AUC", 0.5);
    const minF1 = envNum("SELF_IMPROVE_BOOTSTRAP_MIN_F1", 0.2);

    const shadowTotal = await prisma.shadowCandidate.count();
    const b1h = await prisma.shadowCandidate.count({ where: { createdAt: { lte: t1h } } });
    const b6h = await prisma.shadowCandidate.count({ where: { createdAt: { lte: t6h } } });
    const b12h = await prisma.shadowCandidate.count({ where: { createdAt: { lte: t12h } } });
    const b24h = await prisma.shadowCandidate.count({ where: { createdAt: { lte: t24h } } });
    const b48h = await prisma.shadowCandidate.count({ where: { createdAt: { lte: t48h } } });
    const eval6hEligible = await prisma.shadowCandidate.count({ where: { createdAt: { lte: t6h }, evaluatedAt: null } });
    const eval12hEligible = await prisma.shadowCandidate.count({ where: { createdAt: { lte: t12h }, evaluatedAt: null } });
    const c6h = await countLabel("labelGoodDecision6h");
    const c12h = await countLabel("labelGoodDecision12h");

    const targetCounts = {
      labelGoodDecision12h: c12h.nonNull,
      labelGoodDecision6h: c6h.nonNull,
    };
    const recommendedBootstrapTarget =
      targetCounts.labelGoodDecision12h >= minRows
        ? "labelGoodDecision12h"
        : allow6h && targetCounts.labelGoodDecision6h >= minRows
          ? "labelGoodDecision6h"
          : null;

    const retrainDecision = !coldStart
      ? { action: "proceed", reason: "champion_mode_retrain_on_champion_target" }
      : recommendedBootstrapTarget
        ? { action: "proceed", reason: `bootstrap_target_selected:${recommendedBootstrapTarget}` }
        : {
            action: "skip",
            reason: `no_eligible_short_horizon_bootstrap_target:minRows=${minRows}:allow6h=${allow6h}`,
          };

    const allowedTargets = allow6h ? ["labelGoodDecision12h", "labelGoodDecision6h"] : ["labelGoodDecision12h"];
    const bootstrapCandidate = await prisma.mlModelRun.findFirst({
      where: {
        modelType: SHADOW_MODEL_TYPE,
        status: "TRAINED",
        targetLabel: { in: allowedTargets },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        targetLabel: true,
        trainCount: true,
        validationCount: true,
        metricsJson: true,
        createdAt: true,
      },
    });
    let activationDecision:
      | { action: "proceed"; reason: string; candidateRunId: string }
      | { action: "skip"; reason: string; candidateRunId?: string };
    if (!coldStart) {
      activationDecision = { action: "skip", reason: "champion_exists" };
    } else if (!bootstrapCandidate) {
      activationDecision = { action: "skip", reason: "no_trained_short_horizon_candidate" };
    } else {
      let rocAuc: number | null = null;
      let f1: number | null = null;
      try {
        const m = JSON.parse(bootstrapCandidate.metricsJson ?? "{}") as { rocAuc?: unknown; f1?: unknown };
        rocAuc = typeof m.rocAuc === "number" ? m.rocAuc : null;
        f1 = typeof m.f1 === "number" ? m.f1 : null;
      } catch {
        rocAuc = null;
        f1 = null;
      }
      const trainCount = bootstrapCandidate.trainCount ?? 0;
      const valCount = bootstrapCandidate.validationCount ?? 0;
      const datasetSize = trainCount + valCount;
      if (datasetSize < minDataset) {
        activationDecision = {
          action: "skip",
          reason: `dataset_below_min:${datasetSize}<${minDataset}`,
          candidateRunId: bootstrapCandidate.id,
        };
      } else if (valCount < minValidation) {
        activationDecision = {
          action: "skip",
          reason: `validation_below_min:${valCount}<${minValidation}`,
          candidateRunId: bootstrapCandidate.id,
        };
      } else if (rocAuc == null || rocAuc < minAuc) {
        activationDecision = {
          action: "skip",
          reason: `roc_auc_below_min:${rocAuc ?? "null"}<${minAuc}`,
          candidateRunId: bootstrapCandidate.id,
        };
      } else if (f1 == null || f1 < minF1) {
        activationDecision = {
          action: "skip",
          reason: `f1_below_min:${f1 ?? "null"}<${minF1}`,
          candidateRunId: bootstrapCandidate.id,
        };
      } else {
        activationDecision = {
          action: "proceed",
          reason: "eligible_for_bootstrap_approval",
          candidateRunId: bootstrapCandidate.id,
        };
      }
    }

    const activeApprovedModels = await prisma.mlModelRun.findMany({
      where: { modelType: SHADOW_MODEL_TYPE, status: { in: ["ACTIVE", "APPROVED"] } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, status: true, targetLabel: true, createdAt: true, updatedAt: true },
    });

    const youngestCandidate = await prisma.shadowCandidate.findFirst({
      where: { createdAt: { gt: t12h } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    const firstTrainable12hNow = c12h.pos >= 10 && c12h.neg >= 10;
    const etaHours = firstTrainable12hNow
      ? 0
      : youngestCandidate
        ? asHours(youngestCandidate.createdAt.getTime() + 12 * 60 * 60 * 1000 - now)
        : null;

    const maturityVsDatasetMismatch =
      b12h > 0 && c12h.nonNull === 0
        ? "matured_12h_candidates_exist_but_no_12h_dataset_labels"
        : b12h > c12h.nonNull * 2
          ? "matured_12h_backlog_significantly_exceeds_12h_dataset_rows"
          : "none_detected";

    const paperModelAvailability = {
      hasActiveOrApprovedShadowModel: !!champion,
      model: champion
        ? {
            runId: champion.run.id,
            targetLabel: champion.run.targetLabel,
            featureSetName: champion.run.featureSetName,
          }
        : null,
      failClosedGate:
        "lib/paper-trading/engine.ts#runPaperTradingTick requires ACTIVE/APPROVED from lib/ml/shadow-score/score-live.ts#getActiveOrApprovedShadowModel",
    };

    const verdict: Verdict =
      paperModelAvailability.hasActiveOrApprovedShadowModel
        ? "green"
        : retrainDecision.action === "proceed" && activationDecision.action === "proceed"
          ? "green"
          : (b12h > 0 || b6h > 0) && c12h.nonNull + c6h.nonNull < minRows
            ? "yellow"
            : "red";
    const verdictReason =
      verdict === "green"
        ? "Loop appears able to self-bootstrap from current truth/data state."
        : verdict === "yellow"
          ? "Pipeline wiring looks correct, but matured truth/label volume is currently insufficient for bootstrap thresholds."
          : "A concrete blocker remains in readiness path (target eligibility/retrain/activation).";

    const report = {
      generatedAt,
      flowAudit: {
        shadowCandidateGeneration: {
          module: "lib/shadow-telemetry/record.ts#recordShadowCandidate",
          totalCount: shadowTotal,
        },
        truthAvailability: {
          eligibleByAge: {
            at1h: b1h,
            at6h: b6h,
            at12h: b12h,
            at24h: b24h,
            at48h: b48h,
          },
          unevaluatedEligible: {
            at6h: eval6hEligible,
            at12h: eval12hEligible,
          },
        },
        datasetGeneration: {
          module: "lib/ml/shadow-dataset/build.ts#persistShadowTrainingExamples",
          targetContributions: {
            labelGoodDecision6h: c6h,
            labelGoodDecision12h: c12h,
          },
          maturityVsDatasetMismatch,
        },
        retrainEligibility: {
          module: "lib/ops/self-improvement-loop.ts#runShadowRetrainJob",
          coldStart,
          minRows,
          allow6h,
          targetCounts,
          recommendedBootstrapTarget,
          decision: retrainDecision,
        },
        bootstrapActivationEligibility: {
          module: "lib/ops/self-improvement-loop.ts#runShadowBootstrapActivationJob",
          guardrails: { minDataset, minValidation, minAuc, minF1 },
          latestCandidate: bootstrapCandidate
            ? {
                runId: bootstrapCandidate.id,
                targetLabel: bootstrapCandidate.targetLabel,
                trainCount: bootstrapCandidate.trainCount,
                validationCount: bootstrapCandidate.validationCount,
                createdAt: bootstrapCandidate.createdAt.toISOString(),
              }
            : null,
          decision: activationDecision,
        },
        paperTradingModelAvailability: paperModelAvailability,
      },
      activeApprovedShadowModels: activeApprovedModels.map((m) => ({
        runId: m.id,
        status: m.status,
        targetLabel: m.targetLabel,
        inferredHorizonHours:
          m.targetLabel === "labelGoodDecision6h"
            ? 6
            : m.targetLabel === "labelGoodDecision12h"
              ? 12
              : m.targetLabel === "labelGoodDecision24h"
                ? 24
                : null,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      })),
      timeToFirstTrainable12hEstimate: {
        trainableNowByClassBalance: firstTrainable12hNow,
        current12hPositives: c12h.pos,
        current12hNegatives: c12h.neg,
        minimumPosNegForTrainerProxy: 10,
        etaHoursFromYoungestBacklog: etaHours,
      },
      verdict: {
        color: verdict,
        reason: verdictReason,
      },
    };

    await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

    const md: string[] = [];
    md.push("# Bootstrap readiness report");
    md.push("");
    md.push(`Generated: ${generatedAt}`);
    md.push("");
    md.push("## End-to-end flow status");
    md.push(`- ShadowCandidate total: **${shadowTotal}**`);
    md.push(`- 6h truth age-eligible candidates: **${b6h}**`);
    md.push(`- 12h truth age-eligible candidates: **${b12h}**`);
    md.push(`- 6h dataset labels (non-null / pos / neg): **${c6h.nonNull} / ${c6h.pos} / ${c6h.neg}**`);
    md.push(`- 12h dataset labels (non-null / pos / neg): **${c12h.nonNull} / ${c12h.pos} / ${c12h.neg}**`);
    md.push(`- Retrain decision now: **${retrainDecision.action}** (${retrainDecision.reason})`);
    md.push(`- Bootstrap activation decision now: **${activationDecision.action}** (${activationDecision.reason})`);
    md.push(`- Paper model availability: **${paperModelAvailability.hasActiveOrApprovedShadowModel}**`);
    md.push("");
    md.push("## Age buckets");
    md.push("| Bucket | Count |");
    md.push("| --- | ---: |");
    md.push(`| >=1h | ${b1h} |`);
    md.push(`| >=6h | ${b6h} |`);
    md.push(`| >=12h | ${b12h} |`);
    md.push(`| >=24h | ${b24h} |`);
    md.push(`| >=48h | ${b48h} |`);
    md.push("");
    md.push("## Blocking reason (if any)");
    if (retrainDecision.action === "skip") md.push(`- Retrain blocker: \`${retrainDecision.reason}\``);
    if (activationDecision.action === "skip") md.push(`- Activation blocker: \`${activationDecision.reason}\``);
    if (retrainDecision.action !== "skip" && activationDecision.action !== "skip") md.push("- None.");
    md.push("");
    md.push("## Time-to-first-trainable-12h estimate");
    md.push(
      `- Trainable now (proxy, >=10 positive and >=10 negative 12h labels): **${firstTrainable12hNow}**`
    );
    md.push(`- ETA hours from current backlog timestamp: **${etaHours == null ? "n/a" : etaHours.toFixed(2)}**`);
    md.push("");
    md.push("## Maturity vs dataset mismatch");
    md.push(`- **${maturityVsDatasetMismatch}**`);
    md.push("");
    md.push("## Verdict");
    md.push(`- **${verdict.toUpperCase()}**: ${verdictReason}`);
    md.push("");

    await fs.writeFile(MD_PATH, md.join("\n"), "utf8");
    console.log(`Wrote ${JSON_PATH}`);
    console.log(`Wrote ${MD_PATH}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    if (isPrismaPoolExhaustion(err)) {
      const fallback = {
        generatedAt,
        dbReachable: true,
        blockingStage: "report_query_pool_exhaustion",
        verdict: {
          color: "red" as Verdict,
          reason: "Readiness reporting hit Prisma connection-pool timeout before completion.",
        },
        recommendedChecks: [
          "Reduce concurrent report queries (this tool now uses sequential queries).",
          "Check active DB load and long-running queries during report execution.",
          "Increase Prisma pool size/timeout only if DB capacity supports it.",
          "Run the report during lower traffic windows.",
          "Verify other services are not saturating the same DB pool.",
        ],
        technicalDetails: err,
      };
      await fs.writeFile(JSON_PATH, JSON.stringify(fallback, null, 2), "utf8");
      await fs.writeFile(
        MD_PATH,
        [
          "# Bootstrap readiness report",
          "",
          `Generated: ${generatedAt}`,
          "",
          "- dbReachable: **true**",
          "- blockingStage: **report_query_pool_exhaustion**",
          "- Verdict: **RED** - Readiness reporting hit Prisma connection-pool timeout before completion.",
          "",
          "## Recommended checks",
          "- Reduce concurrent report queries (this tool now uses sequential queries).",
          "- Check active DB load and long-running queries during report execution.",
          "- Increase Prisma pool size/timeout only if DB capacity supports it.",
          "- Run the report during lower traffic windows.",
          "- Verify other services are not saturating the same DB pool.",
          "",
          "## Technical details",
          "```",
          err,
          "```",
          "",
        ].join("\n"),
        "utf8"
      );
      return;
    }
    const fallback = {
      generatedAt,
      dbReachable: false,
      blockingStage: "runtime_db",
      error: err,
      verdict: {
        color: "red" as Verdict,
        reason: "Runtime database is unreachable; bootstrap readiness cannot be verified from live data.",
      },
      recommendedChecks: [
        "Verify PostgreSQL is running and listening on the configured host/port.",
        "Check DATABASE_URL in .env matches the intended runtime DB.",
        "Confirm network/firewall access to the DB endpoint from this host.",
        "Run `npx prisma db pull` or a simple SQL probe to validate connectivity.",
        "If using Docker, verify DB container health and mapped port availability.",
      ],
      technicalDetails: err,
    };
    await fs.writeFile(JSON_PATH, JSON.stringify(fallback, null, 2), "utf8");
    await fs.writeFile(
      MD_PATH,
      [
        "# Bootstrap readiness report",
        "",
        `Generated: ${generatedAt}`,
        "",
        "- dbReachable: **false**",
        "- blockingStage: **runtime_db**",
        "- Verdict: **RED** - Runtime database is unreachable; bootstrap readiness cannot be verified from live data.",
        "",
        "## Recommended checks",
        "- Verify PostgreSQL is running and listening on the configured host/port.",
        "- Check `DATABASE_URL` in `.env` matches the intended runtime DB.",
        "- Confirm network/firewall access to the DB endpoint from this host.",
        "- Run `npx prisma db pull` or a simple SQL probe to validate connectivity.",
        "- If using Docker, verify DB container health and mapped port availability.",
        "",
        "## Technical details",
        "```",
        err,
        "```",
        "",
      ].join("\n"),
      "utf8"
    );
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

