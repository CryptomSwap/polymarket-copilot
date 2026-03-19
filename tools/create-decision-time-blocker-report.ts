/**
 * Decision-time blocker attribution report for runtime_automated candidates.
 *
 * Uses persisted candidate decisionSnapshotJson (decision-time context), not current runtime state.
 *
 * Writes:
 * - dump/decision-time-blocker-report.json
 * - dump/decision-time-blocker-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const RECENT_LIMIT = Number(process.env.DECISION_TIME_BLOCKER_RECENT_LIMIT ?? "1200") || 1200;
const LAST_OUTCOMES = 20;
const WINDOWS = [
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "10m", ms: 10 * 60 * 1000 },
  { label: "30m", ms: 30 * 60 * 1000 },
] as const;

type RootCause =
  | "LEGITIMATE_RUNTIME_SAFETY_BLOCK"
  | "LEGITIMATE_CONCENTRATION_BLOCK"
  | "LEGITIMATE_WORKING_ORDER_BLOCK"
  | "LEGITIMATE_TRUTH_BLOCK"
  | "STALE_OR_FALSE_BLOCK_REASON"
  | "DECISION_CONTEXT_MISMATCH"
  | "OTHER_BUG";

function since(ms: number): Date {
  return new Date(Date.now() - ms);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toReasons(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .flatMap((x) => (typeof x === "string" ? x.split(/[;,|+]/g) : []))
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") return raw.split(/[;,|+]/g).map((x) => x.trim()).filter(Boolean);
  return [];
}

function reasonCategory(reason: string): "runtime_safety" | "concentration" | "working_orders" | "truth" | "other" {
  if (reason.includes("runtime_safety") || reason.includes("kill_switch") || reason.includes("operational:")) return "runtime_safety";
  if (reason.includes("single_market_concentration_breach") || reason.includes("single_theme_concentration_breach")) return "concentration";
  if (reason.includes("working_orders_breach")) return "working_orders";
  if (
    reason.includes("exchange_truth") ||
    reason.includes("user_data_stale") ||
    reason.includes("market_data_stale") ||
    reason.includes("reconciliation_stale")
  ) return "truth";
  return "other";
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const oldest = since(WINDOWS[2].ms);

  const rows = await prisma.shadowCandidate.findMany({
    where: {
      candidateSource: "runtime_automated",
      createdAt: { gte: oldest },
    },
    orderBy: { createdAt: "desc" },
    take: RECENT_LIMIT,
    select: {
      id: true,
      createdAt: true,
      marketId: true,
      assetId: true,
      wasBlocked: true,
      wasSubmitted: true,
      blockingReasons: true,
      decisionSnapshotJson: true,
      portfolioRiskSnapshotJson: true,
      executionPolicySnapshotJson: true,
    },
  });

  const [paperOpen5m, paperOpen10m, paperOpen30m] = await Promise.all([
    prisma.paperTrade.count({ where: { createdAt: { gte: since(WINDOWS[0].ms) } } }),
    prisma.paperTrade.count({ where: { createdAt: { gte: since(WINDOWS[1].ms) } } }),
    prisma.paperTrade.count({ where: { createdAt: { gte: since(WINDOWS[2].ms) } } }),
  ]);

  const funnel = WINDOWS.map((w) => {
    const cutoff = since(w.ms).getTime();
    const inWin = rows.filter((r) => r.createdAt.getTime() >= cutoff);
    return {
      window: w.label,
      runtimeAutomatedCreated: inWin.length,
      blocked: inWin.filter((r) => r.wasBlocked).length,
      submitted: inWin.filter((r) => r.wasSubmitted).length,
      paperTradesOpened:
        w.label === "5m" ? paperOpen5m : w.label === "10m" ? paperOpen10m : paperOpen30m,
    };
  });

  const parsed = rows.map((r) => {
    let decision: Record<string, unknown> | null = null;
    try {
      decision = r.decisionSnapshotJson ? (JSON.parse(r.decisionSnapshotJson) as Record<string, unknown>) : null;
    } catch {
      decision = null;
    }
    const runtime = asRecord(decision?.runtime);
    const userFresh = asRecord(decision?.userFreshnessInputs);
    const exchangeFresh = asRecord(decision?.exchangeFreshnessInputs);
    const workingOrders = asRecord(decision?.workingOrderInputs);
    const concentration = asRecord(decision?.concentrationInputs);
    const terminal = asRecord(decision?.terminalAttribution);
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      decidedAt: typeof decision?.decidedAt === "string" ? (decision.decidedAt as string) : r.createdAt.toISOString(),
      marketIdentifier: r.marketId ?? r.assetId,
      wasBlocked: r.wasBlocked,
      wasSubmitted: r.wasSubmitted,
      conciseBlockingReasons: toReasons(r.blockingReasons),
      decisionRuntimeStatus: typeof runtime?.runtimeStatus === "string" ? (runtime.runtimeStatus as string) : null,
      decisionLifecycleStatus: typeof runtime?.lifecycleStatus === "string" ? (runtime.lifecycleStatus as string) : null,
      decisionOperatingMode: typeof runtime?.operatingMode === "string" ? (runtime.operatingMode as string) : null,
      decisionAutomationPermitted:
        typeof runtime?.automationPermitted === "boolean" ? (runtime.automationPermitted as boolean) : null,
      decisionSafeToAutomate:
        typeof runtime?.safeToAutomate === "boolean" ? (runtime.safeToAutomate as boolean) : null,
      decisionRuntimeSafetyState:
        typeof runtime?.runtimeSafetyState === "string" ? (runtime.runtimeSafetyState as string) : null,
      decisionTruthHealth: {
        userEffectiveFresh: userFresh?.effectiveUserFreshnessResult ?? null,
        exchangeEffectiveHealth: exchangeFresh?.effectiveExchangeTruthHealthResult ?? null,
        exchangeTruthUnavailable: exchangeFresh?.exchangeTruthUnavailable ?? null,
      },
      decisionWorkingOrders: {
        count: workingOrders?.workingOrderCount ?? null,
        limit: workingOrders?.maxConcurrentWorkingOrders ?? null,
      },
      decisionConcentration: {
        currentSingleMarketPct: concentration?.maxSingleMarketConcentrationPct ?? null,
        currentSingleThemePct: concentration?.maxSingleThemeConcentrationPct ?? null,
        limitSingleMarketPct: concentration?.effectiveSingleMarketLimit ?? null,
        limitSingleThemePct: concentration?.effectiveSingleThemeLimit ?? null,
      },
      terminalAttribution: terminal ?? null,
      decisionSnapshotPresent: decision != null,
    };
  });

  const last20 = parsed.slice(0, LAST_OUTCOMES);
  const blocked = parsed.filter((p) => p.wasBlocked);

  const reasonCounts = new Map<string, number>();
  const comboCounts = new Map<string, number>();
  for (const b of blocked) {
    const rs = b.conciseBlockingReasons;
    for (const r of rs) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
    const combo = rs.slice().sort().join(" + ") || "(none)";
    comboCounts.set(combo, (comboCounts.get(combo) ?? 0) + 1);
  }
  const totalBlocked = blocked.length;
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({
      reason,
      count,
      pct: totalBlocked > 0 ? Math.round((count / totalBlocked) * 10000) / 100 : 0,
      category: reasonCategory(reason),
    }));
  const topCombos = [...comboCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([combo, count]) => ({
      combo,
      count,
      pct: totalBlocked > 0 ? Math.round((count / totalBlocked) * 10000) / 100 : 0,
    }));

  const dominant = topReasons[0] ?? null;
  const supportSummary = (() => {
    if (!dominant) return { supported: false, note: "No blocked candidates in window." };
    const subset = blocked.filter((b) => b.conciseBlockingReasons.includes(dominant.reason));
    if (dominant.category === "truth") {
      const supported = subset.some(
        (b) =>
          b.decisionTruthHealth.exchangeEffectiveHealth === false ||
          b.decisionTruthHealth.userEffectiveFresh === false ||
          b.decisionTruthHealth.exchangeTruthUnavailable === true
      );
      return {
        supported,
        note: supported
          ? "Decision-time truth inputs show stale/unavailable conditions for dominant truth blocker."
          : "Decision-time truth inputs do not support stale/unavailable conditions for dominant truth blocker.",
      };
    }
    if (dominant.category === "working_orders") {
      const supported = subset.some((b) => {
        const c = Number(b.decisionWorkingOrders.count ?? NaN);
        const l = Number(b.decisionWorkingOrders.limit ?? NaN);
        return Number.isFinite(c) && Number.isFinite(l) && c >= l;
      });
      return {
        supported,
        note: supported
          ? "Decision-time working-order count/limit supports blocker (count >= limit)."
          : "Decision-time working-order count/limit does not support blocker (count < limit or missing).",
      };
    }
    if (dominant.category === "concentration") {
      const supported = subset.some((b) => {
        const sm = Number(b.decisionConcentration.currentSingleMarketPct ?? NaN);
        const sl = Number(b.decisionConcentration.limitSingleMarketPct ?? NaN);
        const tm = Number(b.decisionConcentration.currentSingleThemePct ?? NaN);
        const tl = Number(b.decisionConcentration.limitSingleThemePct ?? NaN);
        return (Number.isFinite(sm) && Number.isFinite(sl) && sm >= sl) || (Number.isFinite(tm) && Number.isFinite(tl) && tm >= tl);
      });
      return {
        supported,
        note: supported
          ? "Decision-time concentration values/limits support blocker (current >= limit)."
          : "Decision-time concentration values/limits do not support blocker (below limit or missing).",
      };
    }
    if (dominant.category === "runtime_safety") {
      const supported = subset.some(
        (b) => b.decisionRuntimeSafetyState === "blocked" || b.decisionRuntimeSafetyState === "kill_switch"
      );
      return {
        supported,
        note: supported
          ? "Decision-time runtimeSafetyState supports runtime safety block."
          : "Decision-time runtimeSafetyState does not support runtime safety block.",
      };
    }
    return { supported: false, note: "Dominant blocker has no direct numeric support rule in this bounded report." };
  })();

  const missingDecisionContextCount = parsed.filter((p) => !p.decisionSnapshotPresent).length;
  const missingDecisionContextShare = parsed.length > 0 ? missingDecisionContextCount / parsed.length : 0;
  let rootCause: RootCause = "OTHER_BUG";
  if (missingDecisionContextShare >= 0.5) {
    rootCause = "DECISION_CONTEXT_MISMATCH";
  } else if (dominant) {
    switch (dominant.category) {
      case "runtime_safety":
        rootCause = supportSummary.supported ? "LEGITIMATE_RUNTIME_SAFETY_BLOCK" : "STALE_OR_FALSE_BLOCK_REASON";
        break;
      case "concentration":
        rootCause = supportSummary.supported ? "LEGITIMATE_CONCENTRATION_BLOCK" : "STALE_OR_FALSE_BLOCK_REASON";
        break;
      case "working_orders":
        rootCause = supportSummary.supported ? "LEGITIMATE_WORKING_ORDER_BLOCK" : "STALE_OR_FALSE_BLOCK_REASON";
        break;
      case "truth":
        rootCause = supportSummary.supported ? "LEGITIMATE_TRUTH_BLOCK" : "STALE_OR_FALSE_BLOCK_REASON";
        break;
      default:
        rootCause = "OTHER_BUG";
        break;
    }
  } else if (missingDecisionContextCount > 0) {
    rootCause = "DECISION_CONTEXT_MISMATCH";
  }

  const nextTarget = (() => {
    switch (rootCause) {
      case "LEGITIMATE_RUNTIME_SAFETY_BLOCK":
        return "runtime safety input continuity at decision time";
      case "LEGITIMATE_CONCENTRATION_BLOCK":
        return "execution-policy concentration calibration";
      case "LEGITIMATE_WORKING_ORDER_BLOCK":
        return "working-order lifecycle/cleanup subsystem";
      case "LEGITIMATE_TRUTH_BLOCK":
        return "truth acquisition and reconciliation cadence";
      case "STALE_OR_FALSE_BLOCK_REASON":
      case "DECISION_CONTEXT_MISMATCH":
        return "decision telemetry integrity in runtime_automated candidate path";
      default:
        return "narrow 2-3 minute decision-time re-sample";
    }
  })();

  const report = {
    generatedAt,
    shortWindowAdmissionFunnel: funnel,
    last20RuntimeAutomatedOutcomes: last20,
    dominantBlockerAttributionFromDecisionTime: {
      totalBlocked,
      missingDecisionContextCount,
      missingDecisionContextSharePct: Math.round(missingDecisionContextShare * 10000) / 100,
      blockerReasonCounts: topReasons.slice(0, 12),
      topBlockerCombinations: topCombos,
      topBlocker: dominant,
      topBlockerDecisionTimeSupport: supportSummary,
    },
    rootCauseClassification: {
      rootCause,
      why: dominant
        ? `Dominant blocker '${dominant.reason}' (${dominant.pct}%) classified via decision-time context support=${supportSummary.supported}.`
        : "No dominant blocker in bounded decision-time sample.",
    },
    recommendedNextTarget: nextTarget,
    filesChanged: [
      "worker/stream-runtime.ts",
      "tools/create-decision-time-blocker-report.ts",
      "package.json",
    ],
    redaction: {
      secretsRedacted: true,
      note: "Decision-time telemetry only; no secret material persisted in report.",
    },
  };

  const md: string[] = [];
  md.push("# Decision-Time Blocker Report");
  md.push(`Generated at: ${generatedAt}`);
  md.push("");
  md.push("## 1) Short-window admission funnel");
  md.push("| window | runtime_automated created | blocked | submitted | paper trades opened |");
  md.push("|---|---:|---:|---:|---:|");
  for (const f of funnel) md.push(`| ${f.window} | ${f.runtimeAutomatedCreated} | ${f.blocked} | ${f.submitted} | ${f.paperTradesOpened} |`);
  md.push("");
  md.push("## 2) Last 20 runtime_automated outcomes");
  md.push("| decidedAt | market | blocked | submitted | reasons | runtimeStatus | operatingMode | automationPermitted | safeToAutomate | truthHealth | workingOrders | concentration |");
  md.push("|---|---|---:|---:|---|---|---|---|---|---|---|---|");
  for (const o of last20) {
    const truth = `user=${String(o.decisionTruthHealth.userEffectiveFresh)} exchange=${String(o.decisionTruthHealth.exchangeEffectiveHealth)} unavailable=${String(o.decisionTruthHealth.exchangeTruthUnavailable)}`;
    const wo = `${String(o.decisionWorkingOrders.count)}/${String(o.decisionWorkingOrders.limit)}`;
    const conc = `m=${String(o.decisionConcentration.currentSingleMarketPct)}/${String(o.decisionConcentration.limitSingleMarketPct)} t=${String(o.decisionConcentration.currentSingleThemePct)}/${String(o.decisionConcentration.limitSingleThemePct)}`;
    md.push(`| ${o.decidedAt} | ${o.marketIdentifier} | ${o.wasBlocked ? 1 : 0} | ${o.wasSubmitted ? 1 : 0} | ${o.conciseBlockingReasons.join(", ") || "(none)"} | ${o.decisionRuntimeStatus ?? "—"} | ${o.decisionOperatingMode ?? "—"} | ${String(o.decisionAutomationPermitted)} | ${String(o.decisionSafeToAutomate)} | ${truth} | ${wo} | ${conc} |`);
  }
  md.push("");
  md.push("## 3) Dominant blocker attribution from decision-time data");
  md.push(`- total blocked in bounded sample: **${totalBlocked}**`);
  md.push(`- top blocker: **${dominant?.reason ?? "(none)"}**`);
  md.push(`- top blocker support: **${supportSummary.supported}**`);
  md.push(`- support note: ${supportSummary.note}`);
  md.push("");
  md.push("## 4) Root cause classification");
  md.push(`- **${rootCause}**`);
  md.push(`- ${report.rootCauseClassification.why}`);
  md.push("");
  md.push("## 5) Recommended next target");
  md.push(`- ${nextTarget}`);

  await fs.writeFile(path.join(DUMP_DIR, "decision-time-blocker-report.json"), JSON.stringify(report, null, 2), "utf-8");
  await fs.writeFile(path.join(DUMP_DIR, "decision-time-blocker-report.md"), md.join("\n"), "utf-8");

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        rootCause,
        dominantBlocker: dominant?.reason ?? null,
        dominantSharePct: dominant?.pct ?? null,
      },
      null,
      2
    )
  );
}

void main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("create-decision-time-blocker-report failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

