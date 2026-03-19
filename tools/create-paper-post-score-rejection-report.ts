/**
 * Paper post-score rejection report.
 * Focus: candidates that already passed score threshold but were rejected before PaperTrade insert.
 *
 * Writes:
 * - dump/paper-post-score-rejection-report.json
 * - dump/paper-post-score-rejection-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const STATE_ID = "default";
const SAMPLE_LIMIT = 30;

type RejectionBucket =
  | "working_orders_breach"
  | "cooldown"
  | "dedupe"
  | "zero_size"
  | "exposure"
  | "execution_policy"
  | "budget_cap"
  | "threshold_or_exploration"
  | "other";

function bucketFromRejectCode(code: string): RejectionBucket {
  if (code === "budget_cap") return "budget_cap";
  if (code === "cooldown_asset" || code === "cooldown_market") return "cooldown";
  if (code === "dedupe") return "dedupe";
  if (
    code === "max_open_total" ||
    code === "max_open_per_market" ||
    code === "max_open_per_theme" ||
    code === "max_open_per_category"
  ) {
    return "exposure";
  }
  if (code === "below_threshold" || code === "outside_exploration_band" || code === "exploration_cap_tick" || code === "exploration_cap_day") {
    return "threshold_or_exploration";
  }
  return "other";
}

function pct(n: number, d: number): number {
  if (d <= 0) return 0;
  return (n / d) * 100;
}

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
      error: "No lastOpenTickResultJson found. Run paper tick first.",
    };
    await fs.writeFile(
      path.join(DUMP_DIR, "paper-post-score-rejection-report.json"),
      JSON.stringify(empty, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(DUMP_DIR, "paper-post-score-rejection-report.md"),
      "# Paper post-score rejection report\n\nNo last tick result found.\n",
      "utf8"
    );
    return;
  }

  const tracesRaw = ((tick.decisionTraceBundle as Record<string, unknown> | undefined)?.traces ??
    []) as Array<Record<string, unknown>>;
  const thresholdEligibleTraces = tracesRaw.filter((t) => t.thresholdEligible === true);
  const rejectedPostScore = thresholdEligibleTraces.filter(
    (t) => t.finalDisposition === "rejected"
  );
  const admittedPostScore = thresholdEligibleTraces.filter(
    (t) => t.finalDisposition === "admitted"
  );

  const byReasonCode = new Map<string, number>();
  const byBucket: Record<RejectionBucket, number> = {
    working_orders_breach: 0,
    cooldown: 0,
    dedupe: 0,
    zero_size: 0,
    exposure: 0,
    execution_policy: 0,
    budget_cap: 0,
    threshold_or_exploration: 0,
    other: 0,
  };

  for (const t of rejectedPostScore) {
    const code = typeof t.rejectReasonCode === "string" ? t.rejectReasonCode : "unknown";
    byReasonCode.set(code, (byReasonCode.get(code) ?? 0) + 1);
    byBucket[bucketFromRejectCode(code)]++;
  }

  const perBotResults = (tick.perBotResults as Record<string, Record<string, unknown>> | undefined) ?? {};
  const perBot = Object.entries(perBotResults).map(([botType, x]) => ({
    botType,
    opened: typeof x.opened === "number" ? x.opened : 0,
    skipped: typeof x.skipped === "number" ? x.skipped : 0,
    candidatesLoaded: typeof x.candidatesLoaded === "number" ? x.candidatesLoaded : 0,
    candidatesScored: typeof x.candidatesScored === "number" ? x.candidatesScored : 0,
    aboveThresholdCount: typeof x.aboveThresholdCount === "number" ? x.aboveThresholdCount : 0,
    rejectedByCooldownCount: typeof x.rejectedByCooldownCount === "number" ? x.rejectedByCooldownCount : 0,
    rejectedByRiskLimitCount: typeof x.rejectedByRiskLimitCount === "number" ? x.rejectedByRiskLimitCount : 0,
    rejectedByBudgetCount: typeof x.rejectedByBudgetCount === "number" ? x.rejectedByBudgetCount : 0,
  }));

  const reasonCountsSorted = Array.from(byReasonCode.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({
      reason,
      count,
      pctOfRejectedPostScore: pct(count, rejectedPostScore.length),
    }));

  const bucketSorted = Object.entries(byBucket)
    .sort((a, b) => b[1] - a[1])
    .map(([bucket, count]) => ({
      bucket,
      count,
      pctOfRejectedPostScore: pct(count, rejectedPostScore.length),
    }));

  const samples = rejectedPostScore.slice(0, SAMPLE_LIMIT).map((t) => ({
    botType: t.botType ?? null,
    recommendationId: t.recommendationId ?? null,
    marketId: t.marketId ?? null,
    assetId: t.assetId ?? null,
    policyState: t.policyState ?? null,
    paperPolicyMode: t.paperPolicyMode ?? null,
    paperRelaxationReason: t.paperRelaxationReason ?? null,
    championScore: t.championScore ?? null,
    minScore: t.minScore ?? null,
    thresholdEligible: t.thresholdEligible ?? null,
    rejectReasonCode: t.rejectReasonCode ?? null,
    dedupeKey: t.dedupeKey ?? null,
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    lastOpenTickAt: state?.lastOpenTickAt?.toISOString() ?? null,
    tickSummary: {
      candidatesLoaded: tick.candidatesLoaded ?? null,
      candidatesScored: tick.candidatesScored ?? null,
      aboveThresholdCount: tick.aboveThresholdCount ?? null,
      opened: tick.opened ?? null,
      skipped: tick.skipped ?? null,
    },
    postScore: {
      tracesCount: tracesRaw.length,
      thresholdEligibleCount: thresholdEligibleTraces.length,
      admittedAfterScoreCount: admittedPostScore.length,
      rejectedAfterScoreCount: rejectedPostScore.length,
    },
    rejectionReasonCounts: reasonCountsSorted,
    rejectionBucketCounts: bucketSorted,
    perBot,
    sampleRejectedAfterScore: samples,
    mappedBucketsDefinition: {
      working_orders_breach: "No matching rejectReasonCode in current paper tick trace taxonomy; kept for compatibility.",
      cooldown: "cooldown_asset, cooldown_market",
      dedupe: "dedupe",
      zero_size: "Not emitted post-score in current engine path; pre-score zero-size filters happen in candidate loading.",
      exposure: "max_open_total, max_open_per_market, max_open_per_theme, max_open_per_category",
      execution_policy: "No explicit post-score rejectReasonCode currently emitted under this label.",
      budget_cap: "budget_cap",
      threshold_or_exploration: "below_threshold, outside_exploration_band, exploration_cap_tick, exploration_cap_day",
      other: "fallback/unknown codes",
    },
  };

  const jsonPath = path.join(DUMP_DIR, "paper-post-score-rejection-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const lines: string[] = [];
  lines.push("# Paper post-score rejection report");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| lastOpenTickAt | ${report.lastOpenTickAt ?? "—"} |`);
  lines.push(`| candidatesLoaded | ${report.tickSummary.candidatesLoaded ?? "—"} |`);
  lines.push(`| candidatesScored | ${report.tickSummary.candidatesScored ?? "—"} |`);
  lines.push(`| aboveThresholdCount | ${report.tickSummary.aboveThresholdCount ?? "—"} |`);
  lines.push(`| opened | ${report.tickSummary.opened ?? "—"} |`);
  lines.push(`| rejectedAfterScoreCount | ${report.postScore.rejectedAfterScoreCount} |`);
  lines.push("");
  lines.push("## Rejection reasons");
  lines.push("");
  lines.push("| reason | count | % of rejected-after-score |");
  lines.push("|--------|-------|---------------------------|");
  for (const r of reasonCountsSorted) {
    lines.push(`| ${r.reason} | ${r.count} | ${r.pctOfRejectedPostScore.toFixed(2)}% |`);
  }
  lines.push("");
  lines.push("## Rejection buckets");
  lines.push("");
  lines.push("| bucket | count | % of rejected-after-score |");
  lines.push("|--------|-------|---------------------------|");
  for (const b of bucketSorted) {
    lines.push(`| ${b.bucket} | ${b.count} | ${b.pctOfRejectedPostScore.toFixed(2)}% |`);
  }
  lines.push("");
  lines.push("## Sample rejected-after-score candidates");
  lines.push("");
  lines.push("| botType | recommendationId | championScore | minScore | rejectReasonCode |");
  lines.push("|---------|------------------|---------------|----------|------------------|");
  for (const s of samples.slice(0, 15)) {
    lines.push(
      `| ${s.botType ?? "—"} | ${s.recommendationId ?? "—"} | ${s.championScore ?? "—"} | ${s.minScore ?? "—"} | ${s.rejectReasonCode ?? "—"} |`
    );
  }

  const mdPath = path.join(DUMP_DIR, "paper-post-score-rejection-report.md");
  await fs.writeFile(mdPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

