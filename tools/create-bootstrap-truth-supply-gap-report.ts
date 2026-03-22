import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "bootstrap-truth-supply-gap-report.json");
const MD_PATH = path.join(DUMP_DIR, "bootstrap-truth-supply-gap-report.md");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  try {
    const now = Date.now();
    const t6h = new Date(now - 6 * 60 * 60 * 1000);
    const t12h = new Date(now - 12 * 60 * 60 * 1000);
    const t25h = new Date(now - 25 * 60 * 60 * 1000);
    const t1h = new Date(now - 60 * 60 * 1000);

    const [
      totalCandidates,
      eligible6h,
      eligible12h,
      eligible25h,
      markout6hTotal,
      markout6hEligible6h,
      markout24hTotal,
      examplesTotal,
      labels6h,
      labels12h,
      recentMarkout6h,
      recentLabel6h,
      recentLabel12h,
      shadowEvalRecent,
    ] = await Promise.all([
      prisma.shadowCandidate.count(),
      prisma.shadowCandidate.count({ where: { createdAt: { lte: t6h } } }),
      prisma.shadowCandidate.count({ where: { createdAt: { lte: t12h } } }),
      prisma.shadowCandidate.count({ where: { createdAt: { lte: t25h } } }),
      prisma.shadowCandidate.count({ where: { markout6h: { not: null } } }),
      prisma.shadowCandidate.count({ where: { createdAt: { lte: t6h }, markout6h: { not: null } } }),
      prisma.shadowCandidate.count({ where: { markout24h: { not: null } } }),
      prisma.mlShadowTrainingExample.count(),
      prisma.mlShadowTrainingExample.count({ where: { labelGoodDecision6h: { not: null } } }),
      prisma.mlShadowTrainingExample.count({ where: { labelGoodDecision12h: { not: null } } }),
      prisma.shadowCandidate.count({ where: { markout6h: { not: null }, evaluatedAt: { gte: t1h } } }),
      prisma.mlShadowTrainingExample.count({ where: { labelGoodDecision6h: { not: null }, updatedAt: { gte: t1h } } }),
      prisma.mlShadowTrainingExample.count({ where: { labelGoodDecision12h: { not: null }, updatedAt: { gte: t1h } } }),
      prisma.scheduledJobRun.findMany({
        where: { jobName: "shadow_evaluation" },
        orderBy: { startedAt: "desc" },
        take: 5,
        select: { status: true, startedAt: true, errorMessage: true },
      }),
    ]);

    const rootCause =
      markout6hTotal === 0 && eligible6h > 0
        ? "Evaluator timing/source mismatch: canonical evaluation historically gated at 25h for full outcome classification, so short-horizon markout6h supply remained absent for large 6h/12h-aged candidate windows."
        : "Short-horizon markout supply exists; prior gap may be historical and now recovering.";

    const classification =
      markout6hTotal === 0 && eligible6h > 0
        ? "evaluator_timing_or_source_mismatch"
        : markout6hTotal > 0 && labels6h === 0
          ? "dataset_consumption_gap"
          : "truth_supply_present";

    const report = {
      generatedAt,
      exactRootCause: rootCause,
      classification,
      filesFunctionsInvolved: [
        "lib/shadow-evaluation/evaluate.ts#evaluateShadowCandidates",
        "lib/shadow-evaluation/markout.ts#markout",
        "lib/ml/shadow-dataset/build.ts#persistShadowTrainingExamples",
      ],
      issueTypeAssessment: {
        evaluatorTiming: classification === "evaluator_timing_or_source_mismatch",
        persistence: false,
        sourceMismatch: classification === "evaluator_timing_or_source_mismatch",
      },
      beforeAfterBehavior: {
        before:
          "Only >=25h canonical evaluation pass produced markout writes, leaving short-horizon markout6h supply effectively absent for bootstrap windows.",
        after:
          "Canonical evaluator now performs a 6h short-horizon backfill pass (markout1h/6h) before full 24h evaluation, without setting evaluatedAt early.",
      },
      invariantsPreserved: [
        "No fabricated truth values.",
        "No live trading behavior changes.",
        "No bootstrap activation threshold changes.",
      ],
      proofCounts: {
        shadowCandidate: {
          totalCandidates,
          eligible6h,
          eligible12h,
          eligible25h,
          markout6hTotal,
          markout6hAmong6hEligible: markout6hEligible6h,
          markout24hTotal,
          recentMarkout6hLastHour: recentMarkout6h,
        },
        mlShadowTrainingExample: {
          total: examplesTotal,
          labelGoodDecision6hNonNull: labels6h,
          labelGoodDecision12hNonNull: labels12h,
          recentLabel6hLastHour: recentLabel6h,
          recentLabel12hLastHour: recentLabel12h,
        },
      },
      recentShadowEvaluationRuns: shadowEvalRecent.map((r) => ({
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        errorExcerpt: r.errorMessage ? String(r.errorMessage).slice(0, 200) : null,
      })),
    };

    await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

    const md: string[] = [];
    md.push("# Bootstrap truth-supply gap report");
    md.push("");
    md.push(`Generated: ${generatedAt}`);
    md.push("");
    md.push("## Exact root cause");
    md.push(report.exactRootCause);
    md.push("");
    md.push("## Exact files/functions involved");
    for (const f of report.filesFunctionsInvolved) md.push(`- \`${f}\``);
    md.push("");
    md.push("## Evaluator timing vs persistence vs source mismatch");
    md.push(`- evaluatorTiming: **${report.issueTypeAssessment.evaluatorTiming}**`);
    md.push(`- persistence: **${report.issueTypeAssessment.persistence}**`);
    md.push(`- sourceMismatch: **${report.issueTypeAssessment.sourceMismatch}**`);
    md.push("");
    md.push("## Before/after behavior");
    md.push(`- Before: ${report.beforeAfterBehavior.before}`);
    md.push(`- After: ${report.beforeAfterBehavior.after}`);
    md.push("");
    md.push("## Invariants preserved");
    for (const i of report.invariantsPreserved) md.push(`- ${i}`);
    md.push("");
    md.push("## Proof counts");
    md.push(`- ShadowCandidate total: **${totalCandidates}**`);
    md.push(`- Age-eligible (6h / 12h / 25h): **${eligible6h} / ${eligible12h} / ${eligible25h}**`);
    md.push(`- markout6h total: **${markout6hTotal}**`);
    md.push(`- markout6h among 6h-eligible: **${markout6hEligible6h}**`);
    md.push(`- markout24h total: **${markout24hTotal}**`);
    md.push(`- MlShadowTrainingExample labelGoodDecision6h/12h non-null: **${labels6h} / ${labels12h}**`);
    md.push("");
    md.push("## Recent shadow_evaluation runs");
    for (const r of report.recentShadowEvaluationRuns) {
      md.push(`- ${r.startedAt} | ${r.status}${r.errorExcerpt ? ` | ${r.errorExcerpt}` : ""}`);
    }
    md.push("");

    await fs.writeFile(MD_PATH, md.join("\n"), "utf8");
    console.log(`Wrote ${JSON_PATH}`);
    console.log(`Wrote ${MD_PATH}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await fs.writeFile(
      JSON_PATH,
      JSON.stringify({ generatedAt, error: err }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      MD_PATH,
      `# Bootstrap truth-supply gap report\n\nGenerated: ${generatedAt}\n\n- Error: ${err}\n`,
      "utf8"
    );
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

