/**
 * Read-only: break down paper `rejectedByRiskLimitCount` and related cap rejections
 * from the latest persisted open tick (`lastOpenTickResultJson`) plus current open portfolio.
 *
 * Writes:
 * - dump/paper-risk-limit-breakdown.json
 * - dump/paper-risk-limit-breakdown.md
 *
 * Run: npx tsx tools/create-paper-risk-limit-breakdown.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "paper-risk-limit-breakdown.json");
const MD_PATH = path.join(DUMP_DIR, "paper-risk-limit-breakdown.md");
const STATE_ID = "default";
const EXAMPLES_PER_RULE = 5;

/** Codes that increment `rejectedByRiskLimitCount` in `lib/paper-trading/engine.ts`. */
const ENGINE_RISK_LIMIT_CODES = new Set([
  "budget_cap",
  "max_open_total",
  "max_open_per_market",
  "max_open_per_theme",
  "max_open_per_category",
]);

/**
 * Engine overload: relaxed concentration sub-caps emit `max_open_total` but do NOT increment
 * `rejectedByRiskLimitCount` (see engine relaxed-concentration block after dedupe).
 */
type RuleFamily =
  | "daily_new_trades_cap"
  | "max_open_total_combined"
  | "per_market_open_cap"
  | "per_theme_open_cap"
  | "per_category_open_cap"
  | "other_risk_limit";

function familyForTrace(t: Record<string, unknown>): RuleFamily {
  const code = typeof t.rejectReasonCode === "string" ? t.rejectReasonCode : "";
  if (code === "budget_cap") return "daily_new_trades_cap";
  if (code === "max_open_per_market") return "per_market_open_cap";
  if (code === "max_open_per_theme") return "per_theme_open_cap";
  if (code === "max_open_per_category") return "per_category_open_cap";
  if (code === "max_open_total") return "max_open_total_combined";
  return "other_risk_limit";
}

function pct(n: number, d: number): number {
  if (d <= 0) return 0;
  return Math.round((n / d) * 10000) / 100;
}

function compactExample(t: Record<string, unknown>): Record<string, unknown> {
  const aid = typeof t.assetId === "string" ? t.assetId : "";
  return {
    botType: t.botType ?? null,
    assetId: aid.length > 14 ? `${aid.slice(0, 14)}…` : aid || null,
    marketId: t.marketId ?? null,
    marketSlug: t.marketSlug ?? null,
    theme: t.theme ?? null,
    category: t.category ?? null,
    rejectReasonCode: t.rejectReasonCode ?? null,
    admissionScore: t.admissionScore ?? null,
    paperRelaxationReason: t.paperRelaxationReason ?? null,
    paperPolicyMode: t.paperPolicyMode ?? null,
    budgetLimited: t.budgetLimited ?? null,
    capsLimited: t.capsLimited ?? null,
    explorationUsed: t.explorationUsed ?? null,
  };
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function hhi(weights: number[]): number {
  const t = weights.reduce((a, b) => a + b, 0);
  if (t <= 0) return 0;
  return weights.reduce((acc, w) => acc + (w / t) ** 2, 0);
}

function topKeys(map: Map<string, number>, k: number): { key: string; count: number }[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([key, count]) => ({ key, count }));
}

