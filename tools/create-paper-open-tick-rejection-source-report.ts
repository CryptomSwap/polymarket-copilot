/**
 * Read-only: rejection sources on the latest persisted paper open tick (budget, cooldown, spread guard,
 * and why spread observability may be null). Writes dump/paper-open-tick-rejection-source-report.md
 * and prints JSON to stdout.
 *
 * Run: npx tsx tools/create-paper-open-tick-rejection-source-report.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getPaperTradingConfig } from "../lib/paper-trading/config";

const DUMP_DIR = path.join(process.cwd(), "dump");
const MD_PATH = path.join(DUMP_DIR, "paper-open-tick-rejection-source-report.md");

function asRecord(x: unknown): Record<string, unknown> | null {
  return x != null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function optNum(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  return null;
}

/** Static reference-only (must match engine at time of report). */
const CODE_PATH_REFERENCE = {
  persistTraces:
    "`runPaperTradingTick` → `persistOpenTickState` serializes `PaperTradingTickResult` including `decisionTraceBundle.traces` built by `buildTraceEntry` in `lib/paper-trading/engine.ts`.",
  spreadGuardLegacy:
    "Legacy path: after score ≥ min, `buildExecutionContextFromShadowInput(c.shadowInput)` then `evaluatePaperLiquidityGuards(...)`; if `!ok` and reason `spread`, `rejectReasonCode: \"spread_guard\"` and `buildTraceEntry` (≈ lines 667–700).",
  spreadGuardMultiBot:
    "Multi-bot path: same pattern with `execCtxBot` / `liqBot` (≈ lines 1504–1543).",
  budgetCapLegacy:
    "`budget_cap` when `config.maxDailyNewTrades > 0` and `createdToday + totalOpened >= maxDailyNewTrades` (≈ lines 727–750); trace sets `budgetLimited: true`.",
  budgetCapMultiBot:
    "Multi-bot: `maxDailyNewTrades` from profile/config and optional allocator `decision?.maxNewTradesToday` (≈ lines 1573–1613); same `rejectReasonCode` and `budgetLimited: true`.",
  cooldownAssetLegacy:
    "`cooldown_asset` when `hasOpenOrRecentPaperTrade(\"default\", c.assetId, config.cooldownHours)` (≈ lines 752–775); `cooldownLimited: true`.",
  cooldownAssetMultiBot:
    "Multi-bot: `hasOpenOrRecentPaperTrade(profile.botType, c.assetId, cooldownHours)` (≈ lines 1616–1641).",
  spreadBpsOnTrace:
    "`buildTraceEntry` calls `paperDecisionTraceMarketScalars(c)` which uses `buildExecutionContextFromShadowInput` for `spreadBps` / slippage bps from `shadowInput.spreadBps` / `estimatedSlippage`, and `quoteBestBid` / `quoteBestAsk` / `quoteMidPrice` from shadow input (populated from `executionQualitySnapshotJson` in `buildShadowScoreInputFromShadowCandidateRow` in `lib/paper-trading/candidates.ts`).",
};

