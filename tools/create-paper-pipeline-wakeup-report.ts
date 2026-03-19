/**
 * Paper + shadow pipeline wake-up report: verifies ShadowCandidate flow, blocking reasons,
 * PaperTrade / MlShadowTrainingExample recency, and worker runtime safety.
 *
 * Writes: dump/paper-pipeline-wakeup-report.json, .md
 * Run: npm run dump:paper-pipeline-wakeup-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import {
  classifyShadowBlockingReason,
  extractCanonicalWorkerRuntime,
  heartbeatIsFresh,
  runtimeBlockerDominanceInTopReasons,
} from "../lib/ops/worker-heartbeat-canonical";

const DUMP = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";

const H24_MS = 24 * 60 * 60 * 1000;
const D7_MS = 7 * H24_MS;

const RUNTIME_SAFETY_REASON_RE =
  /runtime_safety|reconciliation_drift|user_truth|exchange_truth|kill_switch|operational:.*runtime|alignment|drift_detected/i;

const POLICY_HINT_RE =
  /liquidity|crowded|spread|slippage|edge|exposure|concentration|quality|tradable|depth|freshness|guardrail|execution_quality|max_working|notional|theme|category|budget|cooldown|exploration/i;

const INFRA_HINT_RE =
  /prisma|p2024|timeout|connection|pool|database|ECONNREFUSED|fetch failed|internal error|unknown error/i;

function since(msAgo: number): Date {
  return new Date(Date.now() - msAgo);
}

function toReasonArray(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json.filter((x): x is string => typeof x === "string");
}

async function aggregateBlockingReasons(
  sinceDate: Date
): Promise<{ counts: Map<string, number>; rowsScanned: number }> {
  const counts = new Map<string, number>();
  let rowsScanned = 0;
  let lastCreatedAt = new Date(0);
  const batch = 2500;
  for (;;) {
    const rows = await prisma.shadowCandidate.findMany({
      where: {
        wasBlocked: true,
        createdAt: { gte: sinceDate, gt: lastCreatedAt },
      },
      orderBy: { createdAt: "asc" },
      take: batch,
      select: { createdAt: true, blockingReasons: true },
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      rowsScanned++;
      for (const s of toReasonArray(r.blockingReasons)) {
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    }
    lastCreatedAt = rows[rows.length - 1].createdAt;
    if (rows.length < batch) break;
  }
  return { counts, rowsScanned };
}

function topReasons(counts: Map<string, number>, n: number): { reason: string; count: number }[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([reason, count]) => ({ reason, count }));
}

function countRuntimeSafetyMentions(counts: Map<string, number>): {
  rowsWithAtLeastOne: number;
  exampleReasons: string[];
} {
  let rowsWithAtLeastOne = 0;
  const examples: string[] = [];
  for (const [reason, count] of counts) {
    if (RUNTIME_SAFETY_REASON_RE.test(reason)) {
      rowsWithAtLeastOne += count;
      if (examples.length < 12) examples.push(reason);
    }
  }
  return { rowsWithAtLeastOne, exampleReasons: examples };
}

function characterizeBlocks(
  top: { reason: string; count: number }[],
  runtimeSafetyMentionCount: number
): {
  dominant: "likely_policy" | "likely_runtime_or_infra" | "mixed" | "no_blocked_rows";
  note: string;
} {
  if (top.length === 0) {
    return {
      dominant: "no_blocked_rows",
      note: "No blocked ShadowCandidates in lookback (or blockingReasons empty).",
    };
  }
  const top3 = top.slice(0, 3);
  const policyHits = top3.filter((t) => POLICY_HINT_RE.test(t.reason)).reduce((s, t) => s + t.count, 0);
  const totalTop3 = top3.reduce((s, t) => s + t.count, 0);
  const runtimeShare = runtimeSafetyMentionCount / Math.max(1, top.reduce((s, t) => s + t.count, 0));

  if (runtimeSafetyMentionCount > 0 && runtimeShare > 0.15) {
    return {
      dominant: "likely_runtime_or_infra",
      note: "A material share of blocking reason tokens mention runtime safety / reconciliation / truth. Verify worker heartbeat runtimeSafety.state=normal.",
    };
  }
  if (policyHits / Math.max(1, totalTop3) >= 0.5) {
    return {
      dominant: "likely_policy",
      note: "Top blockers align with execution/guardrail policy (liquidity, exposure, spread, etc.), not obvious infra strings.",
    };
  }
  return {
    dominant: "mixed",
    note: "Mix of policy-style and other codes; inspect topBlockingReasons table.",
  };
}

async function shadowStats(sinceDate: Date) {
  const [total, blocked, admitted, submitted] = await Promise.all([
    prisma.shadowCandidate.count({ where: { createdAt: { gte: sinceDate } } }),
    prisma.shadowCandidate.count({ where: { createdAt: { gte: sinceDate }, wasBlocked: true } }),
    prisma.shadowCandidate.count({ where: { createdAt: { gte: sinceDate }, wasBlocked: false } }),
    prisma.shadowCandidate.count({ where: { createdAt: { gte: sinceDate }, wasSubmitted: true } }),
  ]);
  return { total, blocked, admitted, submitted };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP, { recursive: true });

  const since24 = since(H24_MS);
  const since7d = since(D7_MS);

  const [
    shadow24,
    shadow7d,
    paper24,
    paper7d,
    ml24,
    ml7d,
    paperState,
    heartbeat,
    agg24,
  ] = await Promise.all([
    shadowStats(since24),
    shadowStats(since7d),
    prisma.paperTrade.count({ where: { createdAt: { gte: since24 } } }),
    prisma.paperTrade.count({ where: { createdAt: { gte: since7d } } }),
    prisma.mlShadowTrainingExample.count({ where: { createdAt: { gte: since24 } } }),
    prisma.mlShadowTrainingExample.count({ where: { createdAt: { gte: since7d } } }),
    prisma.paperTradingState.findUnique({ where: { id: "default" } }),
    prisma.workerHeartbeat.findUnique({
      where: { workerName: WORKER_NAME },
      select: { lastSeenAt: true, metadataJson: true },
    }),
    aggregateBlockingReasons(since24),
  ]);

  const top24 = topReasons(agg24.counts, 25);
  const rsMentions = countRuntimeSafetyMentions(agg24.counts);
  const characterization = characterizeBlocks(top24, rsMentions.rowsWithAtLeastOne);

  let meta: Record<string, unknown> | null = null;
  if (heartbeat?.metadataJson) {
    try {
      meta = JSON.parse(heartbeat.metadataJson) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  const canonical = extractCanonicalWorkerRuntime(meta);
  const runtimeSafetyState = canonical.runtimeSafetyState;
  const driftDetected = canonical.driftDetected;

  const dominance = runtimeBlockerDominanceInTopReasons(top24, 5);
  const now = Date.now();
  const hbFresh = heartbeatIsFresh(heartbeat?.lastSeenAt ?? null, now, 120_000);

  let lastTick: Record<string, unknown> | null = null;
  if (paperState?.lastOpenTickResultJson) {
    try {
      lastTick = JSON.parse(paperState.lastOpenTickResultJson) as Record<string, unknown>;
    } catch {
      lastTick = null;
    }
  }

  const heartbeatStale = heartbeat?.lastSeenAt != null ? !hbFresh : null;

  /** Heartbeat + drift only (same fields all reports now read via canonical path). */
  const runtimeUnblockedHeartbeat =
    runtimeSafetyState === "normal" &&
    driftDetected !== true &&
    heartbeat?.lastSeenAt != null &&
    hbFresh;

  /** Full strict: heartbeat OK and top-5 ShadowCandidate reasons not majority truth/runtime (24h window may lag recovery). */
  const runtimeTrulyUnblockedStrict =
    runtimeUnblockedHeartbeat && !dominance.runtimeDominates;

  const runtimeLayerUnblocked = runtimeTrulyUnblockedStrict;

  const paperWaking =
    paper24 > 0 ||
    (typeof lastTick?.opened === "number" && lastTick.opened > 0) ||
    (typeof lastTick?.totalOpened === "number" && lastTick.totalOpened > 0);

  const shadowFlowing = shadow24.total > 0;

  let nextBlocker: string | null = null;
  if (!heartbeat?.lastSeenAt) {
    nextBlocker = "No worker heartbeat — worker not running or wrong WORKER_NAME / DB.";
  } else if (heartbeatStale) {
    nextBlocker = "Worker heartbeat stale (>120s) — restart or fix connectivity.";
  } else if (runtimeSafetyState && runtimeSafetyState !== "normal") {
    nextBlocker = `runtimeSafety.state=${runtimeSafetyState} (execution policy still blocks live path; paper scoring may still run).`;
  } else if (driftDetected === true) {
    nextBlocker =
      "runtimeHealth.reconciliation.driftDetected still true in heartbeat — execution policy may block.";
  } else if (!shadowFlowing) {
    nextBlocker =
      "No ShadowCandidates in last 24h — candidate/intent path not firing (recommendations, automation, or early return before recordShadowCandidate).";
  } else if (lastTick?.enabled === false) {
    nextBlocker = "Paper trading disabled in config (PaperTradingState tick shows enabled=false).";
  } else if (
    Array.isArray(lastTick?.errors) &&
    (lastTick.errors as string[]).some((e) => e.includes("No ACTIVE or APPROVED shadow model"))
  ) {
    nextBlocker = "No ACTIVE/APPROVED shadow model — run shadow train + activate before PaperTrade opens.";
  } else if (paper24 === 0 && shadow24.admitted === 0 && shadow24.blocked > 0) {
    nextBlocker =
      "Shadow candidates exist but all blocked in window — inspect topBlockingReasons; may still be execution policy or guardrails.";
  } else if (paper24 === 0 && typeof lastTick?.candidatesLoaded === "number" && lastTick.candidatesLoaded === 0) {
    nextBlocker =
      "Paper tick loads zero candidates (recommendations/decision snapshots/policy filter) — upstream staged decision pipeline.";
  } else if (paper24 === 0 && typeof lastTick?.aboveThresholdCount === "number" && lastTick.aboveThresholdCount === 0) {
    nextBlocker =
      "Candidates scored but none above threshold — model scores vs threshold/minScoreBuffer, or sparse recommendations.";
  } else if (paper24 === 0) {
    nextBlocker =
      "Paper trades still zero: check cooldowns, per-market/theme caps, dedupe, and bot budgets in last tick JSON.";
  }

  const paperLastTickMismatchNote =
    paper24 > 0 &&
    typeof lastTick?.candidatesLoaded === "number" &&
    lastTick.candidatesLoaded === 0
      ? `PaperTrades in last 24h (${paper24}) but last persisted tick had candidatesLoaded=0 — likely an empty tick between scoring windows; pipeline still produced trades earlier.`
      : null;

  const infraStringsInTop = top24.some((t) => INFRA_HINT_RE.test(t.reason));

  const pipelinePathSummary = [
    "1) **Candidate generation** — Recommendations + decision snapshots → paper engine `getPaperTradingCandidatesWithDiagnostics` / runtime order intents.",
    "2) **Staged decision policy** — Filters candidates before scoring (loadDiagnostics: afterPolicyFilter, noDecisionSnapshot, etc.).",
    "3) **Execution policy (live path)** — `evaluateExecutionPolicy` in worker after guardrails; blocks → `recordShadowCandidate` wasBlocked=true.",
    "4) **PaperTrade** — `runPaperTradingTick` (scheduled job) scores shadow model; opens row on score ≥ threshold + risk/dedupe (not gated by runtime_safety bypass).",
    "5) **ShadowCandidate** — Every runtime intent path: guardrail block, execution policy block, or allow (wasBlocked false, wasSubmitted true when reconciling).",
    "6) **MlShadowTrainingExample** — Built from evaluated ShadowCandidates (ops job `/api/ops/ml-shadow-dataset`); not on every candidate write.",
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    lookback: { hours24: 24, days7: 7 },
    pipelinePathSummary,
    runtimeTruthCanonical: {
      ...canonical,
      source:
        "workerHeartbeat.metadataJson — drift + alignment from runtimeHealth.reconciliation / runtimeHealth.metadata (not top-level meta.reconciliation).",
      heartbeatFreshUnder120s: hbFresh,
    },
    runtimeLayer: {
      workerName: WORKER_NAME,
      lastHeartbeatAt: heartbeat?.lastSeenAt?.toISOString() ?? null,
      heartbeatStale,
      runtimeSafetyState,
      driftDetected,
      reconciliationAlignmentReady: canonical.reconciliationAlignmentReady,
      appearsUnblockedForLiveExecution:
        runtimeSafetyState === "normal" && driftDetected !== true && hbFresh,
    },
    liveBlockerAnalysis24h: {
      top5Ranked: top24.slice(0, 5).map((t, i) => ({
        rank: i + 1,
        reason: t.reason,
        count: t.count,
        classification: classifyShadowBlockingReason(t.reason),
        expectedForHealthySystem:
          classifyShadowBlockingReason(t.reason) === "execution_policy"
            ? "expected_when_at_limits"
            : classifyShadowBlockingReason(t.reason) === "runtime_or_truth"
              ? "pathological_if_persistent_else_transient_truth_lag"
              : "review",
      })),
      top5RuntimeOrTruthShare: dominance.topNRuntimeShare,
      top5ExecutionPolicyShare: dominance.executionPolicyShare,
      runtimeReasonsDominateTop5: dominance.runtimeDominates,
      note: "Classifies top-5 unique blocking strings only; one row can emit multiple strings. High runtime share after heartbeat recovery often means residual 24h history.",
    },
    shadowCandidate: {
      last24h: shadow24,
      last7d: shadow7d,
      blockedVsAdmittedNote:
        "admitted = wasBlocked false (execution policy allowed). submitted = wasSubmitted true (intent reached reconciliation path).",
      topBlockingReasons24h: top24,
      blockedRowsScannedForReasons24h: agg24.rowsScanned,
      runtimeSafetyRelatedBlockingReasonOccurrences24h: rsMentions.rowsWithAtLeastOne,
      runtimeSafetyAppearsInTopBlockingReasons24h: top24.some((t) => RUNTIME_SAFETY_REASON_RE.test(t.reason)),
      runtimeSafetyExampleReasons: rsMentions.exampleReasons,
      blockCharacterization24h: characterization,
      infraLikeStringsInTop25: infraStringsInTop,
    },
    paperTrade: {
      createdLast24h: paper24,
      createdLast7d: paper7d,
    },
    mlShadowTrainingExample: {
      createdLast24h: ml24,
      createdLast7d: ml7d,
      note: "Examples are backfilled from evaluated shadow rows; low count does not mean shadow telemetry is off.",
    },
    paperTradingState: {
      lastOpenTickAt: paperState?.lastOpenTickAt?.toISOString() ?? null,
      lastOpenTickError: paperState?.lastOpenTickError ?? null,
      lastOpenTickSummary: lastTick
        ? {
            opened: lastTick.opened ?? lastTick.totalOpened,
            skipped: lastTick.skipped,
            candidatesLoaded: lastTick.candidatesLoaded,
            candidatesScored: lastTick.candidatesScored,
            aboveThresholdCount: lastTick.aboveThresholdCount,
            enabled: lastTick.enabled,
            errors: lastTick.errors,
          }
        : null,
    },
    conclusions: {
      runtimeUnblockedHeartbeatOnly: Boolean(runtimeUnblockedHeartbeat),
      runtimeTrulyUnblockedStrict: Boolean(runtimeTrulyUnblockedStrict),
      runtimeLayerTrulyUnblocked: Boolean(runtimeLayerUnblocked),
      paperTradingWakingUp: Boolean(paperWaking),
      shadowTelemetryFlowingLast24h: shadowFlowing,
      nextRemainingBlocker: nextBlocker,
      paperLastTickMismatchNote,
    },
    blockingReasonCountNote:
      "Top reason counts sum individual strings in blockingReasons JSON arrays; one ShadowCandidate row can increment several buckets.",
  };

  const jsonPath = path.join(DUMP, "paper-pipeline-wakeup-report.json");
  const mdPath = path.join(DUMP, "paper-pipeline-wakeup-report.md");

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [
    "# Paper pipeline wake-up report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Runtime truth (canonical — all reports use this path)",
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| runtimeSafety.state | ${report.runtimeTruthCanonical.runtimeSafetyState ?? "—"} |`,
    `| runtimeHealth.reconciliation.driftDetected | ${report.runtimeTruthCanonical.driftDetected ?? "—"} |`,
    `| reconciliationAlignmentReady | ${report.runtimeTruthCanonical.reconciliationAlignmentReady ?? "—"} |`,
    `| reconciliation freshness / status | ${report.runtimeTruthCanonical.reconciliationFreshness ?? "—"} / ${report.runtimeTruthCanonical.reconciliationStatus ?? "—"} |`,
    `| heartbeat fresh (<120s) | ${report.runtimeTruthCanonical.heartbeatFreshUnder120s} |`,
    "",
    "## Live blocker mix (top-5 reason strings, 24h)",
    "",
    `| top-5 runtime/truth share | ${(report.liveBlockerAnalysis24h.top5RuntimeOrTruthShare * 100).toFixed(1)}% |`,
    `| top-5 execution-policy share | ${(report.liveBlockerAnalysis24h.top5ExecutionPolicyShare * 100).toFixed(1)}% |`,
    `| runtime reasons dominate top-5 | ${report.liveBlockerAnalysis24h.runtimeReasonsDominateTop5} |`,
    "",
    `_${report.liveBlockerAnalysis24h.note}_`,
    "",
    "## Runtime layer",
    "",
    `| lastHeartbeatAt | ${report.runtimeLayer.lastHeartbeatAt ?? "—"} |`,
    `| heartbeatStale | ${String(report.runtimeLayer.heartbeatStale)} |`,
    `| **Unblocked (heartbeat+drift+fresh)** | **${report.conclusions.runtimeUnblockedHeartbeatOnly ? "yes" : "no"}** |`,
    `| **Unblocked (strict + shadow top-5)** | **${report.conclusions.runtimeTrulyUnblockedStrict ? "yes" : "no"}** |`,
    "",
    "## ShadowCandidate (telemetry path)",
    "",
    "### Last 24h",
    "",
    `| Metric | Count |`,
    `| --- | --- |`,
    `| Total | ${shadow24.total} |`,
    `| Blocked | ${shadow24.blocked} |`,
    `| Admitted (wasBlocked=false) | ${shadow24.admitted} |`,
    `| Submitted | ${shadow24.submitted} |`,
    "",
    "### Last 7d",
    "",
    `| Total | Blocked | Admitted | Submitted |`,
    `| --- | --- | --- | --- |`,
    `| ${shadow7d.total} | ${shadow7d.blocked} | ${shadow7d.admitted} | ${shadow7d.submitted} |`,
    "",
    "### Top blocking reasons (24h)",
    "",
    top24.length === 0
      ? "*(none or no blockingReasons stored)*"
      : ["| Reason | Count |", "| --- | --- |", ...top24.map((t) => `| ${t.reason.replace(/\|/g, "\\|")} | ${t.count} |`)].join(
          "\n"
        ),
    "",
    `- **Runtime safety in top-25 reasons:** ${top24.some((t) => RUNTIME_SAFETY_REASON_RE.test(t.reason)) ? "yes" : "no"}; **occurrences (24h):** ${rsMentions.rowsWithAtLeastOne}`,
    `- **Characterization:** ${characterization.dominant} — ${characterization.note}`,
    `- **Infra-like strings in top 25:** ${infraStringsInTop ? "yes (inspect)" : "no"}`,
    "",
    "## PaperTrade",
    "",
    `| Window | Created |`,
    `| --- | --- |`,
    `| 24h | ${paper24} |`,
    `| 7d | ${paper7d} |`,
    "",
    "## MlShadowTrainingExample",
    "",
    `| Window | Created |`,
    `| --- | --- |`,
    `| 24h | ${ml24} |`,
    `| 7d | ${ml7d} |`,
    "",
    report.mlShadowTrainingExample.note,
    "",
    "## Last paper tick (PaperTradingState)",
    "",
    "```json",
    JSON.stringify(report.paperTradingState, null, 2),
    "```",
    "",
    "## Pipeline path (reference)",
    "",
    ...pipelinePathSummary.map((l) => `- ${l}`),
    "",
    "## Conclusions",
    "",
    `1. **Runtime unblocked (heartbeat):** ${report.conclusions.runtimeUnblockedHeartbeatOnly ? "yes" : "no"}; **strict (+ shadow top-5 not runtime-dominated):** ${report.conclusions.runtimeTrulyUnblockedStrict ? "yes" : "no"}`,
    `2. **Paper trading waking up:** ${report.conclusions.paperTradingWakingUp ? "yes" : "no"}`,
    `3. **Next blocker:** ${report.conclusions.nextRemainingBlocker ?? "none identified from heuristics"}`,
    ...(report.conclusions.paperLastTickMismatchNote
      ? ["", `4. **Note:** ${report.conclusions.paperLastTickMismatchNote}`]
      : []),
    "",
    `_${report.blockingReasonCountNote}_`,
    "",
    "## Commands",
    "",
    "```bash",
    "npm run dump:paper-pipeline-wakeup-report",
    "# Optional:",
    "npm run check:shadow-pipeline",
    "npm run dump:runtime-safety-block-report",
    "```",
    "",
  ];

  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log("Wrote " + jsonPath);
  console.log("Wrote " + mdPath);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
