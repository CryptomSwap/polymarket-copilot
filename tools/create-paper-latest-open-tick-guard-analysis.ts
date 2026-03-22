/**
 * Read-only: analyze guard / liquidity rejections on score-eligible candidates from the
 * latest persisted paper open tick (PaperTradingState.lastOpenTickResultJson).
 *
 * Run: npx tsx tools/create-paper-latest-open-tick-guard-analysis.ts
 *      npm run dump:paper-latest-open-tick-guard-analysis
 */

import "dotenv/config";
import { prisma } from "../lib/db";
function optNum(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") {
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function prefixFromTopCandidateAssetId(assetId: string): string {
  const s = String(assetId);
  if (s.endsWith("…") || s.endsWith("\u2026")) return s.slice(0, 12);
  return s.length > 12 ? s.slice(0, 12) : s;
}

interface TopSample {
  assetId: string;
  side: string;
  score: number;
}

function matchTopScore(traceAssetId: string, tops: TopSample[]): { side: string | null; admissionScore: number | null } {
  for (const t of tops) {
    const p = prefixFromTopCandidateAssetId(t.assetId);
    if (p && traceAssetId.startsWith(p)) {
      return { side: t.side, admissionScore: t.score };
    }
  }
  return { side: null, admissionScore: null };
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function minMax(nums: number[]): { min: number | null; max: number | null } {
  if (nums.length === 0) return { min: null, max: null };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();

  let state: Awaited<ReturnType<typeof prisma.paperTradingState.findUnique>>;
  try {
    state = await prisma.paperTradingState.findUnique({ where: { id: "default" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(
      JSON.stringify(
        {
          generatedAt,
          error: "database_unavailable",
          message: msg.slice(0, 800),
        },
        null,
        2
      )
    );
    return;
  }

  if (!state?.lastOpenTickResultJson) {
    console.log(
      JSON.stringify(
        {
          generatedAt,
          tickId: null,
          createdAt: state?.lastOpenTickAt?.toISOString() ?? null,
          error: "no_persisted_open_tick_json",
        },
        null,
        2
      )
    );
    return;
  }

  let tick: Record<string, unknown>;
  try {
    tick = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
  } catch {
    console.log(
      JSON.stringify(
        {
          generatedAt,
          tickId: null,
          createdAt: state.lastOpenTickAt?.toISOString() ?? null,
          error: "invalid_json_lastOpenTickResultJson",
        },
        null,
        2
      )
    );
    return;
  }

  const paperRoi = asRecord(tick.paperRoiAdmissionConfig);
  const bundle = asRecord(tick.decisionTraceBundle);
  const tracesRaw = Array.isArray(bundle?.traces) ? bundle!.traces : [];

  const topCandidates: TopSample[] = [];
  const topArr = tick.topCandidateScores;
  if (Array.isArray(topArr)) {
    for (const x of topArr) {
      const o = asRecord(x);
      if (!o) continue;
      const assetId = typeof o.assetId === "string" ? o.assetId : "";
      const side = typeof o.side === "string" ? o.side : "";
      const score = optNum(o.score);
      if (assetId && side && score != null) topCandidates.push({ assetId, side, score });
    }
  }

  const scoreEligibleRows: Array<{
    assetId: string;
    side: string | null;
    botKey: string | null;
    score: number | null;
    rejectReasonCode: string | null;
    spreadBps: number | null;
    estimatedSlippageBps: number | null;
    cooldownLimited: boolean;
    dedupeLimited: boolean;
    capsLimited: boolean;
    budgetLimited: boolean;
    explorationEligible: boolean;
    explorationUsed: boolean;
    finalDisposition: string | null;
  }> = [];

  for (const tr of tracesRaw) {
    const t = asRecord(tr);
    if (!t) continue;
    const thresholdEligible = t.thresholdEligible === true;
    if (!thresholdEligible) continue;

    const assetId = typeof t.assetId === "string" ? t.assetId : "";
    if (!assetId) continue;

    const botKey = typeof t.botType === "string" ? t.botType : null;
    const m = matchTopScore(assetId, topCandidates);
    const champion = optNum(t.championScore);
    const sideFromTrace = typeof t.side === "string" ? t.side : null;
    const score = m.admissionScore ?? champion;

    const extSpread =
      optNum(t.spreadBps) ??
      optNum(t.spread_bps) ??
      optNum((t.executionContext as Record<string, unknown> | undefined)?.spreadBps);
    const extSlip =
      optNum(t.estimatedSlippageBps) ??
      optNum(t.estimated_slippage_bps) ??
      optNum((t.executionContext as Record<string, unknown> | undefined)?.estimatedSlippageBps);

    const codeRaw = t.rejectReasonCode;
    const rejectReasonCode = typeof codeRaw === "string" ? codeRaw : null;

    scoreEligibleRows.push({
      assetId,
      side: sideFromTrace ?? m.side,
      botKey,
      score,
      rejectReasonCode,
      spreadBps: extSpread,
      estimatedSlippageBps: extSlip,
      cooldownLimited: t.cooldownLimited === true,
      dedupeLimited: t.dedupeLimited === true,
      capsLimited: t.capsLimited === true,
      budgetLimited: t.budgetLimited === true,
      explorationEligible: t.explorationEligible === true,
      explorationUsed: t.explorationUsed === true,
      finalDisposition: typeof t.finalDisposition === "string" ? t.finalDisposition : null,
    });
  }

  const byCode: Record<string, { count: number; scores: number[] }> = {};
  for (const r of scoreEligibleRows) {
    const key = r.rejectReasonCode ?? "(admitted_or_no_code)";
    if (!byCode[key]) byCode[key] = { count: 0, scores: [] };
    byCode[key]!.count++;
    if (r.score != null) byCode[key]!.scores.push(r.score);
  }

  const countsByRejectReasonCode: Record<string, number> = {};
  const averageScoreByRejectReasonCode: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(byCode)) {
    countsByRejectReasonCode[k] = v.count;
    averageScoreByRejectReasonCode[k] = mean(v.scores);
  }

  const spreadGuardSpreads = scoreEligibleRows
    .filter((r) => r.rejectReasonCode === "spread_guard")
    .map((r) => r.spreadBps)
    .filter((x): x is number => x != null && Number.isFinite(x));

  const spreadGuardSpreadBpsStats = {
    n: spreadGuardSpreads.length,
    min: minMax(spreadGuardSpreads).min,
    avg: mean(spreadGuardSpreads),
    max: minMax(spreadGuardSpreads).max,
  };

  const withSpread = scoreEligibleRows.filter((r) => r.spreadBps != null && Number.isFinite(r.spreadBps));
  const le = (n: number) => withSpread.filter((r) => (r.spreadBps as number) <= n).length;

  const top10 = [...scoreEligibleRows]
    .filter((r) => r.score != null)
    .sort((a, b) => (b.score as number) - (a.score as number))
    .slice(0, 10)
    .map((r) => ({ ...r }));

  const out = {
    generatedAt,
    tickId: `default:${state.lastOpenTickAt?.toISOString() ?? "unknown"}`,
    createdAt: state.lastOpenTickAt?.toISOString() ?? null,
    schemaNote:
      "Traces persist spreadBps, estimatedSlippageBps, quote prices, and priceUsedForDecision when execution-quality snapshot / shadow input includes them. Admission score is still merged from topCandidateScores by assetId prefix when available.",
    configEcho: {
      paperMinScoreOverrideGlobal: paperRoi ? optNum(paperRoi.paperMinScoreOverrideGlobal) : null,
      paperMaxSpreadBps: paperRoi ? optNum(paperRoi.paperMaxSpreadBps) : null,
      paperMaxEstimatedSlippageBps: paperRoi ? optNum(paperRoi.paperMaxEstimatedSlippageBps) : null,
      paperSizeByScoreEnabled:
        typeof paperRoi?.paperSizeByScoreEnabled === "boolean" ? paperRoi.paperSizeByScoreEnabled : null,
    },
    candidatesLoaded: typeof tick.candidatesLoaded === "number" ? tick.candidatesLoaded : null,
    candidatesScored: typeof tick.candidatesScored === "number" ? tick.candidatesScored : null,
    aboveThresholdCount: typeof tick.aboveThresholdCount === "number" ? tick.aboveThresholdCount : null,
    opened: typeof tick.opened === "number" ? tick.opened : null,
    rejectedByCooldownCount:
      typeof tick.rejectedByCooldownCount === "number" ? tick.rejectedByCooldownCount : null,
    rejectedByRiskLimitCount:
      typeof tick.rejectedByRiskLimitCount === "number" ? tick.rejectedByRiskLimitCount : null,
    rejectedBySpreadGuardCount:
      typeof tick.rejectedBySpreadGuardCount === "number" ? tick.rejectedBySpreadGuardCount : null,
    rejectedBySlippageGuardCount:
      typeof tick.rejectedBySlippageGuardCount === "number" ? tick.rejectedBySlippageGuardCount : null,
    scoreEligibleTraces: scoreEligibleRows,
    summaries: {
      countsByRejectReasonCode,
      averageScoreByRejectReasonCode,
      spreadGuardSpreadBps: spreadGuardSpreadBpsStats,
      scoreEligibleWithSpreadBpsAtMost: {
        le220: le(220),
        le250: le(250),
        le300: le(300),
        scoreEligibleWithSpreadBpsKnown: withSpread.length,
      },
    },
    top10ScoreEligibleByScore: top10,
    traceBundleMeta: bundle
      ? {
          generatedAt: typeof bundle.generatedAt === "string" ? bundle.generatedAt : null,
          maxTracesStored: typeof bundle.maxTracesStored === "number" ? bundle.maxTracesStored : null,
          totalCandidatesConsidered:
            typeof bundle.totalCandidatesConsidered === "number" ? bundle.totalCandidatesConsidered : null,
        }
      : null,
  };

  console.log(JSON.stringify(out, null, 2));
}

function asRecord(x: unknown): Record<string, unknown> | null {
  return x != null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
