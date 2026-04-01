import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

const LOADER_WHERE = {
  wasSubmitted: true,
  wasBlocked: false,
  candidateSource: "runtime_automated" as const,
};

const PIPELINE_JOB_NAMES = [
  "recommendation_recompute",
  "decision_recompute",
  "position_decision_recompute",
  "paper_trading_tick",
  "stream_repair",
] as const;

function msAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

type Blocker =
  | "scheduler not firing"
  | "recommendation engine producing nothing"
  | "persistence failing"
  | "rows created but flags exclude them from loader"
  | "funder mismatch"
  | "evidence insufficient";

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();

  const windows = [
    { label: "1 min", m: 1 },
    { label: "5 min", m: 5 },
    { label: "15 min", m: 15 },
    { label: "1 hour", m: 60 },
    { label: "24 hours", m: 24 * 60 },
  ];

  const shadowWriteDisabled = process.env.SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE === "1";

  const paperState = await prisma.paperTradingState.findUnique({
    where: { id: "default" },
    select: {
      lastOpenTickAt: true,
      lastOpenTickError: true,
      updatedAt: true,
    },
  });

  const since24h = msAgo(24 * 60);
  const jobRunsRecent = await prisma.scheduledJobRun.findMany({
    where: {
      jobName: { in: [...PIPELINE_JOB_NAMES] },
      startedAt: { gte: since24h },
    },
    orderBy: { startedAt: "desc" },
    take: 200,
    select: {
      jobName: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      errorMessage: true,
    },
  });

  const jobAgg = new Map<string, { success: number; failure: number }>();
  for (const j of PIPELINE_JOB_NAMES) jobAgg.set(j, { success: 0, failure: 0 });
  for (const r of jobRunsRecent) {
    const cur = jobAgg.get(r.jobName) ?? { success: 0, failure: 0 };
    if (r.status === "success") cur.success++;
    else cur.failure++;
    jobAgg.set(r.jobName, cur);
  }

  const leases = await prisma.scheduledJobLease.findMany({
    where: { jobName: { in: [...PIPELINE_JOB_NAMES] } },
    select: {
      jobName: true,
      leasedAt: true,
      leaseExpiresAt: true,
      lastHeartbeatAt: true,
      lastRunId: true,
    },
  });

  const marketSignalCounts: { label: string; count: number }[] = [];
  const recommendationCounts: { label: string; count: number }[] = [];
  const orderIntentCounts: { label: string; count: number }[] = [];
  const shadowAnyCounts: { label: string; count: number }[] = [];
  const shadowLoaderCounts: { label: string; count: number }[] = [];

  for (const w of windows) {
    const since = msAgo(w.m);
    marketSignalCounts.push({
      label: w.label,
      count: await prisma.marketSignal.count({ where: { createdAt: { gte: since } } }),
    });
    recommendationCounts.push({
      label: w.label,
      count: await prisma.recommendation.count({ where: { createdAt: { gte: since } } }),
    });
    orderIntentCounts.push({
      label: w.label,
      count: await prisma.orderIntent.count({ where: { createdAt: { gte: since } } }),
    });
    shadowAnyCounts.push({
      label: w.label,
      count: await prisma.shadowCandidate.count({ where: { createdAt: { gte: since } } }),
    });
    shadowLoaderCounts.push({
      label: w.label,
      count: await prisma.shadowCandidate.count({ where: { ...LOADER_WHERE, createdAt: { gte: since } } }),
    });
  }

  const since1h = msAgo(60);
  const shadowCombo1h = await prisma.shadowCandidate.groupBy({
    by: ["wasSubmitted", "wasBlocked", "candidateSource"],
    where: { createdAt: { gte: since1h } },
    _count: { id: true },
  });

  const source1h = await prisma.shadowCandidate.groupBy({
    by: ["candidateSource"],
    where: { createdAt: { gte: since1h } },
    _count: { id: true },
  });

  const funder1h = await prisma.shadowCandidate.groupBy({
    by: ["funderAddress"],
    where: { createdAt: { gte: since1h } },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
    take: 15,
  });

  const newestShadow = await prisma.shadowCandidate.findFirst({
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, candidateSource: true, wasSubmitted: true, wasBlocked: true, funderAddress: true },
  });

  const since24hForFunder = msAgo(24 * 60);
  const loaderVisibleByFunder24h = await prisma.shadowCandidate.groupBy({
    by: ["funderAddress"],
    where: { ...LOADER_WHERE, createdAt: { gte: since24hForFunder } },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
    take: 12,
  });

  const recRecomputeRuns = jobRunsRecent.filter((r) => r.jobName === "recommendation_recompute").slice(0, 8);
  const paperTickRuns = jobRunsRecent.filter((r) => r.jobName === "paper_trading_tick").slice(0, 8);

  const totalRuns24h = jobRunsRecent.length;
  const recJobSuccess24h = jobAgg.get("recommendation_recompute")?.success ?? 0;
  const ms1h = marketSignalCounts.find((x) => x.label === "1 hour")?.count ?? 0;
  const rec1h = recommendationCounts.find((x) => x.label === "1 hour")?.count ?? 0;
  const oi1h = orderIntentCounts.find((x) => x.label === "1 hour")?.count ?? 0;
  const shAny1h = shadowAnyCounts.find((x) => x.label === "1 hour")?.count ?? 0;
  const shLoad1h = shadowLoaderCounts.find((x) => x.label === "1 hour")?.count ?? 0;

  let firstFailureStage: string | null = null;
  if (totalRuns24h === 0 && !paperState?.lastOpenTickAt) {
    firstFailureStage = "A — no ScheduledJobRun rows in 24h for pipeline jobs and no PaperTradingState tick timestamp";
  } else if (recJobSuccess24h === 0 && totalRuns24h > 0) {
    firstFailureStage = "A — recommendation_recompute has no successful runs in sampled 24h window";
  } else if (ms1h === 0 && rec1h === 0) {
    firstFailureStage = "B — no MarketSignal and no Recommendation rows in last 1h";
  } else if (rec1h === 0 && ms1h > 0) {
    firstFailureStage = "B — MarketSignals exist but no Recommendation rows in last 1h (recommendation build path)";
  } else if (shAny1h === 0 && (rec1h > 0 || oi1h > 0)) {
    firstFailureStage = "C — recommendations/order intents present in last 1h but zero ShadowCandidate rows (telemetry not written)";
  } else if (shAny1h > 0 && shLoad1h === 0) {
    firstFailureStage = "D — ShadowCandidate rows in last 1h but none pass loader filter (submitted/unblocked/runtime_automated)";
  } else if (shLoad1h === 0 && shadowAnyCounts.every((x) => x.count === 0)) {
    firstFailureStage = "C/D — no ShadowCandidate activity in all sampled windows";
  } else {
    firstFailureStage = "E — use blunt conclusion below";
  }

  const loaderVisible24h = await prisma.shadowCandidate.count({
    where: { ...LOADER_WHERE, createdAt: { gte: since24hForFunder } },
  });

  const auditFunder = process.env.SHADOW_AUDIT_FUNDER?.trim();
  let loaderVisibleScopedFunder1h: number | null = null;
  if (auditFunder) {
    loaderVisibleScopedFunder1h = await prisma.shadowCandidate.count({
      where: {
        ...LOADER_WHERE,
        createdAt: { gte: since1h },
        funderAddress: { equals: auditFunder, mode: "insensitive" },
      },
    });
  }

  let conclusion: Blocker = "evidence insufficient";
  if (shadowWriteDisabled) {
    conclusion = "persistence failing";
  } else if (auditFunder && loaderVisibleScopedFunder1h === 0 && shLoad1h > 0) {
    conclusion = "funder mismatch";
  } else if (totalRuns24h === 0) {
    conclusion = "scheduler not firing";
  } else if (recJobSuccess24h === 0 && (jobAgg.get("recommendation_recompute")?.failure ?? 0) > 0) {
    conclusion = "scheduler not firing";
  } else if (ms1h === 0 && rec1h === 0 && recJobSuccess24h > 0) {
    conclusion = "recommendation engine producing nothing";
  } else if (ms1h === 0 && rec1h === 0) {
    conclusion = "recommendation engine producing nothing";
  } else if (shAny1h === 0 && (rec1h > 0 || oi1h > 0)) {
    conclusion = "persistence failing";
  } else if (shAny1h > 0 && shLoad1h === 0) {
    conclusion = "rows created but flags exclude them from loader";
  } else if (shLoad1h === 0) {
    conclusion = "recommendation engine producing nothing";
  }

  const lines: string[] = [];
  lines.push("# V2 candidate pipeline blocker audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push("- Read-only: `ScheduledJobRun`, `ScheduledJobLease`, `PaperTradingState`, `MarketSignal`, `Recommendation`, `OrderIntent`, `ShadowCandidate`.");
  lines.push(
    `- Telemetry gate: \`SHADOW_CANDIDATE_RUNTIME_AUTOMATED_WRITE_DISABLE\` = **${shadowWriteDisabled ? "1 (runtime_automated writes skipped in app code)" : "unset/≠1"}** — see \`lib/shadow-telemetry/record.ts\`.`
  );
  lines.push(
    "- **Persistence path (live):** submitted intents → \`recordShadowCandidate\` in \`worker/stream-runtime.ts\` (e.g. \`order.intent.created\`) with \`wasSubmitted: true\`, \`candidateSource: runtime_automated\`."
  );
  lines.push(
    "- **Recommendations:** \`Recommendation\` rows (DB) are downstream of \`MarketSignal\`; \`recommendation_recompute\` scheduled job materializes them."
  );
  lines.push("");

  lines.push("## A. Scheduler / trigger stage");
  lines.push("### PaperTradingState (id=default)");
  lines.push("```json");
  lines.push(JSON.stringify(paperState ?? null, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### ScheduledJobRun (pipeline jobs, last 24h, newest 200 rows total)");
  lines.push(`- total sampled rows: **${totalRuns24h}**`);
  lines.push("- success / failure by job (same window):");
  lines.push("```json");
  lines.push(JSON.stringify(Object.fromEntries([...jobAgg.entries()].map(([k, v]) => [k, v])), null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### Recent `recommendation_recompute` runs (up to 8)");
  lines.push("| startedAt | status | durationMs | error |");
  lines.push("| --- | --- | ---: | --- |");
  for (const r of recRecomputeRuns) {
    const err = r.errorMessage ? r.errorMessage.slice(0, 120).replace(/\|/g, "\\|") : "";
    lines.push(
      `| ${r.startedAt.toISOString()} | ${r.status} | ${r.durationMs ?? ""} | ${err} |`
    );
  }
  lines.push("");
  lines.push("### Recent `paper_trading_tick` runs (up to 8)");
  lines.push("| startedAt | status | durationMs | error |");
  lines.push("| --- | --- | ---: | --- |");
  for (const r of paperTickRuns) {
    const err = r.errorMessage ? r.errorMessage.slice(0, 120).replace(/\|/g, "\\|") : "";
    lines.push(
      `| ${r.startedAt.toISOString()} | ${r.status} | ${r.durationMs ?? ""} | ${err} |`
    );
  }
  lines.push("");
  lines.push("### ScheduledJobLease heartbeats (pipeline jobs)");
  lines.push("```json");
  lines.push(JSON.stringify(leases, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## B. Recommendation generation stage (DB counts)");
  lines.push("### MarketSignal.createdAt");
  lines.push("| window | count |");
  lines.push("| --- | ---: |");
  for (const x of marketSignalCounts) lines.push(`| ${x.label} | ${x.count} |`);
  lines.push("");
  lines.push("### Recommendation.createdAt");
  lines.push("| window | count |");
  lines.push("| --- | ---: |");
  for (const x of recommendationCounts) lines.push(`| ${x.label} | ${x.count} |`);
  lines.push("");
  lines.push("### OrderIntent.createdAt (bridge toward runtime / intents)");
  lines.push("| window | count |");
  lines.push("| --- | ---: |");
  for (const x of orderIntentCounts) lines.push(`| ${x.label} | ${x.count} |`);
  lines.push("");

  lines.push("## C. ShadowCandidate persistence (all rows, by time)");
  lines.push("| window | any candidateSource / flags |");
  lines.push("| --- | ---: |");
  for (const x of shadowAnyCounts) lines.push(`| ${x.label} | ${x.count} |`);
  lines.push("");
  lines.push("### Last ShadowCandidate row (global)");
  lines.push("```json");
  lines.push(JSON.stringify(newestShadow ?? null, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### groupBy candidateSource (last 1h)");
  lines.push("```json");
  lines.push(JSON.stringify(source1h, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### groupBy (wasSubmitted, wasBlocked, candidateSource) — last 1h");
  lines.push("```json");
  lines.push(JSON.stringify(shadowCombo1h, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### Top funderAddress — last 1h (any flags)");
  lines.push("```json");
  lines.push(JSON.stringify(funder1h, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## D. Loader-visible subset");
  lines.push("Filter: `wasSubmitted=true` AND `wasBlocked=false` AND `candidateSource=runtime_automated`");
  lines.push("| window | count |");
  lines.push("| --- | ---: |");
  for (const x of shadowLoaderCounts) lines.push(`| ${x.label} | ${x.count} |`);
  lines.push("");
  if (auditFunder && loaderVisibleScopedFunder1h != null) {
    lines.push(
      `- loader-visible **last 1h** scoped to \`SHADOW_AUDIT_FUNDER\` (\`${auditFunder}\`): **${loaderVisibleScopedFunder1h}** (global 1h loader count: **${shLoad1h}**)`
    );
  } else {
    lines.push(
      "- Set \`SHADOW_AUDIT_FUNDER\` to test whether loader-visible rows exist for the paper tick wallet only."
    );
  }
  lines.push(`- same filter, last **24h** (all funders): **${loaderVisible24h}**`);
  lines.push("- **top funderAddress** for loader-visible rows (24h):");
  lines.push("```json");
  lines.push(JSON.stringify(loaderVisibleByFunder24h, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## E. Blocker classification");
  lines.push(`- **First empty / failing stage:** ${firstFailureStage ?? "n/a"}`);
  lines.push(`- **Blunt conclusion:** **${conclusion}**`);
  lines.push("");
  lines.push("## JSON summary");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        generatedAt,
        shadowWriteDisabled,
        paperTradingState: paperState,
        scheduledJobSuccessFailure24h: Object.fromEntries([...jobAgg.entries()]),
        firstFailureStage,
        counts: {
          marketSignal: marketSignalCounts,
          recommendation: recommendationCounts,
          orderIntent: orderIntentCounts,
          shadowAny: shadowAnyCounts,
          shadowLoaderVisible: shadowLoaderCounts,
        },
        shadowGroupingLast1h: { bySource: source1h, byFlags: shadowCombo1h, topFunders: funder1h },
        loaderVisibleLast24h: loaderVisible24h,
        shadowAuditFunder1hLoaderVisible: loaderVisibleScopedFunder1h,
        loaderVisibleByFunder24h,
        newestShadowCandidate: newestShadow,
        conclusion,
      },
      null,
      2
    )
  );
  lines.push("```");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-candidate-pipeline-blocker-audit.md");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
