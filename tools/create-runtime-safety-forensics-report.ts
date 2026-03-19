/**
 * Forensics: why runtimeSafety.state is blocked/degraded (from worker heartbeat + evaluateRuntimeSafety mapping).
 *
 * Writes: dump/runtime-safety-forensics-report.{json,md}
 * Run: npm run dump:runtime-safety-forensics-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { parseHeartbeatMetadataJson } from "../lib/ops/worker-heartbeat-canonical";

const DUMP = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";
const STALE_MS = 120_000;
const REPEATED_THRESHOLD = 5;

function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? now - t : null;
}

type PredicateRow = {
  blockingReason: string;
  evaluatorPredicate: string;
  likelyCurrent: boolean;
  staleOrBuggyHint: string | null;
};

function explainBlockingReason(
  reason: string,
  ctx: {
    now: number;
    lastReconOk: boolean;
    reconAgeMs: number | null;
    reconThresholdMs: number;
    drift: boolean;
    marketDataAgeMs: number | null;
    userDataAgeMs: number | null;
    exchangeTruthUnavailableMeta: boolean | null;
    runtimePhase: string | null;
    runtimeReconciliationFailures: number;
    lastReconStatus: string | null;
    globalKillSwitch: boolean;
  }
): PredicateRow {
  const rows: Record<string, Omit<PredicateRow, "blockingReason">> = {
    kill_switch_active: {
      evaluatorPredicate: "evaluateRuntimeSafety: killSwitchActive === true (riskEngine.globalAutomationEnabled false)",
      likelyCurrent: ctx.globalKillSwitch,
      staleOrBuggyHint: null,
    },
    exchange_truth_unavailable: {
      evaluatorPredicate:
        "exchangeTruthAvailable === false (flag set and orders/fills snapshots outside EXCHANGE_TRUTH_TRANSIENT_GRACE_MS)",
      likelyCurrent: ctx.exchangeTruthUnavailableMeta === true,
      staleOrBuggyHint: null,
    },
    reconciliation_drift: {
      evaluatorPredicate: "reconciliationDrift === true (lastReconciliationResult.driftDetected)",
      likelyCurrent: ctx.drift,
      staleOrBuggyHint: ctx.drift ? null : "Should not appear if drift false — inspect watchdog vs recon tick ordering",
    },
    reconciliation_stale: {
      evaluatorPredicate:
        "lastRuntimeReconciliationStatus===ok && age(lastRuntimeReconciliationAt) > reconciliationThresholdMs (~120s)",
      likelyCurrent:
        ctx.lastReconOk && ctx.reconAgeMs != null && ctx.reconAgeMs > ctx.reconThresholdMs,
      staleOrBuggyHint:
        ctx.lastReconOk && ctx.reconAgeMs != null && ctx.reconAgeMs <= ctx.reconThresholdMs
          ? "Stale heartbeat snapshot or reason from prior tick"
          : null,
    },
    market_feed_extremely_stale: {
      evaluatorPredicate: "market WS lastDataEventAge >= marketFeedBlockStalenessMs (300s default)",
      likelyCurrent: ctx.marketDataAgeMs != null && ctx.marketDataAgeMs >= 300_000,
      staleOrBuggyHint: null,
    },
    market_feed_freshness_unknown: {
      evaluatorPredicate: "market lastDataEventAt missing → fail-closed block",
      likelyCurrent: ctx.marketDataAgeMs == null,
      staleOrBuggyHint:
        ctx.marketDataAgeMs != null
          ? "Reason should clear on next watchdog tick — was transient null connection"
          : null,
    },
    user_feed_extremely_stale: {
      evaluatorPredicate: "user feed age >= userFeedBlockStalenessMs",
      likelyCurrent: ctx.userDataAgeMs != null && ctx.userDataAgeMs >= 300_000,
      staleOrBuggyHint: null,
    },
    runtime_not_ready: {
      evaluatorPredicate: "runtimePhase === starting | rebuilding",
      likelyCurrent: ctx.runtimePhase === "starting" || ctx.runtimePhase === "rebuilding",
      staleOrBuggyHint: null,
    },
    repeated_runtime_errors: {
      evaluatorPredicate: "diagnostics.runtimeReconciliationFailures >= 5",
      likelyCurrent: ctx.runtimeReconciliationFailures >= REPEATED_THRESHOLD,
      staleOrBuggyHint:
        ctx.lastReconStatus === "ok" && ctx.runtimeReconciliationFailures >= REPEATED_THRESHOLD
          ? "BUG (pre-fix): failures counter never reset on success — latched blocked after historical failures"
          : ctx.runtimeReconciliationFailures >= REPEATED_THRESHOLD
            ? "Legitimate: recent reconciliation failures without successful clear"
            : null,
    },
    worker_unhealthy: {
      evaluatorPredicate: "stream runtime status === unhealthy (not used in current watchdog path)",
      likelyCurrent: false,
      staleOrBuggyHint: "Rare; check stream-runtime workerHealth input",
    },
  };

  const base = rows[reason] ?? {
    evaluatorPredicate: "unknown code path",
    likelyCurrent: true,
    staleOrBuggyHint: null,
  };
  return { blockingReason: reason, ...base };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP, { recursive: true });
  const now = Date.now();

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });

  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? null);
  const rs = (meta?.runtimeSafety ?? {}) as Record<string, unknown>;
  const state = typeof rs.state === "string" ? rs.state : null;
  const blockingReasons = Array.isArray(rs.blockingReasons) ? (rs.blockingReasons as string[]) : [];
  const warnings = Array.isArray(rs.warnings) ? (rs.warnings as string[]) : [];
  const evaluatedAt = typeof rs.evaluatedAt === "string" ? rs.evaluatedAt : null;

  const rh = (meta?.runtimeHealth ?? {}) as Record<string, unknown>;
  const streams = (rh.streams ?? {}) as Record<string, unknown>;
  const market = (streams.marketConnection ?? {}) as Record<string, unknown>;
  const user = (streams.userConnection ?? {}) as Record<string, unknown>;
  const diag = (rh.diagnostics ?? {}) as Record<string, unknown>;
  const rhMeta = (rh.metadata ?? {}) as Record<string, unknown>;

  const marketLastData =
    market.lastDataEventAt instanceof Date
      ? market.lastDataEventAt.toISOString()
      : typeof market.lastDataEventAt === "string"
        ? market.lastDataEventAt
        : null;
  const userLastData =
    user.lastDataEventAt instanceof Date
      ? user.lastDataEventAt.toISOString()
      : typeof user.lastDataEventAt === "string"
        ? user.lastDataEventAt
        : null;

  const lastReconAt = typeof diag.lastRuntimeReconciliationAt === "string" ? diag.lastRuntimeReconciliationAt : null;
  const lastReconStatus = typeof diag.lastRuntimeReconciliationStatus === "string" ? diag.lastRuntimeReconciliationStatus : null;
  const reconAgeMs = ageMs(lastReconAt, now);
  const failures = typeof diag.runtimeReconciliationFailures === "number" ? diag.runtimeReconciliationFailures : 0;
  const rec = (rh.reconciliation ?? {}) as Record<string, unknown>;
  const driftDetected = rec.driftDetected === true || rec.driftDetected === "true";

  const marketDataAgeMs = ageMs(marketLastData, now);
  const userDataAgeMs = ageMs(userLastData, now);

  const heartbeatAgeMs = hb?.lastSeenAt ? now - hb.lastSeenAt.getTime() : null;

  const globalKillSwitch = state === "kill_switch";

  const predicateRows = blockingReasons.map((r) =>
    explainBlockingReason(r, {
      now,
      lastReconOk: lastReconStatus === "ok",
      reconAgeMs,
      reconThresholdMs: 120_000,
      drift: driftDetected,
      marketDataAgeMs,
      userDataAgeMs,
      exchangeTruthUnavailableMeta: rhMeta.exchangeTruthUnavailable === true,
      runtimePhase: typeof rh.status === "string" ? rh.status : null,
      runtimeReconciliationFailures: failures,
      lastReconStatus,
      globalKillSwitch,
    })
  );

  const stickyRepeatedErrors =
    lastReconStatus === "ok" &&
    failures >= REPEATED_THRESHOLD &&
    blockingReasons.includes("repeated_runtime_errors");

  const report = {
    generatedAt: new Date().toISOString(),
    workerName: WORKER_NAME,
    heartbeatAgeMs,
    heartbeatStale: heartbeatAgeMs != null && heartbeatAgeMs > STALE_MS,
    runtimeSafety: {
      state,
      blockingReasons,
      warnings,
      evaluatedAt,
    },
    inputs: {
      exchangeTruth: {
        unavailableFlagInMetadata: rhMeta.exchangeTruthUnavailable ?? null,
        lastExchangeOrdersSnapshotAt: rhMeta.lastExchangeOrdersSnapshotAt ?? null,
        lastExchangeFillsSnapshotAt: rhMeta.lastExchangeFillsSnapshotAt ?? null,
        lastExchangeTruthFailureAt: rhMeta.lastExchangeTruthFailureAt ?? null,
        lastExchangeTruthFailureError: rhMeta.lastExchangeTruthFailureError ?? null,
        transientGraceApplied: rhMeta.exchangeTruthTransientGraceApplied ?? null,
      },
      marketData: {
        lastDataEventAt: marketLastData,
        ageMs: marketDataAgeMs,
        connectionStatus: market.status ?? null,
      },
      userData: {
        lastDataEventAt: userLastData,
        ageMs: userDataAgeMs,
        connectionStatus: user.status ?? null,
      },
      reconciliation: {
        lastAt: lastReconAt,
        status: lastReconStatus,
        ageMs: reconAgeMs,
        driftDetected,
        runtimeReconciliationFailures: failures,
        runtimeReconciliationRuns: diag.runtimeReconciliationRuns ?? null,
      },
    },
    blockingReasonForensics: predicateRows,
    stateMachineReference: {
      source: "lib/runtime-safety/evaluate.ts",
      order: "manualOverride → kill_switch → blocking reasons accumulate → any blockingReason → state blocked (all reasons treated as block today)",
      stickyCounters:
        "runtimeReconciliationFailures incremented on recordRuntimeReconciliationFailure; cleared on recordRuntimeReconciliationRun (successful tick).",
    },
    conclusions: {
      primaryBlockDrivers: blockingReasons,
      likelyStickyRepeatedErrorsBug: Boolean(stickyRepeatedErrors),
      note: stickyRepeatedErrors
        ? "repeated_runtime_errors with last recon OK and high failure count indicated failure counter never reset on success (fixed in recordRuntimeReconciliationRun)."
        : blockingReasons.length === 0
          ? "No blocking reasons in heartbeat; state may be normal/degraded from warnings only."
          : "See blockingReasonForensics per reason.",
    },
  };

  const jsonPath = path.join(DUMP, "runtime-safety-forensics-report.json");
  const mdPath = path.join(DUMP, "runtime-safety-forensics-report.md");

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Runtime safety forensics",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Current state",
    "",
    `- **runtimeSafety.state:** ${state ?? "—"}`,
    `- **blockingReasons:** ${JSON.stringify(blockingReasons)}`,
    `- **warnings:** ${JSON.stringify(warnings)}`,
    `- **evaluatedAt:** ${evaluatedAt ?? "—"}`,
    `- **heartbeat age (ms):** ${heartbeatAgeMs ?? "—"}`,
    "",
    "## Inputs (from heartbeat runtimeHealth)",
    "",
    "```json",
    JSON.stringify(report.inputs, null, 2),
    "```",
    "",
    "## Per blocking reason",
    "",
    ...predicateRows.map(
      (p) =>
        `### \`${p.blockingReason}\`\n\n- **Predicate:** ${p.evaluatorPredicate}\n- **Likely current:** ${p.likelyCurrent}\n- **Stale/bug hint:** ${p.staleOrBuggyHint ?? "—"}\n`
    ),
    "",
    "## Conclusions",
    "",
    report.conclusions.note,
    "",
    "## Commands",
    "",
    "```bash",
    "npm run dump:runtime-safety-forensics-report",
    "npm run dump:paper-pipeline-wakeup-report",
    "```",
    "",
  ].join("\n");

  await fs.writeFile(mdPath, md, "utf8");
  console.log("Wrote " + jsonPath);
  console.log("Wrote " + mdPath);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