const FAMILY_LABEL: Record<RuleFamily, string> = {
  daily_new_trades_cap: "Daily new trades cap (`budget_cap`, `maxNewTradesToday` / `maxDailyNewTrades`)",
  max_open_total_combined:
    "`max_open_total` in traces = global max-open **or** relaxed concentration sub-caps (same code); use tick `relaxedConcentrationRejectedByCap` to size the latter",
  per_market_open_cap: "Per-market open cap (`max_open_per_market`)",
  per_theme_open_cap: "Per-theme open cap (`max_open_per_theme`)",
  per_category_open_cap: "Per-category open cap (`max_open_per_category`)",
  other_risk_limit: "Other / unmapped",
};

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const state = await prisma.paperTradingState.findUnique({ where: { id: STATE_ID } });
  let tick: Record<string, unknown> | null = null;
  if (state?.lastOpenTickResultJson) {
    try {
      tick = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
    } catch {
      tick = null;
    }
  }

  if (!tick) {
    const empty = {
      generatedAt: new Date().toISOString(),
      error: "No lastOpenTickResultJson found. Run paper open tick first.",
    };
    await fs.writeFile(JSON_PATH, JSON.stringify(empty, null, 2), "utf8");
    await fs.writeFile(
      MD_PATH,
      "# Paper risk limit breakdown\n\nNo last tick result found.\n",
      "utf8"
    );
    console.log("total risk rejections (tick): —");
    console.log("top 3 rules: —");
    console.log("suggested tuning: run paper tick and re-run this report.");
    return;
  }

  const bundle = tick.decisionTraceBundle as Record<string, unknown> | undefined;
  const tracesRaw = Array.isArray(bundle?.traces) ? (bundle!.traces as Record<string, unknown>[]) : [];
  const loadDiag = tick.loadDiagnostics as Record<string, unknown> | undefined;
  const relaxedConcRejectedByCap =
    typeof loadDiag?.relaxedConcentrationRejectedByCap === "number"
      ? loadDiag.relaxedConcentrationRejectedByCap
      : 0;

  const tickRejectedByRiskLimit =
    typeof tick.rejectedByRiskLimitCount === "number" ? tick.rejectedByRiskLimitCount : null;

  const thresholdEligible = tracesRaw.filter((t) => t.thresholdEligible === true);
  const teAdmitted = thresholdEligible.filter((t) => t.finalDisposition === "admitted");
  const teRejected = thresholdEligible.filter((t) => t.finalDisposition === "rejected");

  /** Post-threshold rejects whose `rejectReasonCode` is in the engine risk-limit set (includes all `max_open_total` rows). */
  const riskLimitTraceRows = teRejected.filter((t) => {
    const c = typeof t.rejectReasonCode === "string" ? t.rejectReasonCode : "";
    return ENGINE_RISK_LIMIT_CODES.has(c);
  });

  const totalForPct = riskLimitTraceRows.length;

  const byCode = new Map<string, number>();
  const examplesByCode = new Map<string, Record<string, unknown>[]>();
  for (const t of riskLimitTraceRows) {
    const code = typeof t.rejectReasonCode === "string" ? t.rejectReasonCode : "unknown";
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
    const arr = examplesByCode.get(code) ?? [];
    if (arr.length < EXAMPLES_PER_RULE) arr.push(compactExample(t));
    examplesByCode.set(code, arr);
  }

  const byFamily = new Map<RuleFamily, number>();
  const examplesByFamily = new Map<RuleFamily, Record<string, unknown>[]>();
  for (const t of riskLimitTraceRows) {
    const fam = familyForTrace(t);
    byFamily.set(fam, (byFamily.get(fam) ?? 0) + 1);
    const arr = examplesByFamily.get(fam) ?? [];
    if (arr.length < EXAMPLES_PER_RULE) arr.push(compactExample(t));
    examplesByFamily.set(fam, arr);
  }

  const perBotAggs = Array.isArray(bundle?.perBotAggregates)
    ? (bundle!.perBotAggregates as Record<string, unknown>[])
    : [];
  let sumRejectedByBudget = 0;
  let sumRejectedByCaps = 0;
  for (const a of perBotAggs) {
    if (typeof a.rejectedByBudget === "number") sumRejectedByBudget += a.rejectedByBudget;
    if (typeof a.rejectedByCaps === "number") sumRejectedByCaps += a.rejectedByCaps;
  }

  const openTrades = await prisma.paperTrade.findMany({
    where: { status: "open" },
    select: {
      botType: true,
      theme: true,
      category: true,
      intendedSize: true,
      entryPrice: true,
      marketId: true,
      paperRelaxationReason: true,
    },
  });

  const byBot = new Map<string, number>();
  const byTheme = new Map<string, number>();
  const byCategory = new Map<string, number>();
  let notionalSum = 0;
  for (const row of openTrades) {
    byBot.set(row.botType, (byBot.get(row.botType) ?? 0) + 1);
    const tk = row.theme ?? "__none__";
    const ck = row.category ?? "__none__";
    byTheme.set(tk, (byTheme.get(tk) ?? 0) + 1);
    byCategory.set(ck, (byCategory.get(ck) ?? 0) + 1);
    const sz = parseFloat(row.intendedSize);
    const px = parseFloat(row.entryPrice);
    if (Number.isFinite(sz) && Number.isFinite(px)) notionalSum += sz * px;
  }

  const themeHhi = hhi([...byTheme.values()]);
  const categoryHhi = hhi([...byCategory.values()]);
  const maxThemeShare =
    openTrades.length > 0 ? Math.max(...[...byTheme.values()]) / openTrades.length : 0;

  function scoresOf(rows: Record<string, unknown>[]): number[] {
    return rows
      .map((r) => r.admissionScore)
      .filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  }

  const admittedScores = scoresOf(teAdmitted);
  const riskRejectedScores = scoresOf(riskLimitTraceRows);

  const themeDist = (rows: Record<string, unknown>[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = typeof r.theme === "string" && r.theme ? r.theme : "__none__";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return topKeys(m, 5);
  };

  const comparePassedVsBlocked = {
    thresholdEligibleAdmitted: teAdmitted.length,
    thresholdEligibleRejectedRiskLimits: riskLimitTraceRows.length,
    admissionScore: {
      admitted: { mean: mean(admittedScores), median: median(admittedScores), n: admittedScores.length },
      riskRejected: {
        mean: mean(riskRejectedScores),
        median: median(riskRejectedScores),
        n: riskRejectedScores.length,
      },
    },
    topThemesAdmitted: themeDist(teAdmitted),
    topThemesRiskRejected: themeDist(riskLimitTraceRows),
    explorationUsedRate: {
      admitted: pct(
        teAdmitted.filter((t) => t.explorationUsed === true).length,
        teAdmitted.length
      ),
      riskRejected: pct(
        riskLimitTraceRows.filter((t) => t.explorationUsed === true).length,
        riskLimitTraceRows.length
      ),
    },
    concentrationHighCandidateRate: {
      admitted: pct(
        teAdmitted.filter((t) => t.paperRelaxationReason === "concentration_high").length,
        teAdmitted.length
      ),
      riskRejected: pct(
        riskLimitTraceRows.filter((t) => t.paperRelaxationReason === "concentration_high").length,
        riskLimitTraceRows.length
      ),
    },
  };

  const byCodeSorted = [...byCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({
      code,
      count,
      pctOfTraceRiskRejects: pct(count, totalForPct),
      examples: examplesByCode.get(code) ?? [],
    }));

  const byFamilySorted = ([...byFamily.entries()] as [RuleFamily, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([family, count]) => ({
      family,
      label: FAMILY_LABEL[family],
      count,
      pctOfTraceRiskRejects: pct(count, totalForPct),
      examples: examplesByFamily.get(family) ?? [],
    }));

  const engineNote = {
    rejectedByRiskLimitCount_incrementsFor: [
      "budget_cap",
      "max_open_total (global cap only)",
      "max_open_per_market",
      "max_open_per_theme",
      "max_open_per_category",
    ],
    max_open_totalAlsoUsedFor:
      "Relaxed concentration sub-caps (tick `loadDiagnostics.relaxedConcentrationRejectedByCap`); those rejects are NOT added to `rejectedByRiskLimitCount`.",
    traceCaveat:
      "Stored traces are capped (see `decisionTraceBundle.maxTracesStored`); counts below are from the retained slice only, not full tick cardinality.",
  };

  const taxonomyNote = {
    portfolio_concentration:
      "Relaxed concentration stake caps use `rejectReasonCode: max_open_total` but do **not** increment `rejectedByRiskLimitCount`; see `tickSummary.relaxedConcentrationRejectedByCap` and `maxOpenTotalDeepDive`.",
    per_market_limits: "`max_open_per_market`",
    per_theme_limits: "`max_open_per_theme`",
    per_category_limits: "`max_open_per_category`",
    exposure_caps:
      "`max_open_total` (global max open per bot path) plus open-portfolio HHI / theme share below. Same trace code as relaxed concentration caps — split using tick diagnostics.",
    sizing_constraints:
      "No post-score reject code for score-based sizing; `paperSizeByScore` only scales `intendedSize` after passing gates. Not in `rejectedByRiskLimitCount`.",
    behavior_penalties:
      "Not in this risk-limit code set; staged policy / behavior blocks surface as other `rejectReasonCode` values outside `ENGINE_RISK_LIMIT_CODES`.",
  };

  const maxOpenTotalTraceCount = byCode.get("max_open_total") ?? 0;
  const maxOpenTotalConcentrationExamples = riskLimitTraceRows
    .filter(
      (t) =>
        t.rejectReasonCode === "max_open_total" && t.paperRelaxationReason === "concentration_high"
    )
    .slice(0, EXAMPLES_PER_RULE)
    .map(compactExample);

  const maxOpenTotalDeepDive = {
    traceRowsWithCodeMaxOpenTotal: maxOpenTotalTraceCount,
    tickRelaxedConcentrationRejectedByCap: relaxedConcRejectedByCap,
    note:
      "`concentration_high` candidates can still hit the **global** `max_open_total` first; rows below are only illustrative of concentration-relaxed candidates that reached the later sub-cap check.",
    illustrativeConcentrationHighExamples: maxOpenTotalConcentrationExamples,
  };

  const top3Codes = [...byCodeSorted].slice(0, 3);

  const report = {
    generatedAt: new Date().toISOString(),
    lastOpenTickAt: state?.lastOpenTickAt?.toISOString() ?? null,
    engineNote,
    taxonomyNote,
    tickSummary: {
      rejectedByRiskLimitCount: tickRejectedByRiskLimit,
      relaxedConcentrationRejectedByCap: relaxedConcRejectedByCap,
      perBotAggregatesSum: {
        rejectedByBudget: sumRejectedByBudget,
        rejectedByCaps: sumRejectedByCaps,
        note:
          "`rejectedByCaps` includes `max_open_total` from relaxed concentration; it can exceed the tick `rejectedByRiskLimitCount` component attributable to caps-only.",
      },
      traceBundleMeta: bundle
        ? {
            maxTracesStored: bundle.maxTracesStored ?? null,
            totalCandidatesConsidered: bundle.totalCandidatesConsidered ?? null,
          }
        : null,
    },
    traceWindow: {
      thresholdEligibleCount: thresholdEligible.length,
      riskLimitRejectTraceRows: riskLimitTraceRows.length,
      note:
        "Tick `rejectedByRiskLimitCount` excludes relaxed-concentration `max_open_total` rejects (`loadDiagnostics.relaxedConcentrationRejectedByCap`) but those rows still appear in traces with the same code. Trace rows are also capped at `maxTracesStored`.",
    },
    byRejectReasonCode: byCodeSorted,
    byRuleFamily: byFamilySorted,
    comparePassedVsBlocked,
    maxOpenTotalDeepDive,
    portfolioSnapshot: {
      openTradeCount: openTrades.length,
      openTradesByBot: topKeys(byBot, 50),
      topThemes: topKeys(byTheme, 15),
      topCategories: topKeys(byCategory, 15),
      estimatedNotionalOpen: Math.round(notionalSum * 100) / 100,
      concentration: {
        themeHHI: Math.round(themeHhi * 10000) / 10000,
        categoryHHI: Math.round(categoryHhi * 10000) / 10000,
        maxSingleThemeShare: Math.round(maxThemeShare * 10000) / 10000,
      },
    },
    top3ConstraintsLimitingThroughput: top3Codes.map((x, i) => ({
      rank: i + 1,
      rejectReasonCode: x.code,
      traceCount: x.count,
      pctOfTraceRiskRejects: x.pctOfTraceRiskRejects,
      mappedFamily: familyForTrace({ rejectReasonCode: x.code }),
      familyLabel: FAMILY_LABEL[familyForTrace({ rejectReasonCode: x.code })],
    })),
  };

  await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper risk limit breakdown");
  md.push("");
  md.push(`Generated: \`${report.generatedAt}\``);
  md.push(`Last open tick: \`${report.lastOpenTickAt ?? "—"}\``);
  md.push("");
  md.push("## Tick counters");
  md.push("");
  md.push(`| Field | Value |`);
  md.push(`|-------|-------|`);
  md.push(`| rejectedByRiskLimitCount | ${tickRejectedByRiskLimit ?? "—"} |`);
  md.push(`| relaxedConcentrationRejectedByCap (not in rejectedByRiskLimitCount) | ${relaxedConcRejectedByCap} |`);
  md.push(`| Σ perBot rejectedByBudget | ${sumRejectedByBudget} |`);
  md.push(`| Σ perBot rejectedByCaps | ${sumRejectedByCaps} |`);
  md.push("");
  md.push("## Trace window (capped)");
  md.push("");
  md.push(`- Threshold-eligible traces: **${thresholdEligible.length}**`);
  md.push(`- Risk-limit trace rows (\`rejectReasonCode\` in engine risk set): **${riskLimitTraceRows.length}**`);
  md.push("");
  md.push("## By reject reason code");
  md.push("");
  md.push("| Code | Count | % of trace risk-related |");
  md.push("|------|------:|------------------------:|");
  for (const row of byCodeSorted) {
    md.push(`| \`${row.code}\` | ${row.count} | ${row.pctOfTraceRiskRejects.toFixed(1)}% |`);
  }
  md.push("");
  md.push("## By rule family (condensed taxonomy)");
  md.push("");
  md.push("| Family | Count | % | Examples (up to 5) |");
  md.push("|--------|------:|--:|------------------|");
  for (const row of byFamilySorted) {
    md.push(
      `| ${row.family} | ${row.count} | ${row.pctOfTraceRiskRejects.toFixed(1)}% | ${row.examples.length} rows in JSON |`
    );
  }
  md.push("");
  md.push("### Family definitions");
  md.push("");
  for (const f of byFamilySorted) {
    md.push(`- **${f.family}**: ${f.label}`);
  }
  md.push("");
  md.push("## Portfolio snapshot (open trades)");
  md.push("");
  md.push(`- Open trades: **${openTrades.length}**`);
  md.push(`- Estimated notional (Σ size×price): **${report.portfolioSnapshot.estimatedNotionalOpen}**`);
  md.push(`- Theme HHI: **${report.portfolioSnapshot.concentration.themeHHI}** · Category HHI: **${report.portfolioSnapshot.concentration.categoryHHI}**`);
  md.push("");
  md.push("### By bot");
  md.push("");
  md.push("| botType | open |");
  md.push("|---------|-----:|");
  for (const x of report.portfolioSnapshot.openTradesByBot) {
    md.push(`| \`${x.key}\` | ${x.count} |`);
  }
  md.push("");
  md.push("### Largest themes");
  md.push("");
  for (const x of report.portfolioSnapshot.topThemes.slice(0, 10)) {
    md.push(`- \`${x.key}\`: ${x.count}`);
  }
  md.push("");
  md.push("## Passed vs blocked (threshold-eligible)");
  md.push("");
  md.push("| Metric | Admitted | Risk-limit rejects |");
  md.push("|--------|----------|--------------------|");
  md.push(
    `| n | ${comparePassedVsBlocked.thresholdEligibleAdmitted} | ${comparePassedVsBlocked.thresholdEligibleRejectedRiskLimits} |`
  );
  md.push(
    `| admissionScore mean | ${comparePassedVsBlocked.admissionScore.admitted.mean?.toFixed(4) ?? "—"} | ${comparePassedVsBlocked.admissionScore.riskRejected.mean?.toFixed(4) ?? "—"} |`
  );
  md.push(
    `| admissionScore median | ${comparePassedVsBlocked.admissionScore.admitted.median?.toFixed(4) ?? "—"} | ${comparePassedVsBlocked.admissionScore.riskRejected.median?.toFixed(4) ?? "—"} |`
  );
  md.push(
    `| explorationUsed % | ${comparePassedVsBlocked.explorationUsedRate.admitted.toFixed(1)}% | ${comparePassedVsBlocked.explorationUsedRate.riskRejected.toFixed(1)}% |`
  );
  md.push(
    `| concentration_high % | ${comparePassedVsBlocked.concentrationHighCandidateRate.admitted.toFixed(1)}% | ${comparePassedVsBlocked.concentrationHighCandidateRate.riskRejected.toFixed(1)}% |`
  );
  md.push("");
  md.push("## `max_open_total` deep dive (portfolio vs concentration)");
  md.push("");
  md.push(`- Trace rows with \`max_open_total\`: **${maxOpenTotalDeepDive.traceRowsWithCodeMaxOpenTotal}**`);
  md.push(`- Tick \`relaxedConcentrationRejectedByCap\` (not in \`rejectedByRiskLimitCount\`): **${maxOpenTotalDeepDive.tickRelaxedConcentrationRejectedByCap}**`);
  md.push(`- ${maxOpenTotalDeepDive.note}`);
  md.push("");
  md.push("## Top 3 constraints limiting trade throughput right now");
  md.push("");
  for (const t of report.top3ConstraintsLimitingThroughput) {
    md.push(
      `${t.rank}. **\`${t.rejectReasonCode}\`** — ${t.traceCount} hits (${t.pctOfTraceRiskRejects.toFixed(1)}% of risk-related trace rows). ${t.familyLabel}`
    );
  }
  if (relaxedConcRejectedByCap > 0 && !top3Codes.some((c) => c.code === "max_open_total")) {
    md.push(
      `- Note: \`relaxedConcentrationRejectedByCap=${relaxedConcRejectedByCap}\` — concentration sub-caps reuse \`max_open_total\`; if absent from top-3 codes, traces may be truncated or dominated by other caps.`
    );
  }
  md.push("");
  md.push("Full per-code / per-family examples: see `dump/paper-risk-limit-breakdown.json`.");
  md.push("");

  await fs.writeFile(MD_PATH, md.join("\n"), "utf8");

  // --- Terminal summary ---
  const totalRisk = tickRejectedByRiskLimit ?? riskLimitTraceRows.length;
  console.log(`total risk rejections (tick rejectedByRiskLimitCount): ${totalRisk}`);
  const top3Line = top3Codes.map((x) => `${x.code}(${x.count})`).join(", ");
  console.log(`top 3 rules (by rejectReasonCode in trace window): ${top3Line || "—"}`);

  const top = top3Codes[0]?.code;
  let tuning =
    "Inspect JSON examples for dominant `rejectReasonCode`; raise the matching cap only if aligned with risk policy.";
  if (top === "budget_cap") {
    tuning =
      "Dominant: `budget_cap` — raise `maxDailyNewTrades` or allocator `maxNewTradesToday`, or fix daily-cap overflow path.";
  } else if (top === "max_open_per_theme") {
    tuning = "Dominant: per-theme cap — widen `maxOpenPerTheme` or diversify candidates away from saturated themes.";
  } else if (top === "max_open_per_market") {
    tuning = "Dominant: per-market cap — widen `maxOpenPerMarket` or reduce duplicate markets in the pool.";
  } else if (top === "max_open_per_category") {
    tuning = "Dominant: per-category cap — widen `maxOpenPerCategory`.";
  } else if (top === "max_open_total") {
    tuning =
      "Dominant: `max_open_total` — split global max-open vs relaxed concentration using tick `relaxedConcentrationRejectedByCap`; tune the matching knob (`maxOpenTotal` vs relaxed concentration sub-caps).";
  }
  console.log(`suggested tuning: ${tuning}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
