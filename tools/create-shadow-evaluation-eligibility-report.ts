/**
 * Bounded audit: why shadow_evaluation may select zero ShadowCandidate rows.
 *
 * Writes:
 * - dump/shadow-evaluation-eligibility-report.json
 * - dump/shadow-evaluation-eligibility-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const MIN_AGE_MS_DEFAULT = 25 * 60 * 60 * 1000;

type RootCauseClassification =
  | "LEGITIMATE_NO_MATURE_CANDIDATES"
  | "EVALUATION_QUERY_FILTER_BUG"
  | "TIME_WINDOW_MISMATCH"
  | "FUNDER_SCOPE_MISMATCH"
  | "SNAPSHOT_PREREQUISITE_MISSING"
  | "OTHER_BUG";

function since(ms: number): Date {
  return new Date(Date.now() - ms);
}

async function jobEvidence(jobName: string, windowMs: number) {
  const gte = since(windowMs);
  const runs = await prisma.scheduledJobRun.findMany({
    where: { jobName, startedAt: { gte } },
    orderBy: { startedAt: "desc" },
    take: 12,
    select: {
      status: true,
      startedAt: true,
      durationMs: true,
      errorMessage: true,
      metadataJson: true,
    },
  });
  return {
    windowHours: Math.round(windowMs / 3600000),
    runCount: runs.length,
    successCount: runs.filter((r) => r.status === "success").length,
    failureCount: runs.filter((r) => r.status === "failure").length,
    recent: runs.slice(0, 5).map((r) => ({
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      durationMs: r.durationMs,
      errorExcerpt: r.errorMessage ? String(r.errorMessage).slice(0, 160) : null,
    })),
  };
}

function classify(input: {
  totalUnevaluated: number;
  eligiblePrisma: number;
  eligibleRaw: number;
  oldestUnevaluatedCreatedAt: Date | null;
  cutoff: Date;
  prismaRawMismatch: boolean;
  anyRowCreatedAtFuture: boolean;
}): { rootCause: RootCauseClassification; rationale: string[]; eliminatingClause: string } {
  const r: string[] = [];
  const {
    totalUnevaluated,
    eligiblePrisma,
    eligibleRaw,
    oldestUnevaluatedCreatedAt,
    cutoff,
    prismaRawMismatch,
    anyRowCreatedAtFuture,
  } = input;

  if (prismaRawMismatch) {
    r.push(`Prisma count (${eligiblePrisma}) differs from raw SQL count (${eligibleRaw}) for the same predicate.`);
    return {
      rootCause: "EVALUATION_QUERY_FILTER_BUG",
      rationale: r,
      eliminatingClause: "Prisma vs raw COUNT mismatch on (evaluatedAt IS NULL AND createdAt <= cutoff)",
    };
  }

  if (anyRowCreatedAtFuture) {
    r.push("Some ShadowCandidate.createdAt values are in the future relative to server now(); age windows are unreliable.");
    return {
      rootCause: "TIME_WINDOW_MISMATCH",
      rationale: r,
      eliminatingClause: "createdAt > now() breaks lte(cutoff) semantics until wall clock catches up",
    };
  }

  if (totalUnevaluated === 0) {
    r.push("No rows with evaluatedAt IS NULL.");
    return {
      rootCause: "OTHER_BUG",
      rationale: r,
      eliminatingClause: "evaluatedAt IS NULL is false for all rows (or table empty)",
    };
  }

  if (oldestUnevaluatedCreatedAt != null && oldestUnevaluatedCreatedAt.getTime() > cutoff.getTime()) {
    r.push(
      `Oldest unevaluated row createdAt=${oldestUnevaluatedCreatedAt.toISOString()} is NEWER than cutoff=${cutoff.toISOString()} (now - 25h).`
    );
    r.push("Therefore every unevaluated row is younger than minAgeMs; findMany correctly returns 0 rows.");
    return {
      rootCause: "LEGITIMATE_NO_MATURE_CANDIDATES",
      rationale: r,
      eliminatingClause: "createdAt <= cutoff (none of the unevaluated rows satisfy this)",
    };
  }

  if (eligibleRaw > 0) {
    r.push(`Eligible rows exist (${eligibleRaw}); evaluateShadowCandidates should select up to limit per run.`);
    return {
      rootCause: "OTHER_BUG",
      rationale: r,
      eliminatingClause: "none — batch predicate should match at least one row; investigate job execution / DB replica lag",
    };
  }

  if (oldestUnevaluatedCreatedAt != null && oldestUnevaluatedCreatedAt.getTime() <= cutoff.getTime()) {
    r.push(
      "Oldest unevaluated is older than cutoff but eligible count is 0 — inconsistent; check DB/clock or partial indexes."
    );
    return {
      rootCause: "EVALUATION_QUERY_FILTER_BUG",
      rationale: r,
      eliminatingClause: "Logical inconsistency between aggregate min(createdAt) and COUNT(eligible)",
    };
  }

  r.push("Unable to attribute; inspect aggregates.");
  return {
    rootCause: "OTHER_BUG",
    rationale: r,
    eliminatingClause: "unknown",
  };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const minAgeMs = MIN_AGE_MS_DEFAULT;
  const cutoff = new Date(Date.now() - minAgeMs);
  const t12 = since(12 * 60 * 60 * 1000);
  const t24 = since(24 * 60 * 60 * 1000);

  const [
    total,
    evaluatedNotNull,
    unevaluated,
    olderThan12hAny,
    olderThan24hAny,
    olderThan25hAny,
    unevalOlder12h,
    unevalOlder24h,
    unevalOlder25h,
    eligiblePrisma,
    aggUneval,
    snapshotsLast30d,
    futureCreatedAtCount,
  ] = await Promise.all([
    prisma.shadowCandidate.count(),
    prisma.shadowCandidate.count({ where: { evaluatedAt: { not: null } } }),
    prisma.shadowCandidate.count({ where: { evaluatedAt: null } }),
    prisma.shadowCandidate.count({ where: { createdAt: { lte: t12 } } }),
    prisma.shadowCandidate.count({ where: { createdAt: { lte: t24 } } }),
    prisma.shadowCandidate.count({ where: { createdAt: { lte: cutoff } } }),
    prisma.shadowCandidate.count({
      where: { evaluatedAt: null, createdAt: { lte: t12 } },
    }),
    prisma.shadowCandidate.count({
      where: { evaluatedAt: null, createdAt: { lte: t24 } },
    }),
    prisma.shadowCandidate.count({
      where: { evaluatedAt: null, createdAt: { lte: cutoff } },
    }),
    prisma.shadowCandidate.count({
      where: { evaluatedAt: null, createdAt: { lte: cutoff } },
    }),
    prisma.shadowCandidate.aggregate({
      where: { evaluatedAt: null },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
    prisma.marketPriceSnapshot.count({
      where: { capturedAt: { gte: since(30 * 24 * 60 * 60 * 1000) } },
    }),
    prisma.shadowCandidate.count({ where: { createdAt: { gt: new Date() } } }),
  ]);

  let eligibleRaw = 0;
  let rawSqlError: string | null = null;
  try {
    const rows = await prisma.$queryRaw<[{ c: bigint }]>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS c
        FROM "ShadowCandidate"
        WHERE "evaluatedAt" IS NULL AND "createdAt" <= ${cutoff}
      `
    );
    eligibleRaw = Number(rows[0]?.c ?? BigInt(0));
  } catch (e) {
    eligibleRaw = -1;
    rawSqlError = e instanceof Error ? e.message : String(e);
  }

  const prismaRawMismatch = eligibleRaw >= 0 && eligibleRaw !== eligiblePrisma;

  const sourceUneval = await prisma.shadowCandidate.groupBy({
    by: ["candidateSource"],
    where: { evaluatedAt: null },
    _count: true,
    orderBy: { _count: { candidateSource: "desc" } },
    take: 30,
  });

  const sourceEligible = await prisma.shadowCandidate.groupBy({
    by: ["candidateSource"],
    where: { evaluatedAt: null, createdAt: { lte: cutoff } },
    _count: true,
    orderBy: { _count: { candidateSource: "desc" } },
    take: 30,
  });

  const subfilters = {
    /** Full batch predicate (same as evaluateShadowCandidates findMany) */
    evaluatedAtNull_and_createdAtLteCutoff: eligiblePrisma,
    evaluatedAtNull_only: unevaluated,
    createdAtLteCutoff_any: olderThan25hAny,
    evaluatedAtNull_and_createdAtLte12h: unevalOlder12h,
    evaluatedAtNull_and_createdAtLte24h: unevalOlder24h,
    evaluatedAtNull_and_createdAtLte25hCutoff: unevalOlder25h,
  };

  const { rootCause, rationale, eliminatingClause } = classify({
    totalUnevaluated: unevaluated,
    eligiblePrisma,
    eligibleRaw,
    oldestUnevaluatedCreatedAt: aggUneval._min.createdAt,
    cutoff,
    prismaRawMismatch,
    anyRowCreatedAtFuture: futureCreatedAtCount > 0,
  });

  const exactQuery = {
    module: "lib/shadow-evaluation/evaluate.ts",
    function: "evaluateShadowCandidates",
    prismaWhere: {
      evaluatedAt: null,
      createdAt: { lte: "new Date(Date.now() - minAgeMs)" },
    },
    orderBy: { createdAt: "asc" },
    takeDefault: 100,
    exclusionsExplicitlyNotInQuery: [
      "candidateSource",
      "funderAddress",
      "wasBlocked",
      "MarketPriceSnapshot existence",
    ],
    scheduledJob: "lib/ops/scheduled-jobs.ts → case \"shadow_evaluation\"",
    envOverrides:
      "SHADOW_EVAL_MIN_AGE_MS (optional ms, 0..1y), SHADOW_EVAL_LIMIT (optional 1..5000). Invalid/unset → defaults.",
    whichClauseEliminatesRowsWhenBatchIsEmpty: eliminatingClause,
  };

  const report = {
    generatedAt,
    rootCauseClassification: rootCause,
    rootCauseRationale: rationale,
    serverTime: new Date().toISOString(),
    eligibilityConstants: {
      minAgeMsDefault: minAgeMs,
      cutoffIso: cutoff.toISOString(),
      horizon24hMs: 24 * 60 * 60 * 1000,
      note: "25h min age is intentional so 24h markout time exists before evaluation.",
    },
    inventory: {
      totalShadowCandidates: total,
      evaluatedAtNonNull: evaluatedNotNull,
      evaluatedAtNull: unevaluated,
      createdAtFutureVsNow: futureCreatedAtCount,
      createdAtOlderThan12h_any: olderThan12hAny,
      createdAtOlderThan24h_any: olderThan24hAny,
      createdAtOlderThan25hCutoff_any: olderThan25hAny,
      unevaluated_createdAtOlderThan12h: unevalOlder12h,
      unevaluated_createdAtOlderThan24h: unevalOlder24h,
      unevaluated_createdAtOlderThan25hCutoff: unevalOlder25h,
      eligibleBatchPrisma: eligiblePrisma,
      eligibleBatchRawSql: eligibleRaw,
      rawSqlError,
      prismaVsRawEligibleMatch: !prismaRawMismatch && eligibleRaw >= 0,
      unevaluatedCreatedAtMin: aggUneval._min.createdAt?.toISOString() ?? null,
      unevaluatedCreatedAtMax: aggUneval._max.createdAt?.toISOString() ?? null,
      candidateSource_unevaluated_top: sourceUneval.map((g) => ({
        candidateSource: g.candidateSource,
        count: g._count,
      })),
      candidateSource_eligibleBatch_top: sourceEligible.map((g) => ({
        candidateSource: g.candidateSource,
        count: g._count,
      })),
      subfilters,
    },
    exactEvaluationQueryAttribution: exactQuery,
    snapshotPrerequisites: {
      marketPriceSnapshotsLast30d: snapshotsLast30d,
      loadPhase:
        "Candidates are loaded with only evaluatedAt/createdAt filters. Snapshots are read per row in getPriceAt after load.",
      classificationVsEvaluatedAt:
        "evaluateShadowCandidates sets evaluatedAt even when outcomeClassification is null (e.g. no_decision_price or missing m24h data per classify).",
      emptyBatchDueToSnapshots: false,
      note: "Lack of MarketPriceSnapshot does not prevent a row from being selected for evaluation.",
    },
    jobEvidence: {
      shadow_evaluation: await jobEvidence("shadow_evaluation", 7 * 24 * 60 * 60 * 1000),
      ml_shadow_dataset_build: await jobEvidence("ml_shadow_dataset_build", 7 * 24 * 60 * 60 * 1000),
    },
    codeReferences: {
      evaluateShadowCandidates: "lib/shadow-evaluation/evaluate.ts",
      scheduledShadowEvaluation: "lib/ops/scheduled-jobs.ts (shadow_evaluation)",
      persistDataset: "lib/ml/shadow-dataset/build.ts (evaluatedOnly uses evaluatedAt != null)",
    },
    fixesThisPass: {
      description:
        "Optional SHADOW_EVAL_MIN_AGE_MS / SHADOW_EVAL_LIMIT for bounded ops recovery; eligibility report tool. No fabricated labels.",
      files: [
        "lib/ops/scheduled-jobs.ts",
        "tools/create-shadow-evaluation-eligibility-report.ts",
        "package.json",
      ],
    },
  };

  const jsonPath = path.join(DUMP_DIR, "shadow-evaluation-eligibility-report.json");
  const mdPath = path.join(DUMP_DIR, "shadow-evaluation-eligibility-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Shadow evaluation eligibility report");
  md.push("");
  md.push(`Generated: ${generatedAt}`);
  md.push("");
  md.push("## Root cause");
  md.push("");
  md.push(`**${rootCause}**`);
  for (const line of rationale) md.push(`- ${line}`);
  md.push("");
  md.push(`**Eliminating clause (when batch empty):** ${eliminatingClause}`);
  md.push("");
  md.push("## Key counts");
  md.push("");
  md.push(`| Metric | Value |`);
  md.push(`| --- | ---: |`);
  md.push(`| Total ShadowCandidate | ${total} |`);
  md.push(`| evaluatedAt set | ${evaluatedNotNull} |`);
  md.push(`| evaluatedAt null | ${unevaluated} |`);
  md.push(`| Unevaluated ∧ createdAt ≤ now−12h | ${unevalOlder12h} |`);
  md.push(`| Unevaluated ∧ createdAt ≤ now−24h | ${unevalOlder24h} |`);
  md.push(`| Unevaluated ∧ createdAt ≤ now−25h (cutoff) | ${unevalOlder25h} |`);
  md.push(`| **Eligible batch** (Prisma) | ${eligiblePrisma} |`);
  md.push(`| **Eligible batch** (raw SQL) | ${eligibleRaw} |`);
  md.push(`| Oldest unevaluated createdAt | ${report.inventory.unevaluatedCreatedAtMin ?? "—"} |`);
  md.push(`| Newest unevaluated createdAt | ${report.inventory.unevaluatedCreatedAtMax ?? "—"} |`);
  md.push(`| Cutoff (now−25h) | ${cutoff.toISOString()} |`);
  md.push(`| createdAt > now() (any row) | ${futureCreatedAtCount} |`);
  md.push("");
  md.push("## Evaluation query");
  md.push("");
  md.push("```ts");
  md.push("// lib/shadow-evaluation/evaluate.ts — evaluateShadowCandidates");
  md.push("where: { evaluatedAt: null, createdAt: { lte: cutoff } }");
  md.push("orderBy: { createdAt: 'asc' }, take: limit");
  md.push("```");
  md.push("");
  md.push("No funder or candidateSource filter on load.");
  md.push("");
  md.push("## Ops (this pass)");
  md.push("");
  md.push("- Env: `SHADOW_EVAL_MIN_AGE_MS`, `SHADOW_EVAL_LIMIT` (see scheduled-jobs).");
  md.push("- If **LEGITIMATE_NO_MATURE_CANDIDATES**: wait until unevaluated rows age past 25h, or verify `createdAt` reflects true decision time.");
  md.push("");

  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
