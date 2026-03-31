/**
 * Forensic audit: /bot page "Strategy backtest" → POST /api/backtest/mean-reversion → lib/backtest.
 * READ-ONLY: writes dump/bot-backtest-audit.json and dump/bot-backtest-audit.md only.
 *
 * Run: npx tsx tools/create-bot-backtest-audit.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "bot-backtest-audit.json");
const MD_PATH = path.join(DUMP_DIR, "bot-backtest-audit.md");

/** Paths relative to repo root (process.cwd() = polymarket-copilot when invoked as above). */
const REPO_PATHS = {
  botPage: "app/(dashboard)/bot/page.tsx",
  meanReversionApi: "app/api/backtest/mean-reversion/route.ts",
  backtestIndex: "lib/backtest/index.ts",
  backtestTypes: "lib/backtest/types.ts",
  backtestData: "lib/backtest/data.ts",
  backtestRunDb: "lib/backtest/run-db.ts",
  backtestRun: "lib/backtest/run.ts",
  backtestStrategy: "lib/backtest/strategy.ts",
  backtestFeatures: "lib/backtest/features.ts",
  botDryRunApi: "app/api/bot/dry-run/route.ts",
  botDryRunLib: "lib/bot/dry-run.ts",
} as const;

type LeakageVerdict = "no_obvious_leakage" | "possible_leakage" | "strong_leakage_concern";
type TrustVerdict = "not_trustworthy_for_live_edge" | "use_with_major_caveats" | "reasonable_sanity_check_only";

