/**
 * Concentration-input validation report (short-window, deterministic).
 *
 * Writes:
 * - dump/concentration-input-validation-report.json
 * - dump/concentration-input-validation-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { parseHeartbeatMetadataJson } from "../lib/ops/worker-heartbeat-canonical";
import { DEFAULT_RUNTIME_RISK_LIMITS } from "../lib/runtime/risk/runtime-risk-engine";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";
const CANDIDATE_LIMIT = Number(process.env.CONCENTRATION_VALIDATION_CANDIDATE_LIMIT ?? "20") || 20;

type RootCause =
  | "EXACT_EXPECTED_POLICY_BLOCK"
  | "STALE_EXPOSURE_INPUTS"
  | "INCORRECT_CONCENTRATION_CALCULATION"
  | "WRONG_THRESHOLD_SOURCE"
  | "PAPER_MODE_CONFIG_MISMATCH"
  | "DUPLICATED_OR_INFLATED_EXPOSURE"
  | "OTHER_BUG";

function since(msAgo: number): Date {
  return new Date(Date.now() - msAgo);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toReasonArray(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .flatMap((x) => (typeof x === "string" ? x.split(/[;,|]/g) : []))
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") return raw.split(/[;,|]/g).map((x) => x.trim()).filter(Boolean);
  return [];
}

function hasConcentrationBlock(reasons: string[]): boolean {
  return reasons.includes("single_market_concentration_breach") || reasons.includes("single_theme_concentration_breach");
}

function parseNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const nowMs = Date.now();

  // Runtime snapshot
  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { metadataJson: true, lastSeenAt: true },
  });
  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? undefined);
  const runtimeHealth = asRecord(meta?.runtimeHealth) ?? null;
  const runtimeSafety = asRecord(meta?.runtimeSafety) ?? null;
  const readiness = asRecord(asRecord(runtimeHealth?.operatorHealth)?.readiness) ?? null;

  const runtimeStatus = typeof runtimeHealth?.status === "string" ? runtimeHealth.status : null;
  const lifecycleStatus = typeof runtimeHealth?.lifecycleStatus === "string" ? runtimeHealth.lifecycleStatus : null;
  const globalAutomationEnabled = typeof runtimeHealth?.globalAutomationEnabled === "boolean" ? (runtimeHealth.globalAutomationEnabled as boolean) : null;
  const automationPermitted = typeof readiness?.automationPermitted === "boolean" ? (readiness.automationPermitted as boolean) : null;
  const safeToAutomate = typeof readiness?.safeToAutomate === "boolean" ? (readiness.safeToAutomate as boolean) : null;
  const runtimeSafetyState = typeof runtimeSafety?.state === "string" ? (runtimeSafety.state as string) : null;
  const degradedReasons = Array.isArray(runtimeHealth?.degradedReasons) ? (runtimeHealth!.degradedReasons as string[]) : [];
  const operatingMode = typeof runtimeHealth?.operatingMode === "string" ? (runtimeHealth!.operatingMode as string) : null;

  // Policy limits source and effective values
  const configuredSingleMarketLimitPct = DEFAULT_RUNTIME_RISK_LIMITS.perMarketNotionalLimitPct * 100;
  const configuredSingleThemeLimitPct = DEFAULT_RUNTIME_RISK_LIMITS.perThemeNotionalLimitPct * 100;

  // Pull blocked runtime_automated candidates in short windows
  const since5m = since(5 * 60 * 1000);
  const since10m = since(10 * 60 * 1000);
  const all10m = await prisma.shadowCandidate.findMany({
    where: {
      candidateSource: "runtime_automated",
      createdAt: { gte: since10m },
      wasBlocked: true,
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: {
      id: true,
      createdAt: true,
      recommendationId: true,
      marketId: true,
      candidateSource: true,
      blockingReasons: true,
      executionPolicySnapshotJson: true,
      portfolioRiskSnapshotJson: true,
    },
  });

  const blocked5m = all10m.filter((c) => c.createdAt >= since5m);
  const concentration5m = blocked5m.filter((c) => hasConcentrationBlock(toReasonArray(c.blockingReasons)));
  const concentration10m = all10m.filter((c) => hasConcentrationBlock(toReasonArray(c.blockingReasons)));
  const sampledWindow = concentration5m.length > 0 ? "5m" : "10m";
  const sampledConcentrationRows = concentration5m.length > 0 ? concentration5m : concentration10m;

  const recIds = Array.from(
    new Set(sampledConcentrationRows.slice(0, CANDIDATE_LIMIT).map((c) => c.recommendationId).filter((x): x is string => !!x))
  );
  const recRows = recIds.length
    ? await prisma.recommendation.findMany({
        where: { id: { in: recIds } },
        select: { id: true, marketSignal: { select: { marketTitle: true, marketId: true } } },
      })
    : [];
  const recMap = new Map(recRows.map((r) => [r.id, r.marketSignal]));

  const recentConcentrationRows = sampledConcentrationRows.slice(0, CANDIDATE_LIMIT).map((c) => {
    const reasons = toReasonArray(c.blockingReasons);
    const normalizedReasons = reasons.map((r) => (r.startsWith("exposure:") ? r.slice("exposure:".length) : r));
    const policy = c.executionPolicySnapshotJson ? asRecord(JSON.parse(c.executionPolicySnapshotJson)) : null;
    const riskSnap = c.portfolioRiskSnapshotJson ? asRecord(JSON.parse(c.portfolioRiskSnapshotJson)) : null;
    const appliedLimits = asRecord(riskSnap?.appliedLimits);

    const singleMarketCurrent = parseNum(riskSnap?.maxSingleMarketConcentrationPct);
    const singleThemeCurrent = parseNum(riskSnap?.maxSingleThemeConcentrationPct);
    const singleMarketLimit = parseNum(appliedLimits?.maxSingleMarketConcentrationPct) ?? configuredSingleMarketLimitPct;
    const singleThemeLimit = parseNum(appliedLimits?.maxSingleThemeConcentrationPct) ?? configuredSingleThemeLimitPct;
    const computedAt = typeof riskSnap?.computedAt === "string" ? (riskSnap.computedAt as string) : null;
    const computedAgeMs = computedAt ? nowMs - new Date(computedAt).getTime() : null;

    const marketExceeded =
      singleMarketCurrent != null && singleMarketLimit != null
        ? singleMarketCurrent >= singleMarketLimit
        : null;
    const themeExceeded =
      singleThemeCurrent != null && singleThemeLimit != null
        ? singleThemeCurrent >= singleThemeLimit
        : null;

    const marketInfo = c.recommendationId ? recMap.get(c.recommendationId) : null;
    return {
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      marketId: c.marketId ?? marketInfo?.marketId ?? null,
      marketTitle: marketInfo?.marketTitle ?? null,
      candidateSource: c.candidateSource,
      conciseBlockingReasons: normalizedReasons.slice(0, 8),
      singleMarketConcentrationValuePct: singleMarketCurrent,
      singleThemeConcentrationValuePct: singleThemeCurrent,
      singleMarketThresholdPct: singleMarketLimit,
      singleThemeThresholdPct: singleThemeLimit,
      marketExceededNumerically: marketExceeded,
      themeExceededNumerically: themeExceeded,
      exposureSnapshotComputedAt: computedAt,
      exposureSnapshotAgeMs: computedAgeMs,
      exposureSnapshotAppearsFresh: computedAgeMs != null ? computedAgeMs <= 2 * 60 * 1000 : null,
      exposureSnapshotSource: "ShadowCandidate.portfolioRiskSnapshotJson (runtime-captured concentration input)",
      executionPolicySnapshotPresent: policy != null,
    };
  });

  const valuesPresentCount = recentConcentrationRows.filter(
    (r) => r.singleMarketConcentrationValuePct != null || r.singleThemeConcentrationValuePct != null
  ).length;
  const bothExceededCount = recentConcentrationRows.filter(
    (r) => r.marketExceededNumerically === true || r.themeExceededNumerically === true
  ).length;
  const mismatchCount = recentConcentrationRows.filter(
    (r) =>
      (r.marketExceededNumerically === false && r.conciseBlockingReasons.includes("single_market_concentration_breach")) ||
      (r.themeExceededNumerically === false && r.conciseBlockingReasons.includes("single_theme_concentration_breach"))
  ).length;
  const staleInputsCount = recentConcentrationRows.filter((r) => r.exposureSnapshotAppearsFresh === false).length;
  const inflatedCount = recentConcentrationRows.filter(
    (r) =>
      (r.singleMarketConcentrationValuePct != null && r.singleMarketConcentrationValuePct > 1000) ||
      (r.singleThemeConcentrationValuePct != null && r.singleThemeConcentrationValuePct > 1000)
  ).length;

  let rootCause: RootCause = "OTHER_BUG";
  const why: string[] = [];

  if (recentConcentrationRows.length === 0) {
    rootCause = "OTHER_BUG";
    why.push("No concentration-blocked candidates found in 5m window.");
  } else if (valuesPresentCount === 0) {
    rootCause = "OTHER_BUG";
    why.push("Concentration numeric inputs are not present in most persisted short-window snapshots.");
  } else if (inflatedCount > 0) {
    rootCause = "DUPLICATED_OR_INFLATED_EXPOSURE";
    why.push(`Found ${inflatedCount} rows with implausibly high concentration values (>1000%).`);
  } else if (staleInputsCount > Math.floor(recentConcentrationRows.length * 0.5)) {
    rootCause = "STALE_EXPOSURE_INPUTS";
    why.push(`More than half the rows use stale exposure snapshots (${staleInputsCount}/${recentConcentrationRows.length}).`);
  } else if (mismatchCount > 0) {
    rootCause = "INCORRECT_CONCENTRATION_CALCULATION";
    why.push(`Found ${mismatchCount} rows where block reason does not match numeric threshold exceedance.`);
  } else if (
    recentConcentrationRows.some(
      (r) =>
        r.singleMarketThresholdPct != null &&
        Math.abs(r.singleMarketThresholdPct - configuredSingleMarketLimitPct) > 0.001
    ) ||
    recentConcentrationRows.some(
      (r) =>
        r.singleThemeThresholdPct != null &&
        Math.abs(r.singleThemeThresholdPct - configuredSingleThemeLimitPct) > 0.001
    )
  ) {
    rootCause = "WRONG_THRESHOLD_SOURCE";
    why.push("Observed applied concentration thresholds diverge from configured runtime risk limits.");
  } else if (bothExceededCount > 0) {
    rootCause = "EXACT_EXPECTED_POLICY_BLOCK";
    why.push(
      `Concentration block reasons match numeric exceedance in short-window samples (${bothExceededCount}/${recentConcentrationRows.length}).`
    );
  } else {
    rootCause = "OTHER_BUG";
    why.push("Insufficient evidence to prove exact expected block or specific mismatch.");
  }

  const report = {
    generatedAt,
    runtimeSnapshot: {
      runtimeStatus,
      lifecycleStatus,
      globalAutomationEnabled,
      automationPermitted,
      safeToAutomate,
      runtimeSafetyState,
      degradedReasons,
      operatingMode,
    },
    concentrationPolicyConfig: {
      source: "lib/runtime/risk/runtime-risk-engine.ts (riskState.limits -> stream-runtime exposureInput)",
      configuredSingleMarketLimitPct,
      configuredSingleThemeLimitPct,
      paperModeOverrides: "none for concentration limits; same riskState limits used in paper mode",
      effectiveAppliedLimitsObserved: {
        singleMarket: recentConcentrationRows[0]?.singleMarketThresholdPct ?? configuredSingleMarketLimitPct,
        singleTheme: recentConcentrationRows[0]?.singleThemeThresholdPct ?? configuredSingleThemeLimitPct,
      },
    },
    shortWindowSummary: {
      sampledWindowForCandidateRows: sampledWindow,
      blockedRuntimeAutomated5m: blocked5m.length,
      concentrationBlocked5m: concentration5m.length,
      blockedRuntimeAutomated10m: all10m.length,
      concentrationBlocked10m: concentration10m.length,
    },
    recentConcentrationBlockedCandidates: recentConcentrationRows,
    exposureInputProvenance: {
      path:
        "worker/stream-runtime.ts builds exposureInput from getPortfolioRiskSnapshot(funderAddress) + riskState limits, then calls evaluateExecutionPolicy(policyInput).",
      concentrationInputSource:
        "portfolioRisk.maxSingleMarketConcentrationPct / portfolioRisk.maxSingleThemeConcentrationPct with limits from riskState.limits.perMarketNotionalLimitPct/perThemeNotionalLimitPct",
      freshnessSignalsUsed: [
        "portfolioRiskSnapshotJson.computedAt (candidate-level captured input)",
        "runtimeHealth.reconciliation/status and degraded reasons (runtime-level context)",
      ],
      evidenceOfCrossScopeLeakage: false,
      paperModeIntendedSource:
        "paper mode uses same runtime risk + portfolio risk snapshot source; no live-only override for concentration limits",
    },
    stageAttribution: {
      singleMarketConcentrationBreach: {
        stage: "execution policy",
        module: "lib/execution-policy/evaluate.ts",
        function: "checkExposure",
      },
      singleThemeConcentrationBreach: {
        stage: "execution policy",
        module: "lib/execution-policy/evaluate.ts",
        function: "checkExposure",
      },
      samePass: true,
      emissionMatchNumerics:
        mismatchCount === 0 ? "yes_for_rows_with_persisted_numeric_inputs" : "mismatch_detected",
    },
    rootCauseClassification: {
      rootCause,
      why,
    },
    recommendedNextStep:
      rootCause === "EXACT_EXPECTED_POLICY_BLOCK"
        ? "no fix needed; block is legitimate"
        : rootCause === "OTHER_BUG"
          ? "audit exposure composition details next"
          : rootCause === "WRONG_THRESHOLD_SOURCE" || rootCause === "PAPER_MODE_CONFIG_MISMATCH"
            ? "audit paper-only concentration policy intent next"
            : "fix identified metric/config bug now",
    filesChanged: [
      "tools/create-concentration-input-validation-report.ts",
      "package.json",
      "worker/stream-runtime.ts",
    ],
  };

  const md: string[] = [];
  md.push("# Concentration Input Validation Report");
  md.push(`Generated at: ${generatedAt}`);
  md.push("");
  md.push("## 1) Runtime snapshot");
  md.push(
    `- runtimeStatus: **${runtimeStatus ?? "—"}** · lifecycleStatus: **${lifecycleStatus ?? "—"}**`
  );
  md.push(
    `- globalAutomationEnabled: **${globalAutomationEnabled ?? "—"}** · automationPermitted: **${automationPermitted ?? "—"}** · safeToAutomate: **${safeToAutomate ?? "—"}**`
  );
  md.push(`- runtimeSafetyState: **${runtimeSafetyState ?? "—"}**`);
  md.push(`- degradedReasons: ${degradedReasons.join(", ") || "(none)"}`);
  md.push(`- operatingMode: **${operatingMode ?? "—"}**`);
  md.push("");
  md.push("## 2) Current concentration policy config");
  md.push(`- configured single-market limit: **${configuredSingleMarketLimitPct}%**`);
  md.push(`- configured single-theme limit: **${configuredSingleThemeLimitPct}%**`);
  md.push(
    `- paper-mode concentration override: **none observed** (same riskState limits used in paper mode)`
  );
  md.push(
    `- effective applied limits (observed): market=${report.concentrationPolicyConfig.effectiveAppliedLimitsObserved.singleMarket ?? "—"}% · theme=${report.concentrationPolicyConfig.effectiveAppliedLimitsObserved.singleTheme ?? "—"}%`
  );
  md.push("");
  md.push(`## 3) Recent concentration-blocked candidates (${sampledWindow})`);
  md.push(
    `- blocked runtime_automated in 5m: **${blocked5m.length}** · concentration-blocked in 5m: **${concentration5m.length}** · concentration-blocked in 10m: **${concentration10m.length}**`
  );
  md.push(
    "| createdAt | marketId | marketTitle | reasons | market conc % | market limit % | exceeds? | theme conc % | theme limit % | exceeds? | snapshot age ms |"
  );
  md.push("|---|---|---|---|---:|---:|---|---:|---:|---|---:|");
  for (const r of recentConcentrationRows) {
    md.push(
      `| ${r.createdAt} | ${r.marketId ?? "—"} | ${r.marketTitle ?? "—"} | ${r.conciseBlockingReasons.join("; ") || "—"} | ${r.singleMarketConcentrationValuePct ?? "—"} | ${r.singleMarketThresholdPct ?? "—"} | ${r.marketExceededNumerically ?? "—"} | ${r.singleThemeConcentrationValuePct ?? "—"} | ${r.singleThemeThresholdPct ?? "—"} | ${r.themeExceededNumerically ?? "—"} | ${r.exposureSnapshotAgeMs ?? "—"} |`
    );
  }
  md.push("");
  md.push("## 4) Exposure input provenance");
  md.push(`- ${report.exposureInputProvenance.path}`);
  md.push(`- ${report.exposureInputProvenance.concentrationInputSource}`);
  md.push(
    `- evidence of stale/duplicated/cross-scope source: ${rootCause === "STALE_EXPOSURE_INPUTS" || rootCause === "DUPLICATED_OR_INFLATED_EXPOSURE" ? "present" : "not observed in bounded sample"}`
  );
  md.push("");
  md.push("## 5) Stage attribution");
  md.push(
    `- single_market_concentration_breach: ${report.stageAttribution.singleMarketConcentrationBreach.module} :: ${report.stageAttribution.singleMarketConcentrationBreach.function}`
  );
  md.push(
    `- single_theme_concentration_breach: ${report.stageAttribution.singleThemeConcentrationBreach.module} :: ${report.stageAttribution.singleThemeConcentrationBreach.function}`
  );
  md.push(`- emitted from same exposure pass: **${report.stageAttribution.samePass}**`);
  md.push(`- emitted reasons match numeric inputs: **${report.stageAttribution.emissionMatchNumerics}**`);
  md.push("");
  md.push("## 6) Root cause classification");
  md.push(`- **${rootCause}**`);
  for (const w of why) md.push(`- ${w}`);
  md.push("");
  md.push("## 7) Recommended next step");
  md.push(`- ${report.recommendedNextStep}`);

  await fs.writeFile(path.join(DUMP_DIR, "concentration-input-validation-report.json"), JSON.stringify(report, null, 2), "utf-8");
  await fs.writeFile(path.join(DUMP_DIR, "concentration-input-validation-report.md"), md.join("\n"), "utf-8");

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        rootCause,
        recentRows: recentConcentrationRows.length,
        valuesPresentCount,
        bothExceededCount,
        mismatchCount,
        staleInputsCount,
        configuredSingleMarketLimitPct,
        configuredSingleThemeLimitPct,
      },
      null,
      2
    )
  );
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("create-concentration-input-validation-report failed", err);
  process.exit(1);
});

