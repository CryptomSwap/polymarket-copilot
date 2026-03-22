/**
 * Bootstrap 12h label coverage funnel: ShadowCandidate → truthful 12h eligibility → MlShadowTrainingExample.
 * Report-only; sequential DB queries to stay pool-safe.
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "bootstrap-12h-coverage-report.json");
const MD_PATH = path.join(DUMP_DIR, "bootstrap-12h-coverage-report.md");

const H12_MS = 12 * 60 * 60 * 1000;

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const cutoff12h = new Date(Date.now() - H12_MS);

  try {
    const shadowTotal = await prisma.shadowCandidate.count();

    const age12hPlus = await prisma.shadowCandidate.count({
      where: { createdAt: { lte: cutoff12h } },
    });

    const age12hPlusMarketAsset = await prisma.shadowCandidate.count({
      where: {
        createdAt: { lte: cutoff12h },
        marketId: { not: null },
        NOT: { marketId: "" },
      },
    });

    const age12hEvaluated = await prisma.shadowCandidate.count({
      where: {
        createdAt: { lte: cutoff12h },
        evaluatedAt: { not: null },
      },
    });

    const age12hEvaluatedMarketAsset = await prisma.shadowCandidate.count({
      where: {
        createdAt: { lte: cutoff12h },
        evaluatedAt: { not: null },
        marketId: { not: null },
        NOT: { marketId: "" },
      },
    });

    const mlTotal = await prisma.mlShadowTrainingExample.count();
    const ml12hNonNull = await prisma.mlShadowTrainingExample.count({
      where: { labelGoodDecision12h: { not: null } },
    });

    const ml12hNull = await prisma.mlShadowTrainingExample.count({
      where: { labelGoodDecision12h: null },
    });

    /** Same predicate as prefer_missing_12h_label primary selection (backlog size). */
    const backlogMissing12hRows = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c
      FROM "ShadowCandidate" sc
      LEFT JOIN "MlShadowTrainingExample" ex ON ex."shadowCandidateId" = sc.id
      WHERE sc."createdAt" <= ${cutoff12h}
        AND sc."marketId" IS NOT NULL
        AND sc."assetId" IS NOT NULL
        AND sc."marketId" != ''
        AND (ex.id IS NULL OR ex."labelGoodDecision12h" IS NULL)
    `;
    const backlogMissing12h = Number(backlogMissing12hRows[0]?.c ?? 0n);

    const backlogMissing12hEvaluatedOnlyRows = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c
      FROM "ShadowCandidate" sc
      LEFT JOIN "MlShadowTrainingExample" ex ON ex."shadowCandidateId" = sc.id
      WHERE sc."createdAt" <= ${cutoff12h}
        AND sc."marketId" IS NOT NULL
        AND sc."assetId" IS NOT NULL
        AND sc."marketId" != ''
        AND sc."evaluatedAt" IS NOT NULL
        AND (ex.id IS NULL OR ex."labelGoodDecision12h" IS NULL)
    `;
    const backlogMissing12hEvaluatedOnly = Number(backlogMissing12hEvaluatedOnlyRows[0]?.c ?? 0n);
    const backlogUnevaluatedPortion = Math.max(0, backlogMissing12h - backlogMissing12hEvaluatedOnly);

    const jobLimit = (() => {
      const v = parseInt(process.env.SHADOW_DATASET_BUILD_JOB_LIMIT ?? "3000", 10);
      return Number.isFinite(v) && v > 0 ? Math.min(v, 50_000) : 3000;
    })();

    const dropReasons = [
      {
        reason: "candidate_younger_than_12h_wall_clock",
        count: Math.max(0, shadowTotal - age12hPlus),
        note: "Truthful 12h markout requires decision_time + 12h to have passed.",
      },
      {
        reason: "missing_market_or_asset_on_candidate",
        count: Math.max(0, age12hPlus - age12hPlusMarketAsset),
        note: "12h snapshot path needs marketId + assetId (and non-empty marketId).",
      },
      {
        reason: "no_ml_row_or_labelGoodDecision12h_still_null_after_persist",
        count: backlogMissing12h,
        note: "Eligible for prefer_missing_12h_label visits; snapshot gaps or prior 500-cap starvation.",
      },
      {
        reason: "shadow_candidates_with_evaluatedAt_null",
        count: backlogUnevaluatedPortion,
        note: "Most backlog rows lack evaluatedAt (24h classification pending); prefer_missing_12h primary selection still visits them for snapshot-12h labels. Sequential fill only respects evaluatedOnly.",
      },
    ];

    const bottleneck =
      backlogMissing12h > jobLimit
        ? "bounded_dataset_job_limit_plus_sequential_selection_starvation_fixed_by_prefer_missing_12h_and_higher_limit"
        : ml12hNonNull < age12hPlusMarketAsset * 0.5
          ? "snapshot_or_market_resolution_gaps_after_candidate_selection"
          : "pipeline_mostly_caught_up";

    const report = {
      generatedAt,
      modules: {
        selection: "lib/ml/shadow-dataset/select-candidates.ts#selectShadowCandidateIdsPreferMissing12hLabel",
        build: "lib/ml/shadow-dataset/build.ts#buildShadowTrainingExamples",
        scheduledJob: "lib/ops/scheduled-jobs.ts#ml_shadow_dataset_build",
      },
      env: {
        SHADOW_DATASET_BUILD_JOB_LIMIT: process.env.SHADOW_DATASET_BUILD_JOB_LIMIT ?? "(default 3000)",
        SHADOW_DATASET_CANDIDATE_SELECTION: process.env.SHADOW_DATASET_CANDIDATE_SELECTION ?? "(default prefer_missing_12h_label)",
      },
      funnel: {
        shadowCandidateTotal: shadowTotal,
        ageEligible12hPlus: age12hPlus,
        age12hPlusWithMarketAndAsset: age12hPlusMarketAsset,
        age12hPlusEvaluated: age12hEvaluated,
        age12hPlusEvaluatedWithMarketAndAsset: age12hEvaluatedMarketAsset,
        mlShadowTrainingExampleTotal: mlTotal,
        labelGoodDecision12hNonNull: ml12hNonNull,
        labelGoodDecision12hNull: ml12hNull,
        backlogCandidatesMissingTruthful12hLabel: backlogMissing12h,
        backlogMissing12hEvaluatedOnly,
        backlogUnevaluatedPortion,
      },
      topDropReasons: dropReasons.sort((a, b) => b.count - a.count),
      bottleneck,
      beforeAfter: {
        before:
          "ml_shadow_dataset_build used limit=500 and sequential oldest-first scan, revisiting the same ~500 evaluated rows each run; newer candidates never received persist/12h snapshot attempts.",
        after: `Default job limit ${jobLimit} with datasetCandidateSelection=prefer_missing_12h_label prioritizes candidates with no ML row or null labelGoodDecision12h (12h-age-eligible, market+asset present). datasetSize can exceed 500 as rows accumulate non-null 12h labels.`,
      },
      proofDatasetCanExceed500: {
        condition: backlogMissing12h > 0 || ml12hNonNull < age12hPlusMarketAsset,
        explanation:
          "If backlogMissing12h > 0, bounded runs can still add truthful 12h labels until backlog drains; raising per-run limit and de-starving selection removes the artificial ~500 cap on how many distinct candidates are visited.",
        suggestedVerificationCommand:
          "Run ml_shadow_dataset_build (or POST /api/ops/ml-shadow-dataset) twice; re-check labelGoodDecision12hNonNull and trainShadowModel datasetSize.",
      },
    };

    await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

    const md = `# Bootstrap 12h coverage report

Generated: ${generatedAt}

## Exact 12h coverage funnel

| Stage | Count |
|-------|------:|
| ShadowCandidate total | ${shadowTotal} |
| Age ≥ 12h | ${age12hPlus} |
| Age ≥ 12h + market + asset | ${age12hPlusMarketAsset} |
| Age ≥ 12h + evaluatedAt set | ${age12hEvaluated} |
| MlShadowTrainingExample total | ${mlTotal} |
| labelGoodDecision12h non-null | ${ml12hNonNull} |
| Backlog (missing 12h label, eligible) | ${backlogMissing12h} |
| Same backlog, evaluatedAt required | ${backlogMissing12hEvaluatedOnly} |
| Backlog portion with evaluatedAt null | ${backlogUnevaluatedPortion} |

## Top drop reasons (approximate counts)

${dropReasons
  .sort((a, b) => b.count - a.count)
  .map((d) => `- **${d.reason}**: ${d.count} — ${d.note}`)
  .join("\n")}

## Bottleneck

- **${bottleneck}**

## Before / after expected coverage

- **Before:** ${report.beforeAfter.before}
- **After:** ${report.beforeAfter.after}

## Proof datasetSize can grow beyond 500

- ${report.proofDatasetCanExceed500.explanation}
- Suggested check: \`${report.proofDatasetCanExceed500.suggestedVerificationCommand}\`
`;
    await fs.writeFile(MD_PATH, md, "utf8");
    console.log(`Wrote ${JSON_PATH}`);
    console.log(`Wrote ${MD_PATH}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await fs.writeFile(JSON_PATH, JSON.stringify({ generatedAt, error: err }, null, 2), "utf8");
    await fs.writeFile(MD_PATH, `# Bootstrap 12h coverage report\n\nError: ${err}\n`, "utf8");
    throw e;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
