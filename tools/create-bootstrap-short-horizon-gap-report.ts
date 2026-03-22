import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "bootstrap-short-horizon-gap-report.json");
const MD_PATH = path.join(DUMP_DIR, "bootstrap-short-horizon-gap-report.md");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  try {
    const now = Date.now();
    const t6h = new Date(now - 6 * 60 * 60 * 1000);
    const t12h = new Date(now - 12 * 60 * 60 * 1000);
    const recentUpdateCutoff = new Date(now - 60 * 60 * 1000);

    const [
      matured6hCandidates,
      matured12hCandidates,
      candidatesWithMarkout6h,
      examplesTotal,
      label6hNonNull,
      label12hNonNull,
      examplesWithMarkout6hButLabel6hNull,
      examplesWithMarkout12hButLabel12hNull,
      recent6hLabeled,
      recent12hLabeled,
      recent6hSamples,
      recent12hSamples,
    ] = await Promise.all([
      prisma.shadowCandidate.count({ where: { createdAt: { lte: t6h } } }),
      prisma.shadowCandidate.count({ where: { createdAt: { lte: t12h } } }),
      prisma.shadowCandidate.count({ where: { markout6h: { not: null } } }),
      prisma.mlShadowTrainingExample.count(),
      prisma.mlShadowTrainingExample.count({ where: { labelGoodDecision6h: { not: null } } }),
      prisma.mlShadowTrainingExample.count({ where: { labelGoodDecision12h: { not: null } } }),
      prisma.mlShadowTrainingExample.count({
        where: { markout6h: { not: null }, labelGoodDecision6h: null },
      }),
      prisma.mlShadowTrainingExample.count({
        where: { markout12h: { not: null }, labelGoodDecision12h: null },
      }),
      prisma.mlShadowTrainingExample.count({
        where: { labelGoodDecision6h: { not: null }, updatedAt: { gte: recentUpdateCutoff } },
      }),
      prisma.mlShadowTrainingExample.count({
        where: { labelGoodDecision12h: { not: null }, updatedAt: { gte: recentUpdateCutoff } },
      }),
      prisma.mlShadowTrainingExample.findMany({
        where: { labelGoodDecision6h: { not: null }, updatedAt: { gte: recentUpdateCutoff } },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { id: true, shadowCandidateId: true, markout6h: true, labelGoodDecision6h: true, updatedAt: true },
      }),
      prisma.mlShadowTrainingExample.findMany({
        where: { labelGoodDecision12h: { not: null }, updatedAt: { gte: recentUpdateCutoff } },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: {
          id: true,
          shadowCandidateId: true,
          markout12h: true,
          labelGoodDecision12h: true,
          updatedAt: true,
        },
      }),
    ]);

    const report = {
      generatedAt,
      exactRootCause:
        "Short-horizon labels were not fully persisted: create path did not write labelGoodDecision6h, and existing MlShadowTrainingExample rows were skipped entirely (no update path), leaving legacy rows permanently null for 6h/12h labels.",
      filesAndFunctionsInvolved: [
        "lib/ml/shadow-dataset/build.ts#persistShadowTrainingExamples",
        "lib/ml/shadow-dataset/build.ts#buildShadowTrainingRow",
        "lib/shadow-evaluation/evaluate.ts#evaluateShadowCandidates",
      ],
      beforeAfterBehavior: {
        before: {
          createPath6h: "labelGoodDecision6h not written on create",
          createPath12h: "labelGoodDecision12h written only when 12h snapshots available",
          existingRows: "duplicate shadowCandidateId rows skipped; short-horizon labels never backfilled",
        },
        after: {
          createPath6h: "labelGoodDecision6h derived from markout6h and persisted on create",
          createPath12h: "labelGoodDecision12h persisted as before when computable",
          existingRows:
            "existing rows are updated for missing short-horizon fields (labelGoodDecision6h/12h and markout12h) when computable",
        },
      },
      invariantsPreserved: [
        "No fabricated labels: labels are markout/snapshot-derived only.",
        "No live-trading behavior changes.",
        "No bootstrap activation threshold changes.",
        "No fallback target policy changes.",
      ],
      evidenceCounts: {
        shadowCandidatesMaturedByAge: {
          at6h: matured6hCandidates,
          at12h: matured12hCandidates,
        },
        shadowCandidatesWithMarkout6h: candidatesWithMarkout6h,
        mlShadowTrainingExample: {
          total: examplesTotal,
          labelGoodDecision6hNonNull: label6hNonNull,
          labelGoodDecision12hNonNull: label12hNonNull,
          markout6hPresentButLabel6hNull: examplesWithMarkout6hButLabel6hNull,
          markout12hPresentButLabel12hNull: examplesWithMarkout12hButLabel12hNull,
        },
        recentlyUpdatedLastHour: {
          labelGoodDecision6h: recent6hLabeled,
          labelGoodDecision12h: recent12hLabeled,
        },
      },
      sampleEvidence: {
        recent6hLabels: recent6hSamples.map((r) => ({
          id: r.id,
          shadowCandidateId: r.shadowCandidateId,
          markout6h: r.markout6h,
          labelGoodDecision6h: r.labelGoodDecision6h,
          updatedAt: r.updatedAt.toISOString(),
        })),
        recent12hLabels: recent12hSamples.map((r) => ({
          id: r.id,
          shadowCandidateId: r.shadowCandidateId,
          markout12h: r.markout12h,
          labelGoodDecision12h: r.labelGoodDecision12h,
          updatedAt: r.updatedAt.toISOString(),
        })),
      },
    };

    await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

    const md: string[] = [];
    md.push("# Bootstrap short-horizon gap report");
    md.push("");
    md.push(`Generated: ${generatedAt}`);
    md.push("");
    md.push("## Exact root cause");
    md.push(report.exactRootCause);
    md.push("");
    md.push("## Exact files/functions involved");
    for (const f of report.filesAndFunctionsInvolved) md.push(`- \`${f}\``);
    md.push("");
    md.push("## Before/after behavior");
    md.push("- Before:");
    md.push(`  - ${report.beforeAfterBehavior.before.createPath6h}`);
    md.push(`  - ${report.beforeAfterBehavior.before.createPath12h}`);
    md.push(`  - ${report.beforeAfterBehavior.before.existingRows}`);
    md.push("- After:");
    md.push(`  - ${report.beforeAfterBehavior.after.createPath6h}`);
    md.push(`  - ${report.beforeAfterBehavior.after.createPath12h}`);
    md.push(`  - ${report.beforeAfterBehavior.after.existingRows}`);
    md.push("");
    md.push("## Invariants preserved");
    for (const i of report.invariantsPreserved) md.push(`- ${i}`);
    md.push("");
    md.push("## Evidence counts");
    md.push(`- Matured candidates (6h/12h): **${matured6hCandidates} / ${matured12hCandidates}**`);
    md.push(`- ShadowCandidate with markout6h: **${candidatesWithMarkout6h}**`);
    md.push(`- MlShadowTrainingExample total: **${examplesTotal}**`);
    md.push(`- labelGoodDecision6h non-null: **${label6hNonNull}**`);
    md.push(`- labelGoodDecision12h non-null: **${label12hNonNull}**`);
    md.push(`- markout6h present but label6h null: **${examplesWithMarkout6hButLabel6hNull}**`);
    md.push(`- markout12h present but label12h null: **${examplesWithMarkout12hButLabel12hNull}**`);
    md.push(`- Recent updates (last hour) 6h/12h labels: **${recent6hLabeled} / ${recent12hLabeled}**`);
    md.push("");
    md.push("## Sample evidence");
    md.push("```json");
    md.push(
      JSON.stringify(
        {
          recent6hLabels: report.sampleEvidence.recent6hLabels,
          recent12hLabels: report.sampleEvidence.recent12hLabels,
        },
        null,
        2
      )
    );
    md.push("```");
    md.push("");

    await fs.writeFile(MD_PATH, md.join("\n"), "utf8");
    console.log(`Wrote ${JSON_PATH}`);
    console.log(`Wrote ${MD_PATH}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await fs.writeFile(
      JSON_PATH,
      JSON.stringify(
        {
          generatedAt,
          error: err,
          verdict: "unable_to_generate_db_backed_gap_report",
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      MD_PATH,
      `# Bootstrap short-horizon gap report\n\nGenerated: ${generatedAt}\n\n- Error: ${err}\n`,
      "utf8"
    );
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