function uiDefaultDateRange(): { startDate: string; endDate: string; note: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 7);
  const startDate = `${start.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const endDate = `${end.toISOString().slice(0, 10)}T23:59:59.999Z`;
  return {
    startDate,
    endDate,
    note:
      "Matches bot page defaults: backtestStart = local today minus 7 days (ISO date slice), backtestEnd = local today; API uses those dates with T00:00:00.000Z / T23:59:59.999Z (see app/(dashboard)/bot/page.tsx).",
  };
}

function buildAuditPayload(): Record<string, unknown> {
  const leakageVerdict: LeakageVerdict = "possible_leakage";
  const trustVerdict: TrustVerdict = "not_trustworthy_for_live_edge";

  return {
    generatedAt: new Date().toISOString(),
    step1_routing: {
      pageFile: REPO_PATHS.botPage,
      backtestApi: REPO_PATHS.meanReversionApi,
      botDryRunApi: REPO_PATHS.botDryRunApi,
      botDryRunLib: REPO_PATHS.botDryRunLib,
      backtestEngineFiles: [
        REPO_PATHS.backtestIndex,
        REPO_PATHS.backtestRunDb,
        REPO_PATHS.backtestRun,
        REPO_PATHS.backtestStrategy,
        REPO_PATHS.backtestFeatures,
        REPO_PATHS.backtestData,
        REPO_PATHS.backtestTypes,
      ],
      connectionToPaperTrading:
        "Separate. Strategy backtest uses lib/backtest (MarketPriceSnapshot replay). Bot dry-run uses lib/bot/dry-run.ts + recommendations/decision snapshots + guardrails. No shared execution path with paper trading fills.",
      uiBacktestRequest:
        "POST /api/backtest/mean-reversion with JSON { startDate, endDate } only — all strategy parameters use DEFAULT_BACKTEST_CONFIG in lib/backtest/types.ts unless extended via API body (UI does not send overrides).",
    },
    step2_strategy_logic: {
      plainEnglish: [
        "Universe: all (marketId, assetId) pairs with MarketPriceSnapshot rows in the selected date range (optional marketIds filter exists in API but not used by /bot UI).",
        "Replay: snapshots sorted by time per pair. At each snapshot, build a rolling window [now - rollingWindowHours, now] and compute features (lib/backtest/features.ts).",
        "Regime: threshold classifier labels each step (RANGE_MEAN_REVERTING, TRENDING_*, ILLIQUID_NOISY, NEAR_RESOLUTION_UNSAFE). Entry requires regime === RANGE_MEAN_REVERTING.",
        "Entry: distanceFromRangeLow < entryNearLowThreshold (default 0.35), i.e. price in lower ~35% of rolling min/max range in window; spreadLiquidityQuality >= minLiquidity (default 0.15); hours to resolution >= nearResolutionHours (default 72) or null.",
        "Exit (checked on later snapshots only, after entry): max hold hours (default 168); near resolution; regime no longer RANGE_MEAN_REVERTING; take-profit pnlPct >= targetProfitPct (default 0.10); or distanceFromRangeHigh < exitNearHighThreshold (default 0.35) → exitReason near_high.",
        "Position sizing: none — implicit one unit of exposure; pnl is percent price change only.",
        "Hold time: difference exitAt - entryAt in hours (aggregateMetrics in lib/backtest/run.ts).",
        "Liquidity: spreadLiquidityQuality = min(1, max(0, snapshot.liquidity / 1e6)) with fallback to SyncedMarket.liquidityNum when snapshot liquidity is 0 (lib/backtest/features.ts + data.ts). Not order-book depth or spread.",
      ],
      codeRefs: {
        entryExit: `${REPO_PATHS.backtestStrategy} — canEnter, shouldExit`,
        featuresRegime: `${REPO_PATHS.backtestFeatures} — computeFeaturesAt, classifyRegimeFromFeatures`,
        replayLoop: `${REPO_PATHS.backtestRun} — runBacktest`,
        defaults: `${REPO_PATHS.backtestTypes} — DEFAULT_BACKTEST_CONFIG`,
        dataLoad: `${REPO_PATHS.backtestData} — loadSnapshots, loadMarketMeta`,
      },
    },
    step3_execution_realism: {
      title: "Execution realism audit",
      fillsAtSnapshotPrice:
        "Yes. entryPrice and exitPrice are both the mid-like `price` field from the snapshot row at decision time (last row in rolling window). lib/backtest/run.ts uses f.price for entry and exit.",
      spreadIncluded: "No. No bid/ask or half-spread adjustment.",
      slippageIncluded: "No.",
      feesIncluded: "No.",
      liquidityLimitsEnforced:
        "Only a coarse filter: spreadLiquidityQuality (liquidity / 1e6) must exceed minLiquidity. No size vs depth, no failed fills.",
      fillsImmediate: "Yes — full fill at snapshot price on the bar where the rule fires.",
      sameBarEntryExit:
        "No. In runBacktest, entry sets position at end of iteration i; exit is evaluated starting iteration i+1 (lib/backtest/run.ts loop).",
      lookAheadInFillsOrExits:
        "Features use only snapshots with capturedAt <= now (window end). Rolling high/low include the current bar's price (not future bars). See step4 for subtle modeling issues.",
    },
    step4_leakage: {
      title: "Leakage audit",
      verdict: leakageVerdict,
      findings: [
        {
          severity: "medium",
          topic: "Regime misclassification / optimistic default",
          detail:
            "classifyRegimeFromFeatures returns RANGE_MEAN_REVERTING as the final fallback even when volatility/range inputs are weak (lib/backtest/features.ts lines 37–44). That inflates eligible 'range' bars versus a stricter classifier.",
          codePath: REPO_PATHS.backtestFeatures,
        },
        {
          severity: "low",
          topic: "Dead guard branch",
          detail:
            "canEnter rejects NEWS_SHOCK but classifyRegimeFromFeatures never emits NEWS_SHOCK (lib/backtest/strategy.ts vs lib/backtest/features.ts).",
          codePath: `${REPO_PATHS.backtestStrategy}; ${REPO_PATHS.backtestFeatures}`,
        },
        {
          severity: "medium",
          topic: "Return anchors for trend score",
          detail:
            "p1h/p6h/p24h use sorted.find(<= now - delta) on ascending series — the first match is the earliest snapshot in-window before the cutoff, not necessarily the point ~1h/6h/24h ago. Stale reference distorts trendScore; not classic lookahead but weak alignment to 'as of now'.",
          codePath: REPO_PATHS.backtestFeatures,
        },
        {
          severity: "high",
          topic: "Drawdown proxy is not time-ordered",
          detail:
            "aggregateMetrics sums trade pnl in array order. Trades are appended in Map iteration order over (marketId, assetId) groups (insertion order of first snapshot per key), not global chronological exit order. Peak/drawdown on that cumulative sum is not a portfolio equity curve.",
          codePath: REPO_PATHS.backtestRun,
        },
      ],
      summaryLine:
        "No single line uses future snapshot rows to decide the current bar; however optimistic regime fallback, non-causal ordering of drawdown, and coarse liquidity/spread modeling mean reported metrics can look better than executable reality.",
    },
    step5_pnl_math: {
      entryPrice: "f.price at entry bar — last snapshot in rolling window, clamped invalid to 0.5 (lib/backtest/features.ts).",
      exitPrice: "f.price at exit bar (same construction).",
      pnlPct: "(exitPrice - entryPrice) / entryPrice — long-only; no short side (lib/backtest/run.ts).",
      sideHandling: "Implicit long only; SELL / outcome token semantics are not modeled.",
      lossCapping: "None — losses can exceed target magnitude.",
      winLossAggregation:
        "wins: pnlPct > 0; losses: pnlPct <= 0 (lib/backtest/run.ts aggregateMetrics).",
      expectancy:
        "expectancyPct = mean of all trade pnlPct (sum/totalTrades), arithmetic not compounded.",
      drawdownProxy:
        "Sequential cumulative sum of trade pnlPct in trades array order; drawdownProxyPct = max_t (peak_cum - cum_t). Not dollar equity and not time-sorted across markets.",
    },
    step6_why_strong_metrics: {
      title: "Why results may look unusually strong",
      bullets: [
        {
          point: "High trade count",
          codeLink:
            "Multiple sequential round-trips per (marketId, assetId) are allowed; each complete entry→exit is one trade (lib/backtest/run.ts). Narrow date range with frequent snapshots → many trades.",
        },
        {
          point: "No transaction costs",
          codeLink: "lib/backtest/run.ts — raw price ratio only.",
        },
        {
          point: "Optimistic exits",
          codeLink:
            "near_high exits at snapshot mid when price reaches upper band of rolling range (lib/backtest/strategy.ts shouldExit) — no guarantee of fill at that price.",
        },
        {
          point: "Universe = whatever has snapshots in range",
          codeLink: "lib/backtest/data.ts loadSnapshots — no explicit quality filter beyond strategy gates.",
        },
        {
          point: "Survivorship / selection",
          codeLink:
            "Markets with sparse or missing snapshots simply produce fewer/no trades; aggregate stats are conditional on captured data, not a fixed investable universe.",
        },
        {
          point: "Narrow default window",
          codeLink: "app/(dashboard)/bot/page.tsx — default 7-day span.",
        },
      ],
    },
    step7_reproduction: {
      uiAlignedRange: uiDefaultDateRange(),
    },
    step8_verdict: {
      whatThePageIs:
        "An interactive UI card on /bot that runs a deterministic snapshot-replay simulator (mean-reversion on rolling range) against MarketPriceSnapshot; separate from bot dry-run and from paper trading execution.",
      canPerformanceBeTrusted: trustVerdict,
      biggestOverstatementReasons: [
        "Fills at snapshot mid with no fees, spread, or slippage (lib/backtest/run.ts, features.ts).",
        "Regime label defaults toward RANGE_MEAN_REVERTING when signals are ambiguous (lib/backtest/features.ts).",
        "Drawdown and expectancy are simple transforms of per-trade returns in non-chronological order for multi-market portfolios (lib/backtest/run.ts aggregateMetrics).",
      ],
      mustFixBeforeTreatingAsEdge: [
        "Model bid/ask or conservative slippage and fees per trade.",
        "Harden regime detection and align trend/return features with causal 'as of' timestamps.",
        "Compute portfolio-equity and drawdown on a single global timeline with capital constraints and position limits.",
        "Validate against paper-trading or live-like execution simulation on the same signals.",
      ],
    },
    terminalSummary: {
      backtestEnginePath: REPO_PATHS.backtestRun,
      trustVerdict,
      top3Concerns: [
        "Zero execution costs and mid-price fills (lib/backtest/run.ts).",
        "Optimistic RANGE_MEAN_REVERTING fallback (lib/backtest/features.ts classifyRegimeFromFeatures).",
        "Drawdown proxy not chronologically meaningful across markets (lib/backtest/run.ts aggregateMetrics).",
      ],
    },
  };
}

function renderMarkdown(audit: Record<string, unknown>): string {
  const s8 = audit.step8_verdict as Record<string, unknown>;
  const s3 = audit.step3_execution_realism as Record<string, unknown>;
  const s4 = audit.step4_leakage as Record<string, unknown>;
  const s7 = audit.step7_reproduction as Record<string, unknown>;
  const term = audit.terminalSummary as Record<string, unknown>;
  const s1 = audit.step1_routing as Record<string, unknown>;

  const lines: string[] = [
    "# /bot strategy backtest — forensic audit",
    "",
    `Generated: ${audit.generatedAt}`,
    "",
    "## Step 1 — Page and engine locations",
    "",
    `- **Page:** \`${s1.pageFile}\``,
    `- **Backtest API:** \`${s1.backtestApi}\``,
    `- **Bot dry-run (same page, different feature):** \`${s1.botDryRunApi}\`, \`${s1.botDryRunLib}\``,
    `- **Backtest engine:** ${(s1.backtestEngineFiles as string[]).map((p) => `\`${p}\``).join(", ")}`,
    "",
    String(s1.connectionToPaperTrading),
    "",
    "## Step 2 — Strategy logic (plain English + code pointers)",
    "",
    ...((audit.step2_strategy_logic as { plainEnglish: string[] }).plainEnglish.map((x) => `- ${x}`)),
    "",
    "**Code references:**",
    "",
    "```text",
    JSON.stringify((audit.step2_strategy_logic as { codeRefs: unknown }).codeRefs, null, 2),
    "```",
    "",
    "## Step 3 — Execution realism audit",
    "",
    ...Object.entries(s3)
      .filter(([k]) => k !== "title")
      .map(([k, v]) => `- **${k}:** ${typeof v === "string" ? v : JSON.stringify(v)}`),
    "",
    "## Step 4 — Leakage audit",
    "",
    `**Verdict:** \`${s4.verdict}\``,
    "",
    ...((s4.findings as { severity: string; topic: string; detail: string; codePath: string }[]).map(
      (f) => `### ${f.topic} (${f.severity})\n\n${f.detail}\n\n- \`${f.codePath}\`\n`
    )),
    String(s4.summaryLine),
    "",
    "## Step 5 — PnL calculation",
    "",
    "```text",
    JSON.stringify(audit.step5_pnl_math, null, 2),
    "```",
    "",
    "## Step 6 — Why results may look unusually strong",
    "",
    ...((audit.step6_why_strong_metrics as { bullets: { point: string; codeLink: string }[] }).bullets.map(
      (b) => `- **${b.point}:** ${b.codeLink}`
    )),
    "",
    "## Step 7 — Reproduction / sanity check",
    "",
    "```text",
    JSON.stringify(s7, null, 2),
    "```",
    "",
    "## Appendix — Code excerpts (read at report generation time)",
    "",
    ...((audit.codeEvidence as Snippet[]) ?? []).flatMap((sn) => [
      `### \`${sn.file}\` (lines ${sn.lineStart}-${sn.lineEnd})`,
      "",
      "```ts",
      ...sn.lines,
      "```",
      "",
    ]),
    "## Step 8 — Final verdict",
    "",
    "### 1. What this /bot page actually is",
    "",
    String(s8.whatThePageIs),
    "",
    "### 2. Can the reported performance be trusted?",
    "",
    String(s8.canPerformanceBeTrusted),
    "",
    "### 3. Biggest reasons it may be overstated",
    "",
    ...(s8.biggestOverstatementReasons as string[]).map((x) => `- ${x}`),
    "",
    "### 4. What must be fixed before treating this as real edge",
    "",
    ...(s8.mustFixBeforeTreatingAsEdge as string[]).map((x) => `- ${x}`),
    "",
    "---",
    "",
    "## Terminal summary (required)",
    "",
    `- **Backtest engine path:** \`${term.backtestEnginePath}\``,
    `- **Trust verdict:** \`${term.trustVerdict}\``,
    "- **Top 3 optimism / leakage concerns:**",
    ...((term.top3Concerns as string[]).map((c, i) => `  ${i + 1}. ${c}`)),
    "",
  ];
  return lines.join("\n");
}

