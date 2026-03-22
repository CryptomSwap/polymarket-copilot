/**
 * Read-only paper ROI tuning report (threshold override, score sizing, liquidity guards).
 * Writes dump/paper-roi-optimization-report.{json,md} via tools/create-paper-roi-optimization-report.ts
 */

import { prisma } from "@/lib/db";
import { getPaperTradingConfig } from "@/lib/paper-trading/config";
import {
  effectivePaperMinScoreFromConfig,
  resolvePaperSizeBucket,
} from "@/lib/paper-trading/paper-roi-admission";
import {
  parseOpenAttributionFromMetadataJson,
} from "@/lib/paper-trading/paper-trade-open-attribution";

export const PAPER_ROI_IMPLEMENTATION_NOTE = [
  "**Threshold sources (paper admission):** Profile (or legacy) base min score = `threshold + minScoreBuffer` from `PAPER_TRADING_THRESHOLD` / `PAPER_TRADING_MIN_SCORE_BUFFER` and per-bot `bot-profiles.ts` (or legacy global config). Effective admission bar = `max(base, PAPER_TRADING_MIN_SCORE_OVERRIDE?, PAPER_BOT_MIN_SCORE_OVERRIDE_<BOTTYPE>?)` computed in `runPaperTradingTick` via `computeEffectivePaperMinScore` in `paper-roi-admission.ts` (never lowers the base).",
  "**Size sources:** `PaperTradingCandidate.intendedSize` from shadow rows; optional paper-only multiplier from `resolvePaperSizeBucket` when `PAPER_TRADING_SIZE_BY_SCORE_ENABLED=1`. Caps/cooldowns/dedupe unchanged.",
  "**Safe insertion points:** All new logic is in `lib/paper-trading/engine.ts` immediately after score-based admission (threshold/exploration) and before global risk caps — spread/slippage guards; sizing applied at `paperTrade.create` / `recordShadowCandidate`. Live order paths do not import `paper-roi-admission.ts`.",
].join(" ");

export interface PaperRoiOptimizationReport {
  generatedAt: string;
  lookbackDays: number;
  implementationNote: string;
  paperConfig: {
    threshold: number;
    minScoreBuffer: number;
    effectiveMinScoreDefault: number;
    paperMinScoreOverrideGlobal: number | null;
    paperSizeByScoreEnabled: boolean;
    paperSizeScoreTiers: { maxExclusive: number; label: string; multiplier: number }[];
    paperMaxSpreadBps: number;
    paperMaxEstimatedSlippageBps: number | null;
  };
  lastOpenTick: {
    lastScoringTime: string | null;
    opened: number | null;
    skipped: number | null;
    candidatesScored: number | null;
    aboveThresholdCount: number | null;
    rejectedBySpreadGuardCount: number | null;
    rejectedBySlippageGuardCount: number | null;
  } | null;
  windowTrades: {
    total: number;
    open: number;
    closed: number;
    withPaperRoiAdmission: number;
  };
  scoreQuantilesRecentCandidates: {
    note: string;
    count: number;
    scores: number[];
    p50: number | null;
    p90: number | null;
  };
  simulatedBucketCountsOnScores: Record<string, number>;
  opensByConfiguredSizeBucket: Record<string, number>;
  closedPnlByScoreBucket: {
    bucket: string;
    closedCount: number;
    meanPnlPct: number | null;
    hitRatePnl: number | null;
  }[];
  spreadSlippage: {
    spreadBps: { count: number; mean: number | null; p50: number | null; p90: number | null };
    slippageBps: { count: number; mean: number | null; p50: number | null; p90: number | null };
  };
  recommendation: {
    summary: string;
    caveat: string;
  };
}

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function medianSorted(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
}