function renderMarkdown(report: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("# Paper open tick — rejection source (diagnostic)");
  lines.push("");
  lines.push(`- **Generated:** ${String(report.generatedAt ?? "—")}`);
  lines.push(`- **Tick:** ${report.tickId != null ? String(report.tickId) : "—"}`);
  lines.push(`- **lastOpenTickAt:** ${report.createdAt != null ? String(report.createdAt) : "—"}`);
  if (report.error) lines.push(`- **Error:** ${String(report.error)}`);
  lines.push("");

  lines.push("## Code paths (reference only)");
  lines.push("");
  lines.push("### `budget_cap`");
  lines.push("");
  lines.push(CODE_PATH_REFERENCE.budgetCapLegacy);
  lines.push("");
  lines.push(CODE_PATH_REFERENCE.budgetCapMultiBot);
  lines.push("");

  lines.push("### `spread_guard`");
  lines.push("");
  lines.push(CODE_PATH_REFERENCE.spreadGuardLegacy);
  lines.push("");
  lines.push(CODE_PATH_REFERENCE.spreadGuardMultiBot);
  lines.push("");
  lines.push(
    "Spread decision only: `evaluatePaperLiquidityGuards` in `lib/paper-trading/paper-roi-admission.ts` — blocks on spread only when `maxSpreadBps` is set **and** `spreadBps` is a finite number **and** `spreadBps > maxSpreadBps`. Missing spread does **not** trigger spread block in current code."
  );
  lines.push("");

  lines.push("### `cooldown_asset`");
  lines.push("");
  lines.push(CODE_PATH_REFERENCE.cooldownAssetLegacy);
  lines.push("");
  lines.push(CODE_PATH_REFERENCE.cooldownAssetMultiBot);
  lines.push("");

  lines.push("### Where traces (and spread fields) are persisted");
  lines.push("");
  lines.push(CODE_PATH_REFERENCE.persistTraces);
  lines.push("");
  lines.push(CODE_PATH_REFERENCE.spreadBpsOnTrace);
  lines.push("");

  lines.push("## Why `spreadBps` can still be `null` in persisted traces");
  lines.push("");
  lines.push(String(report.spreadNullLikelyReason ?? "—"));
  lines.push("");

  lines.push("## Is this tick enough to tune guardrails safely?");
  lines.push("");
  lines.push(String(report.tuningSufficiencyNote ?? "—"));
  lines.push("");

  lines.push("## Latest tick snapshot (from DB JSON)");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(report.latestSnapshot ?? {}, null, 2));
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  let state: Awaited<ReturnType<typeof prisma.paperTradingState.findUnique>>;
  try {
    state = await prisma.paperTradingState.findUnique({ where: { id: "default" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const errReport = {
      generatedAt,
      error: "database_unavailable",
      message: msg.slice(0, 800),
      spreadNullLikelyReason: "Database unreachable — re-run when `DATABASE_URL` is valid.",
      tuningSufficiencyNote: "No tick data loaded.",
      latestSnapshot: {},
    };
    console.log(JSON.stringify(errReport, null, 2));
    await fs.mkdir(DUMP_DIR, { recursive: true });
    await fs.writeFile(MD_PATH, renderMarkdown(errReport as unknown as Record<string, unknown>), "utf8");
    return;
  }

  const cfgLive = getPaperTradingConfig();

  if (!state?.lastOpenTickResultJson) {
    const r = {
      generatedAt,
      tickId: null,
      createdAt: state?.lastOpenTickAt?.toISOString() ?? null,
      error: "no_persisted_open_tick_json",
      spreadNullLikelyReason: "No tick JSON — cannot inspect traces.",
      tuningSufficiencyNote: "Run at least one paper open tick first.",
      latestSnapshot: {},
    };
    console.log(JSON.stringify(r, null, 2));
    await fs.mkdir(DUMP_DIR, { recursive: true });
    await fs.writeFile(MD_PATH, renderMarkdown(r), "utf8");
    return;
  }

  let tick: Record<string, unknown>;
  try {
    tick = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
  } catch {
    const r = {
      generatedAt,
      tickId: null,
      createdAt: state.lastOpenTickAt?.toISOString() ?? null,
      error: "invalid_json_lastOpenTickResultJson",
      spreadNullLikelyReason: "—",
      tuningSufficiencyNote: "—",
      latestSnapshot: {},
    };
    console.log(JSON.stringify(r, null, 2));
    await fs.mkdir(DUMP_DIR, { recursive: true });
    await fs.writeFile(MD_PATH, renderMarkdown(r), "utf8");
    return;
  }

  const paperRoi = asRecord(tick.paperRoiAdmissionConfig);
  const bundle = asRecord(tick.decisionTraceBundle);
  const tracesRaw = Array.isArray(bundle?.traces) ? bundle!.traces : [];
  const traces = tracesRaw.map((t) => asRecord(t)).filter(Boolean) as Record<string, unknown>[];

  const scoreEligible = traces.filter((t) => t.thresholdEligible === true);

  const countsByRejectReasonCode: Record<string, number> = {};
  for (const t of scoreEligible) {
    const code =
      typeof t.rejectReasonCode === "string" ? t.rejectReasonCode : "(admitted_or_no_code)";
    countsByRejectReasonCode[code] = (countsByRejectReasonCode[code] ?? 0) + 1;
  }

  function marketAllNull(t: Record<string, unknown>): boolean {
    const keys = [
      "spreadBps",
      "estimatedSlippageBps",
      "bestBid",
      "bestAsk",
      "midPrice",
      "priceUsedForDecision",
    ] as const;
    return keys.every((k) => t[k] == null || (typeof t[k] === "number" && !Number.isFinite(t[k] as number)));
  }

  const scoreEligibleRows = scoreEligible.map((t) => ({
    assetId: typeof t.assetId === "string" ? t.assetId : null,
    botKey: typeof t.botType === "string" ? t.botType : null,
    score: optNum(t.championScore),
    rejectReasonCode: typeof t.rejectReasonCode === "string" ? t.rejectReasonCode : null,
    budgetLimited: t.budgetLimited === true,
    cooldownLimited: t.cooldownLimited === true,
    capsLimited: t.capsLimited === true,
    dedupeLimited: t.dedupeLimited === true,
    spreadBps: optNum(t.spreadBps),
    estimatedSlippageBps: optNum(t.estimatedSlippageBps),
    bestBid: optNum(t.bestBid),
    bestAsk: optNum(t.bestAsk),
    midPrice: optNum(t.midPrice),
    priceUsedForDecision: optNum(t.priceUsedForDecision),
    recommendationId: typeof t.recommendationId === "string" ? t.recommendationId : null,
    marketId: typeof t.marketId === "string" ? t.marketId : null,
    dedupeKey: typeof t.dedupeKey === "string" ? t.dedupeKey : null,
    minScore: optNum(t.minScore),
    explorationMinScore: optNum(t.explorationMinScore),
  }));

  const summaries = {
    countsByRejectReasonCode,
    scoreEligibleCount: scoreEligible.length,
    countAllMarketScalarsNull: scoreEligible.filter(marketAllNull).length,
    countBudgetLimitedTrue: scoreEligible.filter((t) => t.budgetLimited === true).length,
    countCooldownLimitedTrue: scoreEligible.filter((t) => t.cooldownLimited === true).length,
    countSpreadGuard: scoreEligible.filter((t) => t.rejectReasonCode === "spread_guard").length,
    countBudgetCap: scoreEligible.filter((t) => t.rejectReasonCode === "budget_cap").length,
    countCooldownAsset: scoreEligible.filter((t) => t.rejectReasonCode === "cooldown_asset").length,
  };

  const allMarketNullCount = summaries.countAllMarketScalarsNull;
  const spreadGuardWithNullSpread = scoreEligible.filter(
    (t) => t.rejectReasonCode === "spread_guard" && optNum(t.spreadBps) == null
  ).length;

  const spreadNullLikelyReason = [
    "**Observed on this tick:** " +
      `${allMarketNullCount} of ${scoreEligible.length} score-eligible trace rows have all six market scalars null.`,
    "",
    "**Typical causes (read-only):**",
    "1. **Tick JSON predates trace scalar columns** — `spreadBps` / quote fields were added later; older persisted bundles omit keys, so parsed traces look all-null even if the engine had spread at run time.",
    "2. **Shadow row has no usable execution-quality snapshot** — `buildShadowScoreInputFromShadowCandidateRow` sets `spreadBps` / `quoteBestBid` / … from `executionQualitySnapshotJson`. Missing or minimal snapshots → nulls on `shadowInput` and on traces.",
    "3. **`spread_guard` vs null `spreadBps` on trace:** In current `evaluatePaperLiquidityGuards` (`lib/paper-trading/paper-roi-admission.ts`), spread blocking requires **known** `spreadBps > maxSpreadBps`. So **today’s engine** does not emit `spread_guard` when spread is null. If you still see `spread_guard` with null `spreadBps`, treat it as **stale persistence shape** (row written before trace fields existed) or **inspect raw JSON** for omitted keys.",
    spreadGuardWithNullSpread > 0
      ? `4. **This snapshot:** ${spreadGuardWithNullSpread} score-eligible \`spread_guard\` row(s) have null \`spreadBps\` in the parsed trace — post-patch ticks should normally carry the same spread used for the guard.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const tuningSufficiencyNote =
    allMarketNullCount === scoreEligible.length && scoreEligible.length > 0
      ? "**Insufficient** for spread-guard tuning from traces alone: every score-eligible row lacks market scalars. Prefer a new tick after deploy, and verify `executionQualitySnapshotJson` on recent `ShadowCandidate` rows includes `spreadBps` and quote fields."
      : summaries.countSpreadGuard > 0 && spreadGuardWithNullSpread === summaries.countSpreadGuard
        ? "**Limited:** all `spread_guard` rows lack `spreadBps` in the trace — tune caps only with external quote data or richer snapshots."
        : summaries.countSpreadGuard > 0
          ? "**Partial:** some spread-guard rows include `spreadBps`; use those rows plus aggregate `rejectedBySpreadGuardCount` for coarse tuning."
          : "**Budget/cooldown:** trace flags (`budgetLimited`, `cooldownLimited`) and `rejectReasonCode` align with engine; numeric caps come from env/config (see `configEcho` / live config), not from per-row IDs in the trace.";

  const botBudgets = tick.botBudgets;
  const configEcho = {
    fromTickPaperRoi: paperRoi
      ? {
          paperMinScoreOverrideGlobal: optNum(paperRoi.paperMinScoreOverrideGlobal),
          paperMaxSpreadBps: optNum(paperRoi.paperMaxSpreadBps),
          paperMaxEstimatedSlippageBps: optNum(paperRoi.paperMaxEstimatedSlippageBps),
          paperSizeByScoreEnabled:
            typeof paperRoi.paperSizeByScoreEnabled === "boolean" ? paperRoi.paperSizeByScoreEnabled : null,
        }
      : null,
    livePaperConfigReferenceOnly: {
      maxDailyNewTrades: cfgLive.maxDailyNewTrades,
      cooldownHours: cfgLive.cooldownHours,
      cooldownMarketHours: cfgLive.cooldownMarketHours,
      maxOpenTotal: cfgLive.maxOpenTotal,
    },
    botBudgetKeys:
      botBudgets != null && typeof botBudgets === "object" && !Array.isArray(botBudgets)
        ? Object.keys(botBudgets as object)
        : [],
  };

  const report = {
    generatedAt,
    tickId: `default:${state.lastOpenTickAt?.toISOString() ?? "unknown"}`,
    createdAt: state.lastOpenTickAt?.toISOString() ?? null,
    lastOpenTickError: state.lastOpenTickError,
    configEcho,
    topLevelTickCounts: {
      candidatesLoaded: optNum(tick.candidatesLoaded),
      candidatesScored: optNum(tick.candidatesScored),
      aboveThresholdCount: optNum(tick.aboveThresholdCount),
      opened: optNum(tick.opened),
      skipped: optNum(tick.skipped),
      rejectedBySpreadGuardCount: optNum(tick.rejectedBySpreadGuardCount),
      rejectedBySlippageGuardCount: optNum(tick.rejectedBySlippageGuardCount),
      rejectedByCooldownCount: optNum(tick.rejectedByCooldownCount),
      rejectedByRiskLimitCount: optNum(tick.rejectedByRiskLimitCount),
    },
    traceBundleMeta: bundle
      ? {
          generatedAt: typeof bundle.generatedAt === "string" ? bundle.generatedAt : null,
          maxTracesStored: optNum(bundle.maxTracesStored),
          totalCandidatesConsidered: optNum(bundle.totalCandidatesConsidered),
        }
      : null,
    summaries,
    scoreEligibleTraces: scoreEligibleRows,
    spreadNullLikelyReason,
    tuningSufficiencyNote,
    latestSnapshot: {
      summaries,
      scoreEligibleTraces: scoreEligibleRows.slice(0, 80),
    },
  };

  console.log(JSON.stringify(report, null, 2));

  await fs.mkdir(DUMP_DIR, { recursive: true });
  await fs.writeFile(MD_PATH, renderMarkdown(report), "utf8");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
