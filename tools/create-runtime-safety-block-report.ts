/**
 * Classifies why paper/runtime may appear blocked (diagnostics only; does not change safety).
 *
 * Writes: dump/runtime-safety-block-report.json, .md
 * npm run dump:runtime-safety-block-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import {
  extractCanonicalWorkerRuntime,
  heartbeatIsFresh,
  parseHeartbeatMetadataJson,
} from "../lib/ops/worker-heartbeat-canonical";

const DUMP = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";
const EXCHANGE_TRUTH_TRANSIENT_GRACE_MS = Number(process.env.EXCHANGE_TRUTH_TRANSIENT_GRACE_MS ?? "60000") || 60_000;

type Classification = {
  category:
    | "kill_switch_watchdog"
    | "runtime_safety_blocked"
    | "runtime_safety_degraded"
    | "pool_or_db_stress"
    | "operational_execution_policy"
    | "live_readiness_block"
    | "unknown_or_no_heartbeat";
  detail: string;
  fixableByHealthImprovements: boolean;
};

function classify(
  meta: Record<string, unknown> | null
): { classifications: Classification[]; raw: Record<string, unknown> | null } {
  if (!meta || typeof meta !== "object") {
    return {
      classifications: [
        {
          category: "unknown_or_no_heartbeat",
          detail: "No worker metadata",
          fixableByHealthImprovements: false,
        },
      ],
      raw: meta,
    };
  }

  const rs = meta.runtimeSafety as Record<string, unknown> | undefined;
  const state = typeof rs?.state === "string" ? rs.state : "";
  const blocking = Array.isArray(rs?.blockingReasons)
    ? (rs.blockingReasons as string[])
    : [];
  const warnings = Array.isArray(rs?.warnings) ? (rs.warnings as string[]) : [];

  const lr = meta.liveReadiness as Record<string, unknown> | undefined;
  const lrBlocking = Array.isArray(lr?.blockingReasons)
    ? (lr.blockingReasons as string[])
    : [];
  const lrWarnings = Array.isArray(lr?.warnings) ? (lr.warnings as string[]) : [];

  const rh = meta.runtimeHealth as Record<string, unknown> | undefined;
  const rhMeta = (rh?.metadata as Record<string, unknown> | undefined) ?? undefined;
  const degradedReasons = Array.isArray(rh?.degradedReasons)
    ? (rh.degradedReasons as string[])
    : [];

  const out: Classification[] = [];

  const killHints = [...blocking, ...lrBlocking].some(
    (s) =>
      typeof s === "string" &&
      (s.includes("kill_switch") ||
        s.includes("watchdog") ||
        s.includes("user_data_silence") ||
        s.includes("market_data_silence"))
  );
  if (state === "kill_switch" || killHints) {
    out.push({
      category: "kill_switch_watchdog",
      detail: `state=${state || "?"}; blocking=${JSON.stringify(blocking)}`,
      fixableByHealthImprovements: true,
    });
  }

  if (state === "blocked") {
    out.push({
      category: "runtime_safety_blocked",
      detail: `blockingReasons: ${JSON.stringify(blocking)}`,
      fixableByHealthImprovements: blocking.some(
        (b) =>
          typeof b === "string" &&
          (b.includes("stale") ||
            b.includes("worker") ||
            b.includes("reconciliation") ||
            b.includes("feed") ||
            b.includes("truth"))
      ),
    });
  }

  if (state === "degraded" || warnings.length || lrWarnings.length) {
    out.push({
      category: "runtime_safety_degraded",
      detail: `warnings=${JSON.stringify(warnings)} liveReadinessWarnings=${JSON.stringify(lrWarnings)}`,
      fixableByHealthImprovements: true,
    });
  }

  if (
    degradedReasons.some(
      (d) =>
        typeof d === "string" &&
        (d.toLowerCase().includes("pool") ||
          d.toLowerCase().includes("p2024") ||
          d.toLowerCase().includes("prisma") ||
          d.toLowerCase().includes("timeout"))
    )
  ) {
    out.push({
      category: "pool_or_db_stress",
      detail: JSON.stringify(degradedReasons),
      fixableByHealthImprovements: true,
    });
  }

  const opBlock = lrBlocking.find(
    (s) => typeof s === "string" && s.startsWith("operational:")
  );
  if (opBlock) {
    out.push({
      category: "operational_execution_policy",
      detail: String(opBlock),
      fixableByHealthImprovements: opBlock.includes("runtime") || opBlock.includes("silence"),
    });
  }

  if (lrBlocking.length && !opBlock && state !== "kill_switch") {
    out.push({
      category: "live_readiness_block",
      detail: JSON.stringify(lrBlocking),
      fixableByHealthImprovements: true,
    });
  }

  if (out.length === 0) {
    out.push({
      category: "unknown_or_no_heartbeat",
      detail: `runtimeSafety.state=${state || "missing"}`,
      fixableByHealthImprovements: false,
    });
  }

  return { classifications: out, raw: meta };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP, { recursive: true });

  let heartbeat: { lastSeenAt: Date; metadataJson: string | null } | null = null;
  let hbError: string | null = null;
  try {
    heartbeat = await prisma.workerHeartbeat.findUnique({
      where: { workerName: WORKER_NAME },
      select: { lastSeenAt: true, metadataJson: true },
    });
  } catch (e) {
    hbError = e instanceof Error ? e.message : String(e);
  }

  const meta = parseHeartbeatMetadataJson(heartbeat?.metadataJson ?? null);
  const canonicalRuntime = extractCanonicalWorkerRuntime(meta);
  const hbFresh =
    heartbeat?.lastSeenAt != null
      ? heartbeatIsFresh(heartbeat.lastSeenAt, Date.now(), 120_000)
      : false;

  const { classifications, raw } = classify(meta);
  const rh = meta?.runtimeHealth as Record<string, unknown> | undefined;
  const rhMeta = (rh?.metadata as Record<string, unknown> | undefined) ?? undefined;

  const report = {
    generatedAt: new Date().toISOString(),
    workerName: WORKER_NAME,
    heartbeatError: hbError,
    lastHeartbeatAt: heartbeat?.lastSeenAt?.toISOString() ?? null,
    heartbeatStale:
      heartbeat?.lastSeenAt != null
        ? Date.now() - heartbeat.lastSeenAt.getTime() > 120_000
        : null,
    distinctionGuide: {
      schema_drift:
        "Prisma errors: Unknown argument X, Unknown field — fix schema/migrate/generate (see dump:papertrade-schema-compat-report).",
      pool_exhaustion:
        "P2024 Timed out fetching connection — reduce hot writes or increase pool; see dump:prisma-runtime-pressure-report.",
      runtime_safety_blocked:
        "execution policy reasons runtime_safety_blocked / kill_switch — worker runtimeSafety.state and blockingReasons; this report maps watchdog vs degraded vs operational.",
      legitimate_policy:
        "Staging/decision blocks (liquidity, crowded market) — separate from runtime safety; do not bypass.",
    },
    classifications,
    paperModeBlockedInterpretation: {
      fixableByInfrastructure: classifications.some(
        (c) =>
          c.fixableByHealthImprovements &&
          (c.category === "pool_or_db_stress" ||
            c.category === "runtime_safety_degraded" ||
            c.category === "kill_switch_watchdog")
      ),
      likelyPolicyNotRuntime: classifications.every(
        (c) => c.category === "operational_execution_policy"
      ),
    },
    metadataKeys: raw ? Object.keys(raw) : [],
    canonicalWorkerRuntimeTruth: {
      ...canonicalRuntime,
      heartbeatFreshUnder120s: hbFresh,
      alignedWithPaperPipelineWakeupReport: true,
    },
    observability: {
      userTruthMaintenance: meta?.userTruthMaintenance ?? null,
      exchangeTruthGrace: {
        graceMs: EXCHANGE_TRUTH_TRANSIENT_GRACE_MS,
        transientGraceApplied: rhMeta?.exchangeTruthTransientGraceApplied ?? null,
        transientGraceReason: rhMeta?.exchangeTruthTransientGraceReason ?? null,
        lastExchangeTruthFailureError: rhMeta?.lastExchangeTruthFailureError ?? null,
        lastExchangeTruthFailureDiagnostics: rhMeta?.lastExchangeTruthFailureDiagnostics ?? null,
      },
    },
    reportConsistencyNote:
      "canonicalWorkerRuntimeTruth uses lib/ops/worker-heartbeat-canonical.ts — same drift/reconciliation fields as dump:paper-pipeline-wakeup-report (runtimeHealth.reconciliation, not top-level meta.reconciliation).",
  };

  const md = [
    "# Runtime safety block diagnosis",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Worker heartbeat",
    "",
    `- **workerName:** ${WORKER_NAME}`,
    `- **lastSeenAt:** ${report.lastHeartbeatAt ?? "n/a"}`,
    `- **stale (>120s):** ${report.heartbeatStale}`,
    hbError ? `- **error:** ${hbError}` : "",
    "",
    "## Canonical runtime truth (matches paper-pipeline-wakeup-report)",
    "",
    "```json",
    JSON.stringify(report.canonicalWorkerRuntimeTruth, null, 2),
    "```",
    "",
    report.reportConsistencyNote,
    "",
    "## How to read failures",
    "",
    "| Signal | Meaning |",
    "|--------|---------|",
    "| Schema / Unknown argument | Schema drift — migrate + generate |",
    "| P2024 | Pool exhaustion — throttle writes / pool config |",
    "| kill_switch + user_data_silence | Watchdog — improve user stream or user truth freshness |",
    "| runtime_safety_blocked | See blockingReasons — feeds, reconciliation, worker health |",
    "| operational:* | Execution policy path — may overlap with runtime or be separate |",
    "",
    "## Classifications (this heartbeat)",
    "",
    ...classifications.map(
      (c) =>
        `### ${c.category}\n\n- **detail:** ${c.detail}\n- **fixable by health improvements:** ${c.fixableByHealthImprovements}\n`
    ),
    "",
    "## Paper mode summary",
    "",
    `- **Blocked issues partly fixable by health/DB:** ${report.paperModeBlockedInterpretation.fixableByInfrastructure}`,
    `- **Looks policy-only (operational):** ${report.paperModeBlockedInterpretation.likelyPolicyNotRuntime}`,
    "",
  ].join("\n");

  await fs.writeFile(path.join(DUMP, "runtime-safety-block-report.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(DUMP, "runtime-safety-block-report.md"), md);
  console.log("Wrote dump/runtime-safety-block-report.{json,md}");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