function quantileSorted(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export async function runPaperRoiOptimizationReport(options: {
  lookbackDays?: number;
}): Promise<PaperRoiOptimizationReport> {
  const lookbackDays = options.lookbackDays ?? 14;
  const from = new Date();
  from.setDate(from.getDate() - lookbackDays);

  const cfg = getPaperTradingConfig();
  const effectiveMinScoreDefault = effectivePaperMinScoreFromConfig(cfg);

  let lastOpenTick: PaperRoiOptimizationReport["lastOpenTick"] = null;
  try {
    const st = await prisma.paperTradingState.findUnique({ where: { id: "default" } });
    if (st?.lastOpenTickResultJson) {
      const j = JSON.parse(st.lastOpenTickResultJson) as Record<string, unknown>;
      lastOpenTick = {
        lastScoringTime: typeof j.lastScoringTime === "string" ? j.lastScoringTime : null,
        opened: typeof j.opened === "number" ? j.opened : null,
        skipped: typeof j.skipped === "number" ? j.skipped : null,
        candidatesScored: typeof j.candidatesScored === "number" ? j.candidatesScored : null,
        aboveThresholdCount: typeof j.aboveThresholdCount === "number" ? j.aboveThresholdCount : null,
        rejectedBySpreadGuardCount:
          typeof j.rejectedBySpreadGuardCount === "number" ? j.rejectedBySpreadGuardCount : null,
        rejectedBySlippageGuardCount:
          typeof j.rejectedBySlippageGuardCount === "number" ? j.rejectedBySlippageGuardCount : null,
      };
    }
  } catch {
    /* ignore */
  }

  const trades = await prisma.paperTrade.findMany({
    where: { entryTime: { gte: from } },
    select: {
      id: true,
      status: true,
      score: true,
      metadataJson: true,
      pnlPct: true,
    },
  });

  const open = trades.filter((t) => t.status === "open").length;
  const closed = trades.filter((t) => t.status === "closed");
  let withRoi = 0;
  const opensByBucket: Record<string, number> = {};
  const spreads: number[] = [];
  const slips: number[] = [];
  const closedByBucket: Record<string, number[]> = {};

  for (const t of trades) {
    const a = parseOpenAttributionFromMetadataJson(t.metadataJson);
    if (a?.paperRoiAdmission) withRoi++;
    const roi = a?.paperRoiAdmission;
    const label = roi?.sizeScoreBucketLabel ?? "unknown_pre_roi";
    if (t.status === "open" || t.status === "closed") {
      opensByBucket[label] = (opensByBucket[label] ?? 0) + 1;
    }
    const sp = roi?.spreadBpsAtAdmission ?? a?.executionContext.spreadBps;
    const sl = roi?.estimatedSlippageBpsAtAdmission ?? a?.executionContext.estimatedSlippageBps;
    if (sp != null && Number.isFinite(sp)) spreads.push(sp);
    if (sl != null && Number.isFinite(sl)) slips.push(sl);

    if (t.status === "closed") {
      const b = roi?.sizeScoreBucketLabel ?? "unknown_pre_roi";
      const pnl = parseNum(t.pnlPct);
      if (pnl != null) {
        if (!closedByBucket[b]) closedByBucket[b] = [];
        closedByBucket[b]!.push(pnl);
      }
    }
  }

  // Scores from PaperTrade rows in window (proxy for scored cohort)
  const recentScores = trades.map((t) => t.score).filter((s) => Number.isFinite(s));
  const sortedScores = [...recentScores].sort((a, b) => a - b);

  const simulatedBuckets: Record<string, number> = {};
  for (const s of recentScores) {
    const b = resolvePaperSizeBucket(s, effectiveMinScoreDefault, cfg.paperSizeScoreTiers);
    const key = b?.label ?? "below_effective_min";
    simulatedBuckets[key] = (simulatedBuckets[key] ?? 0) + 1;
  }

  const closedPnlByScoreBucket = Object.keys({ ...closedByBucket, ...opensByBucket }).map((bucket) => {
    const pnls = closedByBucket[bucket] ?? [];
    return {
      bucket,
      closedCount: pnls.length,
      meanPnlPct: mean(pnls),
      hitRatePnl: pnls.length ? pnls.filter((x) => x > 0).length / pnls.length : null,
    };
  });

  const spreadSorted = [...spreads].sort((a, b) => a - b);
  const slipSorted = [...slips].sort((a, b) => a - b);

  const caveat =
    trades.length < 20
      ? "Sample sizes are small; treat bucket PnL and quantiles as directional only."
      : closed.length < 15
        ? "Few closed trades in window; PnL-by-bucket is noisy."
        : "Use with usual survivorship caveats (only admitted trades appear in PnL).";

  const recParts: string[] = [];
  if (cfg.paperMinScoreOverrideGlobal == null) {
    recParts.push(
      "Set `PAPER_TRADING_MIN_SCORE_OVERRIDE=0.8` for a first paper-only tightening trial if the score distribution supports it."
    );
  } else {
    recParts.push(
      `Paper min override active at ${cfg.paperMinScoreOverrideGlobal}; monitor tick skipped/rejectedByThreshold and last tick aboveThresholdCount.`
    );
  }
  if (!cfg.paperSizeByScoreEnabled) {
    recParts.push("Enable `PAPER_TRADING_SIZE_BY_SCORE_ENABLED=1` to trial conservative tiered sizing.");
  }
  if (cfg.paperMaxEstimatedSlippageBps == null) {
    recParts.push(
      "Optional: set `PAPER_TRADING_MAX_ESTIMATED_SLIPPAGE_BPS` after reviewing slippage distributions below."
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    implementationNote: PAPER_ROI_IMPLEMENTATION_NOTE,
    paperConfig: {
      threshold: cfg.threshold,
      minScoreBuffer: cfg.minScoreBuffer,
      effectiveMinScoreDefault,
      paperMinScoreOverrideGlobal: cfg.paperMinScoreOverrideGlobal,
      paperSizeByScoreEnabled: cfg.paperSizeByScoreEnabled,
      paperSizeScoreTiers: cfg.paperSizeScoreTiers.map((t) => ({
        maxExclusive: t.maxExclusive,
        label: t.label,
        multiplier: t.multiplier,
      })),
      paperMaxSpreadBps: cfg.paperMaxSpreadBps,
      paperMaxEstimatedSlippageBps: cfg.paperMaxEstimatedSlippageBps,
    },
    lastOpenTick,
    windowTrades: {
      total: trades.length,
      open,
      closed: closed.length,
      withPaperRoiAdmission: withRoi,
    },
    scoreQuantilesRecentCandidates: {
      note: `Scores from PaperTrade rows in the ${lookbackDays}d window (proxy for scored cohort; not raw shadow pool).`,
      count: recentScores.length,
      scores: sortedScores.slice(0, 50),
      p50: quantileSorted(sortedScores, 0.5),
      p90: quantileSorted(sortedScores, 0.9),
    },
    simulatedBucketCountsOnScores: simulatedBuckets,
    opensByConfiguredSizeBucket: opensByBucket,
    closedPnlByScoreBucket: closedPnlByScoreBucket.sort((a, b) => b.closedCount - a.closedCount),
    spreadSlippage: {
      spreadBps: {
        count: spreads.length,
        mean: mean(spreads),
        p50: medianSorted(spreadSorted),
        p90: quantileSorted(spreadSorted, 0.9),
      },
      slippageBps: {
        count: slips.length,
        mean: mean(slips),
        p50: medianSorted(slipSorted),
        p90: quantileSorted(slipSorted, 0.9),
      },
    },
    recommendation: {
      summary: recParts.join(" "),
      caveat,
    },
  };
}