async function tryReproduce(): Promise<Record<string, unknown>> {
  const range = uiDefaultDateRange();
  try {
    const { runBacktestFromDb } = await import("../lib/backtest");
    const { prisma } = await import("../lib/db");
    try {
      const result = await runBacktestFromDb({
        startDate: range.startDate,
        endDate: range.endDate,
      });
      const trades = result.trades ?? [];
      const exitReasons: Record<string, number> = {};
      for (const t of trades) {
        const r = t.exitReason ?? "unknown";
        exitReasons[r] = (exitReasons[r] ?? 0) + 1;
      }
      return {
        reproductionStatus: "ok",
        requestedStartDate: range.startDate,
        requestedEndDate: range.endDate,
        metrics: result.metrics,
        exitReasonCounts: exitReasons,
        tradeSampleSize: trades.length,
      };
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
  } catch (e) {
    return {
      reproductionStatus: "failed",
      requestedStartDate: range.startDate,
      requestedEndDate: range.endDate,
      error: e instanceof Error ? e.message : String(e),
      hint: "Ensure DATABASE_URL is set and DB reachable; same env as Next app.",
    };
  }
}

type Snippet = { file: string; lineStart: number; lineEnd: number; lines: string[] };

async function loadCodeSnippets(root: string): Promise<Snippet[]> {
  const slices: { file: string; lineStart: number; lineEnd: number }[] = [
    { file: REPO_PATHS.backtestFeatures, lineStart: 21, lineEnd: 45 },
    { file: REPO_PATHS.backtestFeatures, lineStart: 64, lineEnd: 102 },
    { file: REPO_PATHS.backtestStrategy, lineStart: 17, lineEnd: 67 },
    { file: REPO_PATHS.backtestRun, lineStart: 36, lineEnd: 87 },
    { file: REPO_PATHS.backtestRun, lineStart: 113, lineEnd: 162 },
    { file: REPO_PATHS.backtestTypes, lineStart: 29, lineEnd: 48 },
    { file: REPO_PATHS.botPage, lineStart: 373, lineEnd: 405 },
  ];
  const out: Snippet[] = [];
  for (const s of slices) {
    const abs = path.join(root, s.file);
    try {
      const raw = await fs.readFile(abs, "utf8");
      const all = raw.split(/\r?\n/);
      const start = s.lineStart - 1;
      const end = s.lineEnd;
      const lines = all.slice(start, end);
      out.push({ file: s.file, lineStart: s.lineStart, lineEnd: s.lineEnd, lines });
    } catch {
      out.push({
        file: s.file,
        lineStart: s.lineStart,
        lineEnd: s.lineEnd,
        lines: [`<failed to read ${abs}>`],
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const audit = buildAuditPayload();
  const repro = await tryReproduce();
  audit.step7_reproduction = { ...((audit.step7_reproduction as object) ?? {}), ...repro };
  audit.codeEvidence = await loadCodeSnippets(process.cwd());

  await fs.writeFile(JSON_PATH, JSON.stringify(audit, null, 2), "utf8");
  await fs.writeFile(MD_PATH, renderMarkdown(audit as Record<string, unknown>), "utf8");

  const term = audit.terminalSummary as {
    backtestEnginePath: string;
    trustVerdict: string;
    top3Concerns: string[];
  };
  console.log("--- bot backtest audit ---");
  console.log("Wrote:", JSON_PATH);
  console.log("Wrote:", MD_PATH);
  console.log("Backtest engine path:", term.backtestEnginePath);
  console.log("Trust verdict:", term.trustVerdict);
  console.log("Top 3 optimism/leakage concerns:");
  term.top3Concerns.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  if ((repro as { reproductionStatus?: string }).reproductionStatus === "ok") {
    console.log("Reproduction (UI-default range):", JSON.stringify((repro as { metrics?: unknown }).metrics, null, 2));
    console.log("Exit reasons:", JSON.stringify((repro as { exitReasonCounts?: unknown }).exitReasonCounts, null, 2));
  } else {
    console.log(
      "Reproduction:",
      (repro as { reproductionStatus?: string }).reproductionStatus,
      (repro as { error?: string }).error ?? ""
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
