/**
 * safeToAutomate=false / BOOTED_BUT_FROZEN audit (bounded, deterministic).
 *
 * This tool reads the latest worker heartbeat metadata (runtimeHealth/operatorHealth)
 * and correlates it with the last blocked runtime_automated shadow candidates.
 *
 * It does NOT mutate runtime state.
 *
 * Writes:
 * - dump/safe-to-automate-freeze-report.json
 * - dump/safe-to-automate-freeze-report.md
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

import { DEFAULT_STREAM_WATCHDOG_CONFIG } from "../lib/runtime/stream-watchdog-config";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";

const HEARTBEAT_FRESH_MS = Number(process.env.SAFE_TO_AUTOMATE_FREEZE_HEARTBEAT_FRESH_MS ?? "90000") || 90_000;
const CANDIDATES_LIMIT = Number(process.env.SAFE_TO_AUTOMATE_FREEZE_CANDIDATES_LIMIT ?? "20") || 20;
const CANDIDATES_WINDOW_MS =
  Number(process.env.SAFE_TO_AUTOMATE_FREEZE_CANDIDATES_WINDOW_MS ?? String(8 * 60 * 60 * 1000)) ||
  8 * 60 * 60 * 1000;

type Verdict = "HEALTHY_AND_OPERATING" | "HEALTHY_BUT_IDLE" | "BOOTED_BUT_FROZEN" | "DEGRADED" | "BROKEN";
type RootCauseCategory =
  | "LEGITIMATE_RUNTIME_FREEZE"
  | "STALE_READINESS_INPUT"
  | "LATCH_NOT_CLEARING"
  | "WRONG_GATING_SOURCE"
  | "PAPER_MODE_READINESS_MISMATCH"
  | "KILL_SWITCH_STATE_MISMATCH"
  | "OTHER_BUG";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function excerpt(s: string | null | undefined, max = 200): string | null {
  if (s == null || s === "") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function toReasonArray(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[;|,]/g)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function pickOperatingMode(runtimeHealth: any): string | null {
  const om = runtimeHealth?.operatingMode;
  return typeof om === "string" ? om : null;
}

function pickOperatingModeSource(runtimeHealth: any): string | null {
  const os = runtimeHealth?.operatingModeSource;
  return typeof os === "string" ? os : null;
}

function computeVerdict(input: {
  runtimeStatus: string | null;
  lifecycleStatus: string | null;
  runtimeMarkedReady: boolean;
  runtimeSafetyState: string | null;
  safeToAutomate: boolean | null;
}): { verdict: Verdict; why: string[] } {
  const why: string[] = [];
  if (input.runtimeSafetyState && input.runtimeSafetyState !== "normal") {
    why.push(`runtimeSafety.state=${input.runtimeSafetyState}`);
    return { verdict: "DEGRADED", why };
  }
  if (!input.runtimeMarkedReady) {
    why.push("runtimeMarkedReady=false (phase not ready yet)");
    return { verdict: "BOOTED_BUT_FROZEN", why };
  }
  if (input.safeToAutomate === false) {
    why.push("operatorHealth.readiness.safeToAutomate=false");
    return { verdict: "BOOTED_BUT_FROZEN", why };
  }
  if (input.runtimeStatus === "degraded" || input.lifecycleStatus === "degraded") {
    why.push("runtime status/lifecycle degraded");
    return { verdict: "DEGRADED", why };
  }
  return { verdict: "HEALTHY_AND_OPERATING", why };
}

function classifyFreezeRootCause(input: {
  globalAutomationEnabled: boolean | null;
  runtimeMarkedReady: boolean;
  automationPermitted: boolean | null;
  safeToAutomate: boolean | null;
  operationalReadiness: boolean | null;
  reconciliationHealthy: boolean | null;
  reconciliationLastAt: string | null;
  marketLastDataEventAt: string | null;
  userLastDataEventAt: string | null;
  operatingMode: string | null;
  operatingModeSource: string | null;
  degradedReasons: string[];
  runtimeSafetyState: string | null;
  watchdogReasons: string[];
  liveReadinessBlockingReasons: string[];
}): { category: RootCauseCategory; explain: string[] } {
  const explain: string[] = [];

  if (input.operatingMode !== "frozen") {
    return { category: "OTHER_BUG", explain: ["operatingMode is not frozen; unexpected input"] };
  }

  // If runtime is frozen because phase is not ready (effectiveStatus=degraded),
  // classify based on degraded reasons + stream freshness signals.
  if (!input.runtimeMarkedReady || input.automationPermitted === false) {
    explain.push(`runtimeMarkedReady=${input.runtimeMarkedReady}`);
    explain.push(`automationPermitted=${input.automationPermitted}`);
    if (input.operatingModeSource === "phase") {
      const now = Date.now();
      const marketAgeMs =
        input.marketLastDataEventAt ? now - new Date(input.marketLastDataEventAt).getTime() : null;
      if (input.degradedReasons.includes("degraded_asset_ratio_high") && marketAgeMs != null) {
        const legitIfMarketFresh = marketAgeMs <= DEFAULT_STREAM_WATCHDOG_CONFIG.marketDataDegradedThresholdMs;
        if (legitIfMarketFresh && input.operationalReadiness === true) {
          return { category: "LATCH_NOT_CLEARING", explain };
        }
      }
      return { category: "LEGITIMATE_RUNTIME_FREEZE", explain };
    }
    return { category: "WRONG_GATING_SOURCE", explain };
  }

  if (input.safeToAutomate !== false) {
    // If we are here, operatingMode is frozen but automationPermitted/runtime phase appear OK; logic mismatch.
    return { category: "OTHER_BUG", explain: ["operatingMode=frozen but safeToAutomate is not false"] };
  }

  if (input.globalAutomationEnabled === false) {
    explain.push("globalAutomationEnabled=false (kill switch / operator stop)");
    return { category: "KILL_SWITCH_STATE_MISMATCH", explain };
  }

  const now = Date.now();
  const ordersTruthThresholdMs = 120_000; // matches reconciliationHealthy logic in runtime-health.ts
  const marketAgeMs =
    input.marketLastDataEventAt ? now - new Date(input.marketLastDataEventAt).getTime() : null;
  const userAgeMs =
    input.userLastDataEventAt ? now - new Date(input.userLastDataEventAt).getTime() : null;
  const marketDegradedThresholdMs = DEFAULT_STREAM_WATCHDOG_CONFIG.marketDataDegradedThresholdMs;
  const userDegradedThresholdMs = DEFAULT_STREAM_WATCHDOG_CONFIG.userDataDegradedThresholdMs;

  if (input.reconciliationHealthy === false) {
    explain.push(`reconciliationHealthy=false (lastAt=${input.reconciliationLastAt ?? "—"})`);
    if (input.reconciliationLastAt) {
      const age = now - new Date(input.reconciliationLastAt).getTime();
      explain.push(`reconciliationAgeMs=${age} (threshold=${ordersTruthThresholdMs})`);
      if (age > ordersTruthThresholdMs) {
        return { category: "LEGITIMATE_RUNTIME_FREEZE", explain };
      }
    }
    // reconciliationHealthy false but not obviously stale => likely stale input / latch.
    return { category: "STALE_READINESS_INPUT", explain };
  }

  if (input.operationalReadiness === false) {
    explain.push("operationalReadiness=false");
    explain.push(`marketLastDataEventAt=${input.marketLastDataEventAt ?? "—"}`);
    explain.push(`userLastDataEventAt=${input.userLastDataEventAt ?? "—"}`);
    if (marketAgeMs != null && marketAgeMs > marketDegradedThresholdMs) {
      explain.push(`marketAgeMs=${marketAgeMs} > marketDataDegradedThresholdMs=${marketDegradedThresholdMs}`);
      return { category: "LEGITIMATE_RUNTIME_FREEZE", explain };
    }
    if (userAgeMs != null && userAgeMs > userDegradedThresholdMs) {
      explain.push(`userAgeMs=${userAgeMs} > userDataDegradedThresholdMs=${userDegradedThresholdMs}`);
      return { category: "LEGITIMATE_RUNTIME_FREEZE", explain };
    }
    return { category: "STALE_READINESS_INPUT", explain };
  }

  // safeToAutomate=false while both operationalReadiness and reconciliationHealthy are true suggests a logic latch/mismatch.
  if (input.operatingMode === "frozen") {
    explain.push("operatingMode=frozen but readiness inputs appear healthy");
    return { category: "LATCH_NOT_CLEARING", explain };
  }

  return { category: "OTHER_BUG", explain };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const nowMs = Date.now();

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, status: true, metadataJson: true },
  });
  const hbFresh = hb ? heartbeatIsFresh(hb.lastSeenAt, nowMs, HEARTBEAT_FRESH_MS) : false;
  const dbOk = !!hb;

  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? undefined);
  const runtimeHealth = asRecord(meta?.runtimeHealth) ?? null;
  const runtimeSafety = asRecord(meta?.runtimeSafety) ?? null;
  const liveReadiness = asRecord(meta?.liveReadiness) ?? null;

  const canonical = extractCanonicalWorkerRuntime(meta);
  const runtimeSafetyState = canonical.runtimeSafetyState;

  const runtimeStatus =
    runtimeHealth?.status && typeof runtimeHealth.status === "string" ? (runtimeHealth.status as string) : null;
  const lifecycleStatus =
    runtimeHealth?.lifecycleStatus && typeof runtimeHealth.lifecycleStatus === "string"
      ? (runtimeHealth.lifecycleStatus as string)
      : null;
  const runtimeMarkedReady = runtimeStatus === "ready" || lifecycleStatus === "ready";

  const globalAutomationEnabled =
    runtimeHealth && typeof runtimeHealth.globalAutomationEnabled === "boolean"
      ? (runtimeHealth.globalAutomationEnabled as boolean)
      : null;

  const degradedReasons = Array.isArray(runtimeHealth?.degradedReasons) ? (runtimeHealth!.degradedReasons as string[]) : [];
  const watchdogReasons = Array.isArray(runtimeHealth?.watchdogReasons) ? (runtimeHealth!.watchdogReasons as string[]) : [];
  const watchdogState = typeof runtimeHealth?.watchdogState === "string" ? (runtimeHealth!.watchdogState as string) : null;

  const operatorHealth = runtimeHealth?.operatorHealth ? asRecord(runtimeHealth.operatorHealth) : null;
  const readiness = operatorHealth?.readiness ? asRecord(operatorHealth.readiness) : null;
  const opReconciliation = operatorHealth?.reconciliation ? asRecord(operatorHealth.reconciliation) : null;
  const opKillSwitch = operatorHealth?.killSwitch ? asRecord(operatorHealth.killSwitch) : null;

  const operationalReadiness = readiness?.operationalReadiness;
  const automationPermitted = readiness?.automationPermitted;
  const safeToAutomate = readiness?.safeToAutomate;
  const runtimePhase = readiness?.runtimePhase;

  const reconciliationHealthy = opReconciliation?.healthy;
  const reconciliationLastAt = typeof opReconciliation?.lastSuccessAt === "string" ? (opReconciliation!.lastSuccessAt as string) : null;
  const reconciliationLastAtAlt = runtimeHealth?.reconciliation?.lastAt && typeof runtimeHealth.reconciliation.lastAt === "string"
    ? (runtimeHealth.reconciliation.lastAt as string)
    : null;

  const streams = runtimeHealth?.streams ? asRecord(runtimeHealth.streams) : null;
  const socketOpen = streams?.socketOpen;
  const dataFlowHealthy = streams?.dataFlowHealthy;
  const marketLastDataEventAt = typeof streams?.marketLastDataEventAt === "string" ? (streams!.marketLastDataEventAt as string) : null;
  const userLastDataEventAt = typeof streams?.userLastDataEventAt === "string" ? (streams!.userLastDataEventAt as string) : null;

  const operatingMode = pickOperatingMode(runtimeHealth);
  const operatingModeSource = pickOperatingModeSource(runtimeHealth);

  const liveReadinessOverallState = typeof liveReadiness?.overallState === "string" ? (liveReadiness!.overallState as string) : null;
  const liveReadinessAllowLiveTrading =
    typeof liveReadiness?.allowLiveTrading === "boolean" ? (liveReadiness!.allowLiveTrading as boolean) : null;
  const liveReadinessBlockingReasons = toReasonArray(liveReadiness?.blockingReasons).slice(0, 25);

  const verdict = computeVerdict({
    runtimeStatus,
    lifecycleStatus,
    runtimeMarkedReady,
    runtimeSafetyState,
    safeToAutomate: typeof safeToAutomate === "boolean" ? (safeToAutomate as boolean) : null,
  });

  const rootCause = classifyFreezeRootCause({
    globalAutomationEnabled,
    runtimeMarkedReady,
    automationPermitted: typeof automationPermitted === "boolean" ? (automationPermitted as boolean) : null,
    safeToAutomate: typeof safeToAutomate === "boolean" ? (safeToAutomate as boolean) : null,
    operationalReadiness: typeof operationalReadiness === "boolean" ? (operationalReadiness as boolean) : null,
    reconciliationHealthy: typeof reconciliationHealthy === "boolean" ? (reconciliationHealthy as boolean) : null,
    reconciliationLastAt: reconciliationLastAt ?? reconciliationLastAtAlt,
    marketLastDataEventAt,
    userLastDataEventAt,
    operatingMode,
    operatingModeSource,
    degradedReasons,
    runtimeSafetyState,
    watchdogReasons,
    liveReadinessBlockingReasons,
  });

  // ---- Recent blocked runtime_automated candidates ----
  const candidateWindowStart = new Date(nowMs - CANDIDATES_WINDOW_MS);
  const recentCandidatesRaw = await prisma.shadowCandidate.findMany({
    where: {
      candidateSource: "runtime_automated",
      wasBlocked: true,
      createdAt: { gte: candidateWindowStart },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(200, CANDIDATES_LIMIT * 5),
    select: {
      id: true,
      funderAddress: true,
      recommendationId: true,
      orderIntentId: true,
      createdAt: true,
      wasBlocked: true,
      wasSubmitted: true,
      blockingReasons: true,
      assetId: true,
      marketId: true,
    },
  });

  const reasonsFreezeRelatedRe = /(reconciliation|exchange_truth|operational|kill_switch|user_data|market_data|truth_stale|data_stale)/i;
  const recentCandidates = recentCandidatesRaw.slice(0, CANDIDATES_LIMIT).map((c) => {
    const reasons = toReasonArray(c.blockingReasons);
    const freezeRelated = reasons.some((r) => reasonsFreezeRelatedRe.test(r));
    return {
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      wasBlocked: c.wasBlocked,
      wasSubmitted: c.wasSubmitted ?? false,
      blockingReasons: reasons.slice(0, 10),
      freezeRelated,
      freezeRelatedReasonSample: reasons.find((r) => reasonsFreezeRelatedRe.test(r)) ?? null,
      assetId: c.assetId,
      marketId: c.marketId,
    };
  });

  // ---- Readiness component breakdown objects ----
  const componentBreakdown: Array<{
    component: string;
    currentValue: boolean | string | null;
    source: string;
    freshness: { timestamp: string | null; ageMs: number | null };
    blocksSafeToAutomate: boolean;
    appearsLegitimate: boolean;
  }> = [];

  const reconciliationOk = typeof reconciliationHealthy === "boolean" ? (reconciliationHealthy as boolean) : null;
  const operationalOk = typeof operationalReadiness === "boolean" ? (operationalReadiness as boolean) : null;

  const reconciliationTimestamp = reconciliationLastAt ?? reconciliationLastAtAlt;
  const reconciliationAgeMs = reconciliationTimestamp ? nowMs - new Date(reconciliationTimestamp).getTime() : null;

  componentBreakdown.push({
    component: "globalAutomationEnabled",
    currentValue: globalAutomationEnabled,
    source: "worker heartbeat: runtimeHealth.globalAutomationEnabled (kill switch / operator stop)",
    freshness: { timestamp: null, ageMs: null },
    blocksSafeToAutomate: globalAutomationEnabled === false,
    appearsLegitimate: globalAutomationEnabled !== false,
  });

  componentBreakdown.push({
    component: "operationalReadiness",
    currentValue: operationalOk,
    source:
      "operatorHealth.readiness.operationalReadiness (computed as runtimePhase=='ready' && socketOpen && dataFlowHealthy)",
    freshness: { timestamp: marketLastDataEventAt ?? userLastDataEventAt, ageMs: null },
    blocksSafeToAutomate: operationalOk === false,
    appearsLegitimate:
      operationalOk === true
        ? true
        : (() => {
            // If streams report stale timestamps beyond thresholds, then it's legitimate.
            const marketAge = marketLastDataEventAt ? nowMs - new Date(marketLastDataEventAt).getTime() : null;
            const userAge = userLastDataEventAt ? nowMs - new Date(userLastDataEventAt).getTime() : null;
            if (marketAge != null && marketAge > DEFAULT_STREAM_WATCHDOG_CONFIG.marketDataDegradedThresholdMs) return true;
            if (userAge != null && userAge > DEFAULT_STREAM_WATCHDOG_CONFIG.userDataDegradedThresholdMs) return true;
            return false;
          })(),
  });

  componentBreakdown.push({
    component: "reconciliationHealthy",
    currentValue: reconciliationOk,
    source: "operatorHealth.reconciliation.healthy (runtime reconciliation last success within threshold)",
    freshness: { timestamp: reconciliationTimestamp, ageMs: reconciliationAgeMs },
    blocksSafeToAutomate: reconciliationOk === false,
    appearsLegitimate:
      reconciliationAgeMs != null ? reconciliationAgeMs > 120_000 : false,
  });

  componentBreakdown.push({
    component: "automationPermitted",
    currentValue: typeof automationPermitted === "boolean" ? (automationPermitted as boolean) : automationPermitted ?? null,
    source: "operatorHealth.readiness.automationPermitted (= runtimePhase=='ready' && globalAutomationEnabled)",
    freshness: { timestamp: null, ageMs: null },
    blocksSafeToAutomate: safeToAutomate === false,
    appearsLegitimate: true,
  });

  componentBreakdown.push({
    component: "safeToAutomate",
    currentValue: typeof safeToAutomate === "boolean" ? (safeToAutomate as boolean) : safeToAutomate ?? null,
    source: "operatorHealth.readiness.safeToAutomate (= operationalReadiness && globalAutomationEnabled && reconciliationHealthy)",
    freshness: { timestamp: reconciliationTimestamp, ageMs: reconciliationAgeMs },
    blocksSafeToAutomate: true,
    appearsLegitimate: rootCause.category === "LEGITIMATE_RUNTIME_FREEZE",
  });

  // ---- Build markdown ----
  const mdLines: string[] = [];
  mdLines.push(`# safeToAutomate Freeze Report`);
  mdLines.push(`Generated at: ${generatedAt}`);
  mdLines.push(``);
  mdLines.push(`## 1) Runtime / permission snapshot`);
  mdLines.push(`- runtimeStatus: **${runtimeStatus ?? "—"}** · lifecycleStatus: **${lifecycleStatus ?? "—"}**`);
  mdLines.push(`- runtimeMarkedReady: **${runtimeMarkedReady}**`);
  mdLines.push(`- globalAutomationEnabled: **${globalAutomationEnabled ?? "—"}**`);
  mdLines.push(`- automationPermitted: **${typeof automationPermitted === "boolean" ? automationPermitted : "—"}**`);
  mdLines.push(`- safeToAutomate: **${typeof safeToAutomate === "boolean" ? safeToAutomate : "—"}**`);
  mdLines.push(`- runtimeSafetyState: **${runtimeSafetyState ?? "—"}**`);
  mdLines.push(`- current degraded reasons: ${degradedReasons.length ? degradedReasons.slice(0, 10).join(", ") : "(none)"}`);
  mdLines.push(`- current watchdogState: **${watchdogState ?? "—"}** · watchdogReasons: ${watchdogReasons.length ? watchdogReasons.slice(0, 10).join(", ") : "(none)"}`);
  mdLines.push(`- operatingMode: **${operatingMode ?? "—"}** · operatingModeSource: **${operatingModeSource ?? "—"}**`);
  mdLines.push(`- liveReadiness (if present): overallState=${liveReadinessOverallState ?? "—"} allowLiveTrading=${liveReadinessAllowLiveTrading ?? "—"}`);
  mdLines.push(`- liveReadiness.blockingReasons: ${liveReadinessBlockingReasons.length ? liveReadinessBlockingReasons.join(", ") : "(none)"}`);
  mdLines.push(``);

  mdLines.push(`## 2) Readiness component breakdown`);
  mdLines.push(`| component | value | blocks safeToAutomate? | appears legit? | source | freshness |`);
  mdLines.push(`|---|---|---:|---:|---|---|`);
  for (const comp of componentBreakdown) {
    const freshness = comp.freshness.timestamp
      ? `${comp.freshness.timestamp} (ageMs=${comp.freshness.ageMs ?? "—"})`
      : "(n/a)";
    mdLines.push(
      `| ${comp.component} | ${String(comp.currentValue)} | ${comp.blocksSafeToAutomate} | ${comp.appearsLegitimate} | ${excerpt(
        comp.source,
        110
      ) ?? "—"} | ${excerpt(freshness, 140) ?? "—"} |`
    );
  }
  mdLines.push(``);

  mdLines.push(`## 3) Kill-switch / latch state`);
  mdLines.push(`- operatorHealth.killSwitch.tripped: **${typeof opKillSwitch?.tripped === "boolean" ? opKillSwitch.tripped : "—"}**`);
  mdLines.push(
    `- operatorHealth.killSwitch.reasons: ${
      Array.isArray(opKillSwitch?.reasons) ? (opKillSwitch!.reasons as string[]).slice(0, 15).join(", ") : "(none)"
    }`
  );
  mdLines.push(`- operatorHealth.killSwitch.globalAutomationEnabled: **${typeof opKillSwitch?.globalAutomationEnabled === "boolean" ? opKillSwitch.globalAutomationEnabled : "—"}**`);
  mdLines.push(`- runtimeSafety.blockingReasons: ${runtimeSafety && Array.isArray(runtimeSafety.blockingReasons) ? (runtimeSafety.blockingReasons as string[]).slice(0, 15).join(", ") : "(none)"}`);
  mdLines.push(``);

  mdLines.push(`## 4) Recent blocked candidates (runtime_automated)`);
  mdLines.push(`- windowMs: ${CANDIDATES_WINDOW_MS} · limit: ${CANDIDATES_LIMIT}`);
  if (recentCandidates.length === 0) {
    mdLines.push(`- (none found)`);
  } else {
    mdLines.push(`| createdAt | wasSubmitted | concise blockingReasons | freezeRelated? | freezeReasonSample | assetId | marketId |`);
    mdLines.push(`|---|---:|---|---:|---|---|---|`);
    for (const c of recentCandidates) {
      const concise = c.blockingReasons.join("; ");
      mdLines.push(
        `| ${c.createdAt} | ${c.wasSubmitted} | ${excerpt(concise, 120) ?? "—"} | ${c.freezeRelated} | ${excerpt(c.freezeRelatedReasonSample ?? undefined, 90) ?? "—"} | ${c.assetId} | ${c.marketId ?? "—"} |`
      );
    }
  }
  mdLines.push(``);

  mdLines.push(`## 5) Root cause & fix summary`);
  mdLines.push(`- rootCauseCategory: **${rootCause.category}**`);
  for (const e of rootCause.explain.slice(0, 8)) {
    mdLines.push(`- ${e}`);
  }
  mdLines.push(``);

  mdLines.push(`## 6) Overall verdict`);
  mdLines.push(`- verdict: **${verdict.verdict}**`);
  for (const w of verdict.why.slice(0, 8)) mdLines.push(`- ${w}`);

  const report = {
    generatedAt,
    dbOk,
    heartbeat: {
      workerName: WORKER_NAME,
      lastSeenAt: hb?.lastSeenAt ? hb.lastSeenAt.toISOString() : null,
      heartbeatFresh: hbFresh,
      status: hb?.status ?? null,
    },
    runtimeSnapshot: {
      runtimeStatus,
      lifecycleStatus,
      runtimeMarkedReady,
      runtimeSafetyState,
      runtimeSafety: runtimeSafety ? { state: runtimeSafety.state ?? null, blockingReasons: toReasonArray(runtimeSafety.blockingReasons), warnings: runtimeSafety.warnings ? toReasonArray(runtimeSafety.warnings) : [] } : null,
      degradedReasons,
      watchdogState,
      watchdogReasons,
      operatingMode,
      operatingModeSource,
      globalAutomationEnabled,
      operatorHealth: {
        readiness: {
          runtimePhase: typeof runtimePhase === "string" ? runtimePhase : null,
          operationalReadiness: typeof operationalReadiness === "boolean" ? operationalReadiness : null,
          automationPermitted: typeof automationPermitted === "boolean" ? automationPermitted : null,
          safeToAutomate: typeof safeToAutomate === "boolean" ? safeToAutomate : null,
        },
        reconciliation: opReconciliation
          ? {
              healthy: typeof opReconciliation.healthy === "boolean" ? opReconciliation.healthy : null,
              lastRunAt: typeof opReconciliation.lastRunAt === "string" ? opReconciliation.lastRunAt : null,
              lastSuccessAt: typeof opReconciliation.lastSuccessAt === "string" ? opReconciliation.lastSuccessAt : null,
              driftDetected: typeof opReconciliation.driftDetected === "boolean" ? opReconciliation.driftDetected : null,
              reconcileDurationMs: typeof opReconciliation.reconcileDurationMs === "number" ? opReconciliation.reconcileDurationMs : null,
            }
          : null,
        killSwitch: opKillSwitch
          ? {
              globalAutomationEnabled: typeof opKillSwitch.globalAutomationEnabled === "boolean" ? opKillSwitch.globalAutomationEnabled : null,
              tripped: typeof opKillSwitch.tripped === "boolean" ? opKillSwitch.tripped : null,
              reasons: Array.isArray(opKillSwitch.reasons) ? (opKillSwitch.reasons as string[]) : [],
            }
          : null,
      },
      streams: {
        socketOpen: typeof socketOpen === "boolean" ? socketOpen : null,
        dataFlowHealthy: typeof dataFlowHealthy === "boolean" ? dataFlowHealthy : null,
        marketLastDataEventAt,
        userLastDataEventAt,
        marketLastHeartbeatAt: typeof streams?.marketLastHeartbeatAt === "string" ? (streams!.marketLastHeartbeatAt as string) : null,
        userLastHeartbeatAt: typeof streams?.userLastHeartbeatAt === "string" ? (streams!.userLastHeartbeatAt as string) : null,
        operationalReadiness: typeof streams?.operationalReadiness === "boolean" ? (streams!.operationalReadiness as boolean) : null,
      },
      liveReadiness: liveReadiness
        ? {
            overallState: liveReadinessOverallState,
            allowLiveTrading: liveReadinessAllowLiveTrading,
            blockingReasons: liveReadinessBlockingReasons,
            evaluatedAt: typeof liveReadiness?.evaluatedAt === "string" ? (liveReadiness!.evaluatedAt as string) : null,
          }
        : null,
    },
    readinessComponents: componentBreakdown,
    recentBlockedCandidates: recentCandidates,
    rootCause,
    verdict,
  };

  const jsonPath = path.join(DUMP_DIR, "safe-to-automate-freeze-report.json");
  const mdPath = path.join(DUMP_DIR, "safe-to-automate-freeze-report.md");

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  await fs.writeFile(mdPath, mdLines.join("\n"), "utf-8");

  console.log(
    JSON.stringify(
      {
        verdict: verdict.verdict,
        rootCauseCategory: rootCause.category,
        runtimeStatus,
        lifecycleStatus,
        runtimeMarkedReady,
        globalAutomationEnabled,
        automationPermitted,
        safeToAutomate,
        operatorOperationalReadiness: typeof operationalReadiness === "boolean" ? operationalReadiness : null,
        operatorReconciliationHealthy: typeof reconciliationHealthy === "boolean" ? reconciliationHealthy : null,
        reconciliationLastAt: reconciliationLastAt ?? reconciliationLastAtAlt,
        marketLastDataEventAt,
        userLastDataEventAt,
        operatingMode,
      },
      null,
      2
    )
  );
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("safe-to-automate-freeze-report failed", err);
  process.exit(1);
});

