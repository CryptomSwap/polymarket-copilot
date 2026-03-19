/**
 * Paper concentration/exposure block audit (deterministic, bounded).
 *
 * Goal: explain why paper candidates derived from staged BLOCK decisions
 * are not being relaxed/admitted, focusing on:
 * - exposure:single_market_concentration_breach
 * - exposure:single_theme_concentration_breach
 *
 * This tool does not mutate runtime. It only reads DB + worker heartbeat metadata.
 *
 * Writes:
 * - dump/paper-concentration-block-report.json
 * - dump/paper-concentration-block-report.md
 *
 * npm run dump:paper-concentration-block-report
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
import { classifyPaperRelaxationEligibility, parseBlockingReasonsFromSnapshot } from "../lib/paper-trading/paper-relaxation";

const DUMP_DIR = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";
const HEARTBEAT_FRESH_MS = Number(process.env.STABILIZATION_HEARTBEAT_FRESH_MS ?? "90000") || 90_000;

const CANDIDATES_LIMIT = Number(process.env.PAPER_CONCENTRATION_REPORT_LIMIT ?? "20") || 20;
const CANDIDATES_WINDOW_MS = Number(process.env.PAPER_CONCENTRATION_REPORT_WINDOW_MS ?? String(8 * 60 * 60 * 1000)) || 8 * 60 * 60 * 1000;

type Verdict =
  | "HEALTHY_AND_OPERATING"
  | "HEALTHY_BUT_IDLE"
  | "BOOTED_BUT_FROZEN"
  | "DEGRADED"
  | "BROKEN";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function excerpt(s: string | null | undefined, max = 220): string | null {
  if (s == null || s === "") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function parseJsonSafe<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toStringArray(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    // Some snapshots store a single string that itself contains multiple reasons.
    return raw
      .split(/[;|,]/g)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function guessConcentrationBlockReasons(reasons: string[]): { market: boolean; theme: boolean } {
  const joined = reasons.join("|").toLowerCase();
  return {
    market:
      joined.includes("single_market_concentration_breach") ||
      joined.includes("market_concentration_breach") ||
      (joined.includes("single_market") && joined.includes("concentration")),
    theme:
      joined.includes("single_theme_concentration_breach") ||
      joined.includes("theme_concentration_breach") ||
      (joined.includes("single_theme") && joined.includes("concentration")),
  };
}

function extractConcentrationMetricsFromPortfolioFitReasons(reasons: string[]): {
  currentSingleMarketConcentrationPct: number | null;
  marketLimitPct: number | null;
  currentSingleThemeConcentrationPct: number | null;
  themeLimitPct: number | null;
  matchedMessagesTop: string[];
} {
  // From lib/portfolio-risk/calculate.ts message patterns.
  const marketRe =
    /Single market concentration\s+([0-9]+(?:\.[0-9]+)?)%\s+exceeds limit\s+([0-9]+(?:\.[0-9]+)?)%/i;
  const themeRe =
    /Single theme concentration\s+([0-9]+(?:\.[0-9]+)?)%\s+exceeds limit\s+([0-9]+(?:\.[0-9]+)?)%/i;

  let currentSingleMarketConcentrationPct: number | null = null;
  let marketLimitPct: number | null = null;
  let currentSingleThemeConcentrationPct: number | null = null;
  let themeLimitPct: number | null = null;
  const matchedMessagesTop: string[] = [];

  for (const r of reasons) {
    const marketMatch = marketRe.exec(r);
    if (marketMatch) {
      currentSingleMarketConcentrationPct = Number(marketMatch[1]);
      marketLimitPct = Number(marketMatch[2]);
      matchedMessagesTop.push(excerpt(r, 160) ?? r);
      continue;
    }
    const themeMatch = themeRe.exec(r);
    if (themeMatch) {
      currentSingleThemeConcentrationPct = Number(themeMatch[1]);
      themeLimitPct = Number(themeMatch[2]);
      matchedMessagesTop.push(excerpt(r, 160) ?? r);
      continue;
    }
  }

  return {
    currentSingleMarketConcentrationPct,
    marketLimitPct,
    currentSingleThemeConcentrationPct,
    themeLimitPct,
    matchedMessagesTop: matchedMessagesTop.slice(0, 5),
  };
}

function summarizeReasonCounts(reasons: string[][]): Array<{ reason: string; count: number }> {
  const m = new Map<string, number>();
  for (const arr of reasons) {
    for (const r of arr) {
      const k = r.trim();
      if (!k) continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return [...m.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

function inferStageFromRuntimeBlockReasons(reasons: string[]): string {
  // Deterministic attribution based on prefix conventions from evaluateExecutionPolicy().
  // Example: "exposure:single_market_concentration_breach; single_theme_concentration_breach"
  const joined = reasons.join(";");
  if (joined.includes("exposure:")) return "lib/execution-policy/evaluate.ts:checkExposure";
  if (joined.includes("liquidity:")) return "lib/execution-policy/evaluate.ts:checkLiquidity";
  if (joined.includes("freshness:")) return "lib/execution-policy/evaluate.ts:checkFreshness";
  if (joined.includes("operational:")) return "lib/execution-policy/evaluate.ts:checkOperationalSafety";
  return "unknown_stage";
}

function summarizeVerdict(input: {
  runtimeStatus: string | null;
  lifecycleStatus: string | null;
  runtimeSafetyState: string | null;
  degradedReasons: string[];
  paperTradesOpenCount: number;
  paperRelaxationEligibleCount: number;
}): { verdict: Verdict; why: string[] } {
  const why: string[] = [];
  if (input.runtimeSafetyState === "blocked" || input.runtimeSafetyState === "degraded") {
    why.push(`runtimeSafety.state=${input.runtimeSafetyState}`);
    return { verdict: "DEGRADED", why };
  }
  if (input.runtimeStatus === "degraded" || input.lifecycleStatus === "degraded") {
    why.push("runtime status/lifecycle degraded");
    // If paper trades still 0 while relaxation appears eligible, treat as degraded (not healthy).
    if (input.paperTradesOpenCount === 0 && input.paperRelaxationEligibleCount > 0) {
      why.push("paper relaxation appears eligible but no open PaperTrades (pipeline blocked elsewhere).");
    } else if (input.paperTradesOpenCount === 0) {
      why.push("no open PaperTrades (concentration blocks not relaxed/admitted).");
    }
    return { verdict: "DEGRADED", why };
  }
  if (input.paperTradesOpenCount === 0 && input.paperRelaxationEligibleCount === 0) {
    why.push("no open PaperTrades and no eligible relaxed concentration candidates.");
    return { verdict: "BOOTED_BUT_FROZEN", why };
  }
  if (input.degradedReasons.length > 0) {
    why.push(`degraded reasons present: ${input.degradedReasons.slice(0, 6).join(", ")}`);
    return { verdict: "DEGRADED", why };
  }
  if (input.paperTradesOpenCount === 0) {
    why.push("healthy runtime, but paper engine currently has no open PaperTrades.");
    return { verdict: "HEALTHY_BUT_IDLE", why };
  }
  why.push("runtime looks operational and paper trades are opening.");
  return { verdict: "HEALTHY_AND_OPERATING", why };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const now = Date.now();

  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, status: true, metadataJson: true },
  });
  const dbOk = !!hb;
  const meta = parseHeartbeatMetadataJson(hb?.metadataJson ?? undefined);
  const runtimeHealth = (meta?.runtimeHealth ?? null) as Record<string, unknown> | null;
  const runtimeSafety = asRecord(meta?.runtimeSafety);
  const canonical = extractCanonicalWorkerRuntime(meta);
  const heartbeatFresh = hb ? heartbeatIsFresh(hb.lastSeenAt, now, HEARTBEAT_FRESH_MS) : false;

  const status = runtimeHealth && typeof runtimeHealth.status === "string" ? runtimeHealth.status : null;
  const lifecycleStatus =
    runtimeHealth && typeof runtimeHealth.lifecycleStatus === "string" ? runtimeHealth.lifecycleStatus : null;
  const globalAutomationEnabled =
    runtimeHealth && typeof runtimeHealth.globalAutomationEnabled === "boolean"
      ? runtimeHealth.globalAutomationEnabled
      : null;

  const operatorHealth = asRecord(runtimeHealth?.operatorHealth);
  const opReadiness = asRecord(operatorHealth?.readiness);
  const automationPermitted = typeof opReadiness?.automationPermitted === "boolean" ? opReadiness.automationPermitted : null;
  const safeToAutomate = typeof opReadiness?.safeToAutomate === "boolean" ? opReadiness.safeToAutomate : null;
  const runtimeMarkedReady = status === "ready" || lifecycleStatus === "ready";

  const degradedReasons = Array.isArray(runtimeHealth?.degradedReasons) ? (runtimeHealth!.degradedReasons as string[]) : [];

  const runtimeSafetyState = runtimeSafety && typeof runtimeSafety.state === "string" ? runtimeSafety.state : null;

  // Paper engine surface check.
  const paperTradesOpenCount = await prisma.paperTrade.count({ where: { status: "open" } });
  const paperTradesOpenRelaxedConcentrationCount = await prisma.paperTrade.count({
    where: { status: "open", paperRelaxationReason: "concentration_high" },
  });

  // Identify concentration-related BLOCKED runtime_automated candidates.
  // We over-fetch and then filter to avoid accidentally sampling the wrong block reason cohort.
  const candidatePool = await prisma.shadowCandidate.findMany({
    where: {
      wasBlocked: true,
      candidateSource: "runtime_automated",
      createdAt: { gte: new Date(now - CANDIDATES_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(200, Math.max(50, CANDIDATES_LIMIT * 10)),
    select: {
      id: true,
      recommendationId: true,
      createdAt: true,
      wasSubmitted: true,
      wasBlocked: true,
      candidateSource: true,
      assetId: true,
      marketId: true,
      side: true,
      blockingReasons: true,
      funderAddress: true,
    },
  });

  const blockedCandidates = candidatePool
    .filter((c) => {
      const reasons = toStringArray(c.blockingReasons);
      const conc = guessConcentrationBlockReasons(reasons);
      return conc.market || conc.theme;
    })
    .slice(0, CANDIDATES_LIMIT);

  const candidatePoolTopReasons = summarizeReasonCounts(
    candidatePool.slice(0, 50).map((c) => toStringArray(c.blockingReasons))
  );
  const candidatePoolConcentrationMatches = blockedCandidates.length;

  const funderAddress: string | null = blockedCandidates[0]?.funderAddress ?? null;

  // Pull corresponding DecisionPolicySnapshot rows for paper relaxation eligibility checks.
  const recIds = [
    ...new Set(blockedCandidates.map((c) => c.recommendationId).filter((x): x is string => typeof x === "string")),
  ];
  const decisionSnapshots = recIds.length && funderAddress
    ? await prisma.decisionPolicySnapshot.findMany({
        where: { recommendationId: { in: recIds }, funderAddress },
        select: { recommendationId: true, policyState: true, finalSuggestedSize: true, reasoningJson: true },
      })
    : [];
  const decisionByRecId = new Map<string, (typeof decisionSnapshots)[0]>();
  for (const s of decisionSnapshots) decisionByRecId.set(s.recommendationId, s);

  const analyzedCandidates: Array<{
    id: string;
    createdAt: string;
    marketId: string | null;
    assetId: string;
    candidateSource: string;
    wasBlocked: boolean;
    wasSubmitted: boolean | null;
    blockReasonStrings: string[];
    concentrationBlock: { market: boolean; theme: boolean };
    stageAttribution: string;
    portfolioConcentration: {
      maxSingleMarketConcentrationPct: number | null;
      maxSingleThemeConcentrationPct: number | null;
      concentrationFlagsCount: number | null;
      concentrationFlagsTop: Array<{ code: string | null; value: number | null; threshold: number | null; scope: string | null; message: string | null }>;
    };
    paperRelaxation: {
      policyState: string | null;
      finalSuggestedSize: string | null;
      parsedBlockingReasonsCount: number;
      parsedBlockingReasonsSample: string[];
      eligibility: {
        eligible: boolean;
        mode: string;
        relaxationReason: string | null;
        rejectionReason?: string | null;
      };
    };
  }> = [];

  let paperRelaxationEligibleCount = 0;

  for (const c of blockedCandidates) {
    const reasons = toStringArray(c.blockingReasons);
    const conc = guessConcentrationBlockReasons(reasons);
    const stageAttribution = inferStageFromRuntimeBlockReasons(reasons);

    const decision = c.recommendationId ? decisionByRecId.get(c.recommendationId) : undefined;
    const policyState = decision?.policyState ?? null;
    const finalSuggestedSize = decision?.finalSuggestedSize ?? null;
    const reasoningJson = decision?.reasoningJson ?? null;
    const parsedFromSnapshot = parseBlockingReasonsFromSnapshot({ reasoningJson });
    const eligibility = policyState && reasoningJson != null ? classifyPaperRelaxationEligibility({ policyState, finalSuggestedSize, reasoningJson }) : null;

    if (eligibility?.eligible === true && eligibility.mode === "relaxed_block_candidate") {
      paperRelaxationEligibleCount++;
    }

    const reasoningObj = parseJsonSafe<any>(reasoningJson);
    const portfolioFitReasons: string[] = Array.isArray(reasoningObj?.portfolioFitReasons)
      ? (reasoningObj.portfolioFitReasons as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const concentrationMetrics = extractConcentrationMetricsFromPortfolioFitReasons(portfolioFitReasons);

    analyzedCandidates.push({
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      marketId: (typeof c.marketId === "string" ? c.marketId : null) as string | null,
      assetId: c.assetId,
      candidateSource: c.candidateSource,
      wasBlocked: c.wasBlocked,
      wasSubmitted: c.wasSubmitted,
      blockReasonStrings: reasons.slice(0, 15),
      concentrationBlock: conc,
      stageAttribution,
      portfolioConcentration: {
        maxSingleMarketConcentrationPct: concentrationMetrics.currentSingleMarketConcentrationPct,
        maxSingleThemeConcentrationPct: concentrationMetrics.currentSingleThemeConcentrationPct,
        concentrationFlagsCount: portfolioFitReasons.length ? portfolioFitReasons.length : null,
        concentrationFlagsTop: [
          ...(concentrationMetrics.currentSingleMarketConcentrationPct != null
            ? [
                {
                  code: null,
                  value: concentrationMetrics.currentSingleMarketConcentrationPct,
                  threshold: concentrationMetrics.marketLimitPct,
                  scope: "market",
                  message: concentrationMetrics.matchedMessagesTop[0] ?? null,
                },
              ]
            : []),
          ...(concentrationMetrics.currentSingleThemeConcentrationPct != null
            ? [
                {
                  code: null,
                  value: concentrationMetrics.currentSingleThemeConcentrationPct,
                  threshold: concentrationMetrics.themeLimitPct,
                  scope: "theme",
                  message: concentrationMetrics.matchedMessagesTop[1] ?? null,
                },
              ]
            : []),
        ].filter((x) => x.value != null || x.threshold != null || x.message != null),
      },
      paperRelaxation: {
        policyState,
        finalSuggestedSize,
        parsedBlockingReasonsCount: parsedFromSnapshot.length,
        parsedBlockingReasonsSample: parsedFromSnapshot.slice(0, 5),
        eligibility: eligibility
          ? {
              eligible: eligibility.eligible,
              mode: eligibility.mode,
              relaxationReason: eligibility.relaxationReason ?? null,
              rejectionReason: eligibility.rejectionReason ?? null,
            }
          : {
              eligible: false,
              mode: "unknown",
              relaxationReason: null,
              rejectionReason: "missing_decision_snapshot_or_reasoningJson",
            },
      },
    });
  }

  // Decide root cause category.
  // We only consider the relaxation eligibility/classification discrepancy first.
  const eligibleConcentrationAmongRecent = analyzedCandidates.filter((x) => x.paperRelaxation.eligibility.mode === "relaxed_block_candidate");
  const anyParsedConcentrationReason =
    analyzedCandidates.some((x) => x.paperRelaxation.parsedBlockingReasonsSample.join("|").toLowerCase().includes("concentration"));
  const majorityNoBlockingReasons =
    analyzedCandidates.length > 0 &&
    analyzedCandidates.filter((x) => x.paperRelaxation.parsedBlockingReasonsCount === 0).length / analyzedCandidates.length >= 0.7;

  let rootCause:
    | "LEGITIMATE_POLICY_BLOCK"
    | "PAPER_RELAXATION_NOT_APPLIED"
    | "STALE_EXPOSURE_INPUTS"
    | "INCORRECT_CONCENTRATION_CALCULATION"
    | "READINESS_PERMISSION_MISMATCH"
    | "OTHER_BUG" = "OTHER_BUG";
  if (paperTradesOpenCount > 0) {
    rootCause = "OTHER_BUG";
  } else if (analyzedCandidates.length === 0) {
    rootCause = "OTHER_BUG";
  } else if (eligibleConcentrationAmongRecent.length > 0 && analyzedCandidates.every((x) => x.concentrationBlock.market && x.concentrationBlock.theme)) {
    // Relaxation seems eligible, but nothing opens => likely gating caps/cooldowns or permissions.
    rootCause = "READINESS_PERMISSION_MISMATCH";
  } else if (majorityNoBlockingReasons) {
    rootCause = "PAPER_RELAXATION_NOT_APPLIED";
  } else if (!anyParsedConcentrationReason) {
    rootCause = "PAPER_RELAXATION_NOT_APPLIED";
  } else {
    // If paper relaxation is clearly ineligible due to disallowed/other blocks, treat as legitimate.
    const anyIneligibleDueToDisallowed =
      analyzedCandidates.filter((x) => x.paperRelaxation.eligibility.eligible === false).some((x) => (x.paperRelaxation.eligibility.rejectionReason ?? "").includes("disallowed"));
    rootCause = anyIneligibleDueToDisallowed ? "LEGITIMATE_POLICY_BLOCK" : "OTHER_BUG";
  }

  const { verdict, why: verdictWhy } = summarizeVerdict({
    runtimeStatus: status,
    lifecycleStatus,
    runtimeSafetyState,
    degradedReasons,
    paperTradesOpenCount,
    paperRelaxationEligibleCount,
  });

  const report = {
    generatedAt,
    canonicalWorker: canonical,
    runtime: {
      status,
      lifecycleStatus,
      runtimeMarkedReady,
      globalAutomationEnabled,
      automationPermitted,
      safeToAutomate,
      runtimeSafetyState,
      degradedReasons,
      heartbeatLastSeenAt: hb?.lastSeenAt?.toISOString() ?? null,
      heartbeatFresh,
    },
    paper: {
      paperTradesOpenCount,
      paperTradesOpenRelaxedConcentrationCount,
    },
    candidatePoolDiagnostics: {
      candidatePoolWindowCandidatesFetched: candidatePool.length,
      concentrationCandidatesMatched: candidatePoolConcentrationMatches,
      candidatePoolTopBlockingReasons: candidatePoolTopReasons,
    },
    concentrationSnapshot: {
      // We derive concentration metrics from the staged BLOCK snapshot's reasoningJson (portfolioFitReasons),
      // because ShadowCandidate does not persist the raw numeric concentration inputs for the execution policy gate.
      sourceCandidateAt: blockedCandidates[0]?.createdAt?.toISOString() ?? null,
      candidateId: blockedCandidates[0]?.id ?? null,
      funderAddress,
      limitsFromLatestDecisionSnapshotReasoningJson: {
        maxSingleMarketConcentrationPct: analyzedCandidates[0]?.portfolioConcentration.maxSingleMarketConcentrationPct ?? null,
        maxSingleThemeConcentrationPct: analyzedCandidates[0]?.portfolioConcentration.maxSingleThemeConcentrationPct ?? null,
        concentrationFlagsTop: analyzedCandidates[0]?.portfolioConcentration.concentrationFlagsTop ?? [],
      },
    },
    recentBlockedCandidates: analyzedCandidates,
    gatePathAttribution: {
      concentrationBlockReasonPrefix: "exposure:",
      latestStageAttribution: analyzedCandidates[0]?.stageAttribution ?? null,
      concentrationBlockProducedBy: "lib/execution-policy/evaluate.ts:checkExposure",
      paperRelaxationClassificationMechanism: "lib/paper-trading/paper-relaxation.ts:classifyPaperRelaxationEligibility",
    },
    rootCause,
    verdict: { verdict, why: verdictWhy, verdictDegradedReasons: degradedReasons },
  };

  const jsonPath = path.join(DUMP_DIR, "paper-concentration-block-report.json");
  const mdPath = path.join(DUMP_DIR, "paper-concentration-block-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper Concentration Block Report");
  md.push("");
  md.push(`Generated: **${generatedAt}**`);
  md.push("");
  md.push("## 1) Runtime / permission snapshot");
  md.push(`- status: **${status ?? "—"}** · lifecycle: **${lifecycleStatus ?? "—"}**`);
  md.push(`- runtimeMarkedReady: **${runtimeMarkedReady}**`);
  md.push(`- globalAutomationEnabled: **${globalAutomationEnabled ?? "—"}** · automationPermitted: **${automationPermitted ?? "—"}** · safeToAutomate: **${safeToAutomate ?? "—"}**`);
  md.push(`- runtimeSafetyState: **${runtimeSafetyState ?? "—"}** · heartbeatFresh: **${heartbeatFresh}**`);
  md.push(`- degradedReasons: ${degradedReasons.length ? degradedReasons.join(", ") : "—"}`);
  md.push("");
  md.push("## 2) Current concentration/exposure state (from latest blocked candidate snapshot)");
  md.push(`- using candidateId=${blockedCandidates[0]?.id ?? "—"} at ${blockedCandidates[0]?.createdAt?.toISOString() ?? "—"}`);
  md.push(
    `- maxSingleMarketConcentrationPct (current): **${analyzedCandidates[0]?.portfolioConcentration.maxSingleMarketConcentrationPct ?? "—"}** · marketLimitPct: **${
      analyzedCandidates[0]?.portfolioConcentration.concentrationFlagsTop.find((x) => x.scope === "market")?.threshold ?? "—"
    }** · maxSingleThemeConcentrationPct (current): **${analyzedCandidates[0]?.portfolioConcentration.maxSingleThemeConcentrationPct ?? "—"}** · themeLimitPct: **${
      analyzedCandidates[0]?.portfolioConcentration.concentrationFlagsTop.find((x) => x.scope === "theme")?.threshold ?? "—"
    }**`
  );
  md.push("");
  md.push("## 3) Recent blocked candidates (paper-relaxation attribution)");
  md.push(`Analyzed ${analyzedCandidates.length} concentration-breach candidates (limit ${CANDIDATES_LIMIT})`);
  md.push(
    `Candidate pool top blocking reasons (sample): ${candidatePoolTopReasons
      .map((t) => `${t.reason}(${t.count})`)
      .join(", ") || "—"}`
  );
  md.push("");
  for (const c of analyzedCandidates) {
    md.push(
      `- ${c.createdAt} · candId=${c.id.slice(0, 8)}… · marketId=${c.marketId ?? "—"} · assetId=${c.assetId.slice(0, 10)}…`
    );
    md.push(
      `  block: wasBlocked=${c.wasBlocked} wasSubmitted=${String(c.wasSubmitted)} · concentration={market:${c.concentrationBlock.market},theme:${c.concentrationBlock.theme}}`
    );
    md.push(`  blockingReasons(sample): ${c.blockReasonStrings.length ? c.blockReasonStrings.slice(0, 3).join(" | ") : "—"}`);
    md.push(
      `  portfolioRisk maxSingleMarketConcentrationPct=${c.portfolioConcentration.maxSingleMarketConcentrationPct ?? "—"} · maxSingleThemeConcentrationPct=${c.portfolioConcentration.maxSingleThemeConcentrationPct ?? "—"}`
    );
    md.push(
      `  paperRelaxation: parsedBlockingReasonsCount=${c.paperRelaxation.parsedBlockingReasonsCount} mode=${c.paperRelaxation.eligibility.mode} eligible=${c.paperRelaxation.eligibility.eligible} relaxationReason=${c.paperRelaxation.eligibility.relaxationReason ?? "—"} rejectionReason=${c.paperRelaxation.eligibility.rejectionReason ?? "—"}`
    );
  }
  md.push("");
  md.push("## 4) Gate path attribution");
  md.push(`- Runtime concentration block: ${inferStageFromRuntimeBlockReasons(["exposure:single_market_concentration_breach"])}`);
  md.push(`- Paper relaxation classifier: lib/paper-trading/paper-relaxation.ts`);
  md.push("");
  md.push("## 5) Root cause category");
  md.push(`- ${rootCause}`);
  md.push("");
  md.push("## 6) Overall verdict");
  md.push(`- **${verdict}**`);
  for (const w of verdictWhy) md.push(`- ${w}`);
  md.push("");

  await fs.writeFile(mdPath, md.join("\n"), "utf8");
  console.log("Wrote dump/paper-concentration-block-report.{json,md}");
}

main().catch((e) => {
  console.error("create-paper-concentration-block-report failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});

