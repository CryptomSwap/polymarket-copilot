/**
 * Paper admission-pressure report (current tick + historical context).
 *
 * Primary source of "current strictness": PaperTradingState.lastOpenTickResultJson
 * (contains candidatesLoaded/scored, opened/skipped, and bounded decisionTraceBundle
 * with rejectReasonCode taxonomy).
 *
 * Secondary context: ShadowCandidate aggregates over last 24h/7d
 * (historical runtime guardrail outcomes; can look noisy even when runtime is healthy now).
 *
 * Writes:
 * - dump/paper-admission-pressure-report.json
 * - dump/paper-admission-pressure-report.md
 *
 * Run: npm run dump:paper-admission-pressure-report
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { parseHeartbeatMetadataJson } from "../lib/ops/worker-heartbeat-canonical";

const DUMP = path.join(process.cwd(), "dump");
const WORKER_NAME = "polymarket-copilot-worker";

const H24_MS = 24 * 60 * 60 * 1000;
const D7_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_TRACE_LIMIT = 400; // PaperDecisionTraceBundle maxTracesStored

type CountMap = Map<string, number>;

function since(msAgo: number): Date {
  return new Date(Date.now() - msAgo);
}

function toReasonArray(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json.filter((x): x is string => typeof x === "string");
}

function topNFromMap(map: CountMap, n: number): { reason: string; count: number }[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([reason, count]) => ({ reason, count }));
}

async function aggregateShadowBlockingReasonsSince(
  sinceDate: Date,
  blockedOnly: boolean,
  scanBatch = 2500
): Promise<{ counts: CountMap; scannedRows: number }> {
  const counts: CountMap = new Map();
  let scannedRows = 0;
  let lastCreatedAt = new Date(0);

  for (;;) {
    const rows = await prisma.shadowCandidate.findMany({
      where: {
        createdAt: { gte: sinceDate, gt: lastCreatedAt },
        ...(blockedOnly ? { wasBlocked: true } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: scanBatch,
      select: { createdAt: true, blockingReasons: true },
    });

    if (rows.length === 0) break;
    for (const r of rows) {
      scannedRows++;
      const reasons = toReasonArray(r.blockingReasons);
      for (const s of reasons) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    lastCreatedAt = rows[rows.length - 1].createdAt;
    if (rows.length < scanBatch) break;
  }

  return { counts, scannedRows };
}

function ensureReasonCodeString(x: unknown): string | null {
  if (typeof x !== "string") return null;
  return x;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP, { recursive: true });

  const since24 = since(H24_MS);
  const since7d = since(D7_MS);

  // ---- runtime context (heartbeat only; not used to derive admission bottlenecks) ----
  const hb = await prisma.workerHeartbeat.findUnique({
    where: { workerName: WORKER_NAME },
    select: { lastSeenAt: true, metadataJson: true },
  });
  const metadata = parseHeartbeatMetadataJson(hb?.metadataJson ?? null) ?? null;
  const runtimeSafety = metadata?.runtimeSafety as Record<string, unknown> | null | undefined;
  const runtimeState = typeof runtimeSafety?.state === "string" ? (runtimeSafety.state as string) : null;
  const runtimeBlockingReasons = runtimeSafety?.blockingReasons ? toReasonArray(runtimeSafety.blockingReasons) : [];

  // ---- current tick admission path (source of truth for "right now") ----
  const paperState = await prisma.paperTradingState.findUnique({ where: { id: "default" } });
  let lastTick: any = null;
  if (paperState?.lastOpenTickResultJson) {
    try {
      lastTick = JSON.parse(paperState.lastOpenTickResultJson);
    } catch {
      lastTick = null;
    }
  }

  const lastTickSummary = lastTick
    ? {
        lastOpenTickAt: paperState?.lastOpenTickAt?.toISOString?.() ?? null,
        enabled: lastTick.enabled ?? null,
        threshold: lastTick.threshold ?? null,
        candidatesLoaded: lastTick.candidatesLoaded ?? null,
        candidatesScored: lastTick.candidatesScored ?? null,
        aboveThresholdCount: lastTick.aboveThresholdCount ?? null,
        opened: lastTick.opened ?? null,
        skipped: lastTick.skipped ?? null,
        rejectedByCooldownCount: lastTick.rejectedByCooldownCount ?? null,
        rejectedByRiskLimitCount: lastTick.rejectedByRiskLimitCount ?? null,
        lastScoringTime: lastTick.lastScoringTime ?? null,
        modelRunId: lastTick.modelRunId ?? null,
        decisionTraceBundlePresent: Boolean(lastTick.decisionTraceBundle),
        decisionTraceBundleGeneratedAt: lastTick.decisionTraceBundle?.generatedAt ?? null,
        decisionTraceTotalCandidatesConsidered: lastTick.decisionTraceBundle?.totalCandidatesConsidered ?? null,
        decisionTraceMaxTracesStored: lastTick.decisionTraceBundle?.maxTracesStored ?? null,
        perBotResultsPresent: Boolean(lastTick.perBotResults),
      }
    : null;

  const perBotResults = (lastTick?.perBotResults ?? null) as
    | null
    | Record<
        string,
        {
          opened: number;
          skipped: number;
          candidatesLoaded: number;
          candidatesScored: number;
          aboveThresholdCount: number;
          rejectedByCooldownCount: number;
          rejectedByRiskLimitCount: number;
          loadDiagnostics?: any;
        }
      >;

  const perBotLoadDiagnostics = perBotResults
    ? Object.entries(perBotResults).map(([botType, v]) => {
        const ld = v.loadDiagnostics ?? null;
        return {
          botType,
          opened: v.opened ?? null,
          skipped: v.skipped ?? null,
          candidatesLoaded: v.candidatesLoaded ?? null,
          candidatesScored: v.candidatesScored ?? null,
          aboveThresholdCount: v.aboveThresholdCount ?? null,
          rejectedByCooldownCount: v.rejectedByCooldownCount ?? null,
          rejectedByRiskLimitCount: v.rejectedByRiskLimitCount ?? null,
          loadDiagnostics: ld
            ? {
                recommendationsFound: ld.recommendationsFound ?? null,
                noDecisionSnapshot: ld.noDecisionSnapshot ?? null,
                afterPolicyFilter: ld.afterPolicyFilter ?? null,
                filteredByPolicyStateCount: ld.filteredByPolicyStateCount ?? null,
                policyStateCounts: ld.policyStateCounts ?? null,
                zeroCandidatesReason: ld.zeroCandidatesReason ?? null,
                allowedCount: ld.allowedCount ?? null,
                zeroSizeAfterPolicyCount: ld.zeroSizeAfterPolicyCount ?? null,
                relaxedBlockedCount: ld.relaxedBlockedCount ?? null,
                candidatesPassedViaRelaxation: ld.candidatesPassedViaRelaxation ?? null,
              }
            : null,
        };
      })
    : null;

  // trace-based reject reasons (bounded to last tick)
  const traceEntries: any[] = lastTick?.decisionTraceBundle?.traces ?? [];
  const rejectReasonCounts: CountMap = new Map();
  for (const t of traceEntries) {
    const code = ensureReasonCodeString(t?.rejectReasonCode);
    if (!code) continue;
    rejectReasonCounts.set(code, (rejectReasonCounts.get(code) ?? 0) + 1);
  }
  const topRejectCodes = topNFromMap(rejectReasonCounts, 10);

  const perBotAggregates: any[] = lastTick?.decisionTraceBundle?.perBotAggregates ?? [];
  const perBotBottleneck = perBotAggregates.map((a) => {
    const botType = a.botType ?? "unknown";
    const dist = [
      { k: "rejectedByThreshold", v: a.rejectedByThreshold ?? 0 },
      { k: "rejectedByCooldown", v: a.rejectedByCooldown ?? 0 },
      { k: "rejectedByBudget", v: a.rejectedByBudget ?? 0 },
      { k: "rejectedByDedupe", v: a.rejectedByDedupe ?? 0 },
      { k: "rejectedByCaps", v: a.rejectedByCaps ?? 0 },
    ].sort((x, y) => y.v - x.v);
    return { botType, totals: a, topByBucket: dist.slice(0, 2) };
  });

  // ---- recent-window context for paper admissions ----
  const [paperCreated24, paperCreated7d, paperOpenTotal24, paperOpenByBot, shadowStats24, shadowStats7d] =
    await Promise.all([
      prisma.paperTrade.count({ where: { createdAt: { gte: since24 } } }),
      prisma.paperTrade.count({ where: { createdAt: { gte: since7d } } }),
      prisma.paperTrade.count({ where: { status: "open" } }),
      prisma.paperTrade.groupBy({
        by: ["botType"],
        where: { status: "open" },
        _count: { id: true },
      }),
      Promise.all([
        prisma.shadowCandidate.count({ where: { createdAt: { gte: since24 } } }),
        prisma.shadowCandidate.count({ where: { createdAt: { gte: since24 }, wasBlocked: true } }),
        prisma.shadowCandidate.count({ where: { createdAt: { gte: since24 }, wasBlocked: false } }),
        prisma.shadowCandidate.count({ where: { createdAt: { gte: since24 }, wasSubmitted: true } }),
      ]),
      Promise.all([
        prisma.shadowCandidate.count({ where: { createdAt: { gte: since7d } } }),
        prisma.shadowCandidate.count({ where: { createdAt: { gte: since7d }, wasBlocked: true } }),
        prisma.shadowCandidate.count({ where: { createdAt: { gte: since7d }, wasBlocked: false } }),
        prisma.shadowCandidate.count({ where: { createdAt: { gte: since7d }, wasSubmitted: true } }),
      ]),
    ]);

  const [shadowTotal24, shadowBlocked24, shadowAdmitted24, shadowSubmitted24] = shadowStats24 as [
    number,
    number,
    number,
    number
  ];
  const [shadowTotal7d, shadowBlocked7d, shadowAdmitted7d, shadowSubmitted7d] = shadowStats7d as [
    number,
    number,
    number,
    number
  ];

  // historical top blocking reasons in ShadowCandidate (runtime gate history)
  const shadowAgg = await aggregateShadowBlockingReasonsSince(since24, true);
  const topShadowReasons24 = topNFromMap(shadowAgg.counts, 10);
  const workingOrdersBreachCount24 = shadowAgg.counts.get("working_orders_breach") ?? 0;

  const paperOpenByBotObj = paperOpenByBot.reduce((acc: Record<string, number>, row) => {
    acc[String(row.botType)] = row._count.id;
    return acc;
  }, {});

  const heuristicCurrentBottlenecks = (() => {
    if (!lastTick || !perBotAggregates.length) return null;

    // Aggregate current tick bottleneck buckets across bots.
    const sums = perBotAggregates.reduce(
      (acc, a) => {
        acc.threshold += a.rejectedByThreshold ?? 0;
        acc.cooldown += a.rejectedByCooldown ?? 0;
        acc.budget += a.rejectedByBudget ?? 0;
        acc.dedupe += a.rejectedByDedupe ?? 0;
        acc.caps += a.rejectedByCaps ?? 0;
        return acc;
      },
      { threshold: 0, cooldown: 0, budget: 0, dedupe: 0, caps: 0 }
    );

    const ranked = [
      { cat: "capacity_working_order_caps", v: sums.caps + sums.budget },
      { cat: "threshold_too_high", v: sums.threshold },
      { cat: "cooldown_or_dedupe", v: sums.cooldown + sums.dedupe },
    ].sort((a, b) => b.v - a.v);

    const rank1 = ranked[0];
    const rank2 = ranked[1];

    // Rejection code mapping (more precise).
    const codeCounts = rejectReasonCounts;
    const capacityCodes = ["max_open_total", "max_open_per_market", "max_open_per_theme", "max_open_per_category", "budget_cap"];
    const cooldownCodes = ["cooldown_asset", "cooldown_market"];
    const dedupeCodes = ["dedupe"];

    const capacityCodeSum = capacityCodes.reduce((s, c) => s + (codeCounts.get(c) ?? 0), 0);
    const cooldownCodeSum = cooldownCodes.reduce((s, c) => s + (codeCounts.get(c) ?? 0), 0);
    const dedupeCodeSum = dedupeCodes.reduce((s, c) => s + (codeCounts.get(c) ?? 0), 0);

    const rank1IsCapacity = capacityCodeSum > cooldownCodeSum && capacityCodeSum > dedupeCodeSum;

    return {
      rankedByBucket: ranked,
      traceTopRejectCodes: topRejectCodes,
      traceCapacityCodeSum: capacityCodeSum,
      traceCooldownCodeSum: cooldownCodeSum,
      traceDedupeCodeSum: dedupeCodeSum,
      interpretation:
        rank1IsCapacity || rank1.cat === "capacity_working_order_caps"
          ? "Admission pressure is dominated by paper-mode capacity caps / daily budget caps, not runtime truth health."
          : rank1.cat === "threshold_too_high"
            ? "Admission pressure is dominated by scoring threshold / exploration-band rejection in the current tick."
            : "Admission pressure is dominated by cooldown / dedupe in the current tick.",
      expectedVsPathological:
        rank1.cat === "capacity_working_order_caps"
          ? "Expected: paper profiles have explicit max-open and daily caps."
          : rank1.cat === "threshold_too_high"
            ? "Expected unless you observe missing_shadow_score dominating (then candidates/ML input is broken)."
            : "Expected: cooldown/dedupe prevent redundant openings.",
    };
  })();

  const report = {
    generatedAt: new Date().toISOString(),
    runtimeContext: {
      worker: WORKER_NAME,
      runtimeSafetyState: runtimeState,
      runtimeSafetyBlockingReasons: runtimeBlockingReasons,
      note: "Runtime health here is informational; admission bottleneck classification comes primarily from PaperTradingState.lastOpenTickResultJson (current tick).",
    },
    lookback: {
      hours24: 24,
      days7: 7,
      shadowBlockingAggregationSeconds: null as null,
    },
    currentTickAdmission: {
      source: "PaperTradingState.lastOpenTickResultJson (bounded decisionTraceBundle from the latest paper tick)",
      lastTickSummary,
      rejectReasonCountsFromTracesLimitedToLastTick: {
        totalTracesCounted: traceEntries.length,
        traceLimit: RECENT_TRACE_LIMIT,
        topRejectReasonCodes: topRejectCodes,
      },
      perBotBottleneckBuckets: perBotBottleneck,
      perBotLoadDiagnostics,
      heuristicCurrentBottlenecks,
    },
    paperAdmissionsRecentWindow: {
      createdLast24h: paperCreated24,
      createdLast7d: paperCreated7d,
      openTradesTotal: paperOpenTotal24,
      openTradesByBotType: paperOpenByBotObj,
    },
    shadowAdmissionHistoricalWindow: {
      note:
        "ShadowCandidate aggregates are historical runtime guardrail outcomes (not the paper tick’s current admission decisions). Many 'blocked' rows are expected even when runtime health is currently normal.",
      shadowCreatedLast24h: shadowTotal24,
      shadowBlockedLast24h: shadowBlocked24,
      shadowAdmittedLast24h: shadowAdmitted24,
      shadowSubmittedLast24h: shadowSubmitted24,
      topShadowBlockingReasonsLast24h: topShadowReasons24,
      working_orders_breach_count_last24h: workingOrdersBreachCount24,
      shadowCreatedLast7d: shadowTotal7d,
      shadowBlockedLast7d: shadowBlocked7d,
      shadowAdmittedLast7d: shadowAdmitted7d,
      shadowSubmittedLast7d: shadowSubmitted7d,
    },
    conclusions: {
      topAdmissionBottlenecksRanking: heuristicCurrentBottlenecks?.rankedByBucket ?? null,
      runtimeHealthyNow: runtimeState === "normal",
      whySoManyBlockedInShadow: "ShadowCandidate 'blocked' counts include runtime guardrails/capacity/truth lags over a 24h window. Paper-mode admissions are controlled by the paper engine’s current tick logic and bot caps/cooldowns, not by those historical runtime blocks.",
    },
  };

  const jsonPath = path.join(DUMP, "paper-admission-pressure-report.json");
  const mdPath = path.join(DUMP, "paper-admission-pressure-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Paper admission pressure report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Runtime health context (informational)",
    "",
    `- runtimeSafety.state: ${report.runtimeContext.runtimeSafetyState ?? "—"}`,
    `- runtimeSafety.blockingReasons: ${JSON.stringify(report.runtimeContext.runtimeSafetyBlockingReasons ?? [])}`,
    "",
    "## Current tick admission (source of truth)",
    "",
    `- candidatesLoaded: ${report.currentTickAdmission.lastTickSummary?.candidatesLoaded ?? "—"}`,
    `- candidatesScored: ${report.currentTickAdmission.lastTickSummary?.candidatesScored ?? "—"}`,
    `- aboveThresholdCount: ${report.currentTickAdmission.lastTickSummary?.aboveThresholdCount ?? "—"}`,
    `- opened: ${report.currentTickAdmission.lastTickSummary?.opened ?? "—"}`,
    `- skipped: ${report.currentTickAdmission.lastTickSummary?.skipped ?? "—"}`,
    `- rejectedByCooldownCount: ${report.currentTickAdmission.lastTickSummary?.rejectedByCooldownCount ?? "—"}`,
    `- rejectedByRiskLimitCount: ${report.currentTickAdmission.lastTickSummary?.rejectedByRiskLimitCount ?? "—"}`,
    "",
    "### Top rejection reasons (from last tick traces only)",
    "",
    ...(() => {
      const top = report.currentTickAdmission.rejectReasonCountsFromTracesLimitedToLastTick.topRejectReasonCodes;
      if (!top || top.length === 0) return ["- (none / no traces)"];
      return top.map((r) => `- ${r.reason}: ${r.count}`);
    })(),
    "",
    "## Recent-window context (historical shadow runtime blocks)",
    "",
    `- ShadowCandidate last24h created=${shadowTotal24} blocked=${shadowBlocked24} admitted=${shadowAdmitted24} submitted=${shadowSubmitted24}`,
    `- ShadowCandidate working_orders_breach occurrences (last24h): ${workingOrdersBreachCount24}`,
    "",
    "## Summary conclusions",
    "",
    `- runtimeHealthyNow: ${String(report.conclusions.runtimeHealthyNow)}`,
    `- topAdmissionBottlenecksRanking: ${JSON.stringify(report.conclusions.topAdmissionBottlenecksRanking)}`,
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

