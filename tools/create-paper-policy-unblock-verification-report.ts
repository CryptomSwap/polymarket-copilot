/**
 * Paper policy unblock verification report.
 *
 * Writes:
 * - dump/paper-policy-unblock-verification-report.json
 * - dump/paper-policy-unblock-verification-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getPaperTradingCandidatesWithDiagnostics } from "../lib/paper-trading/candidates";
import { getFunderForDecisionRecompute } from "../lib/decision/recompute";
import {
  deriveAutomationBehaviorPenaltyFromRows,
  deriveBehaviorPenaltyFromRows,
  scopeCountsTowardAutomationBehaviorPenalty,
} from "../lib/polymarket/behavior-flags";

const LOOKBACK_DAYS = 30;
const TAKE = 10;

async function main(): Promise<void> {
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });

  const funder =
    (await getFunderForDecisionRecompute()) ??
    (await prisma.marketSignal.findFirst({ select: { funderAddress: true } }).then((r) => r?.funderAddress ?? ""))
      .toLowerCase()
      .trim();

  const { loadDiagnostics } = await getPaperTradingCandidatesWithDiagnostics(funder || "paper");

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const flagsInLookback = await prisma.behaviorFlag.findMany({
    where: { funderAddress: funder, createdAt: { gte: cutoff } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const last10Any = flagsInLookback.slice(0, TAKE);
  const automationRelevant = flagsInLookback.filter((f) =>
    scopeCountsTowardAutomationBehaviorPenalty(f.sourceScope)
  );
  const last10Automation = automationRelevant.slice(0, TAKE);
  const behaviorPenaltyLegacySim = deriveBehaviorPenaltyFromRows(last10Any);
  const behaviorPenaltyAutomationScoped = deriveAutomationBehaviorPenaltyFromRows(last10Automation);

  const samples = loadDiagnostics.sampleFilteredByPolicy ?? [];
  const behaviorBlockSamples = samples.filter((row) =>
    row.reason?.includes("Behavior flags suggest pausing new trades.")
  );
  const portfolioBlockSamples = samples.filter(
    (row) =>
      row.reason?.includes("High concentration") ||
      row.reason?.includes("Portfolio overconcentrated") ||
      row.reason?.includes("theme exposure") ||
      row.reason?.includes("Portfolio fit")
  );

  const primaryBlockGuess =
    behaviorBlockSamples.length > 0 && behaviorPenaltyAutomationScoped >= 0.25
      ? "behavior_flags_automation"
      : behaviorBlockSamples.length > 0 && behaviorPenaltyAutomationScoped < 0.25
        ? "behavior_string_stale_recompute_signals"
        : portfolioBlockSamples.length > 0
          ? "portfolio_fit_or_concentration"
          : loadDiagnostics.afterPolicyFilter === 0
            ? "see_zeroCandidatesReason"
            : "none_sampled";

  const result = {
    generatedAt: new Date().toISOString(),
    funderAddress: funder,
    loader: loadDiagnostics,
    behaviorPenalty: {
      legacyLast10Any: behaviorPenaltyLegacySim,
      automationScopedLast10: behaviorPenaltyAutomationScoped,
      note: "Live signal generation uses automationScoped. Old recommendations need recommendations recompute + decision snapshot backfill.",
    },
    sampleBlockAnalysis: {
      behaviorFlagsMessageSamples: behaviorBlockSamples.length,
      portfolioRelatedSamples: portfolioBlockSamples.length,
      primaryBlockGuess,
    },
  };

  const jsonPath = path.join(dumpDir, "paper-policy-unblock-verification-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const lines: string[] = [];
  lines.push("# Paper policy unblock verification report");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push("| Funder | " + funder + " |");
  lines.push("| recommendationsFound | " + loadDiagnostics.recommendationsFound + " |");
  lines.push("| noDecisionSnapshot | " + loadDiagnostics.noDecisionSnapshot + " |");
  lines.push("| afterPolicyFilter | " + loadDiagnostics.afterPolicyFilter + " |");
  lines.push("| zeroCandidatesReason | " + (loadDiagnostics.zeroCandidatesReason || "—") + " |");
  lines.push("| behaviorPenalty (automation-scoped) | " + behaviorPenaltyAutomationScoped + " |");
  lines.push("| behaviorPenalty legacy sim | " + behaviorPenaltyLegacySim + " |");
  lines.push("| Sample: behavior-flags block text | " + behaviorBlockSamples.length + " |");
  lines.push("| Sample: portfolio/concentration | " + portfolioBlockSamples.length + " |");
  lines.push("| **primaryBlockGuess** | " + primaryBlockGuess + " |");
  lines.push("");
  lines.push("## policyStateCounts");
  lines.push("");
  lines.push("```");
  lines.push(JSON.stringify(loadDiagnostics.policyStateCounts ?? {}, null, 2));
  lines.push("```");
  lines.push("");
  if (samples.length > 0) {
    lines.push("## sampleFilteredByPolicy");
    lines.push("");
    lines.push("| recommendationId | policyState | finalSuggestedSize | reason |");
    lines.push("|------------------|-------------|--------------------|--------|");
    for (const row of samples.slice(0, 20)) {
      lines.push(
        "| " +
          (row.recommendationId?.slice(0, 12) ?? "") +
          "… | " +
          row.policyState +
          " | " +
          row.finalSuggestedSize +
          " | " +
          (row.reason ?? "").slice(0, 100) +
          " |"
      );
    }
  }
  lines.push("");
  lines.push("## Next steps");
  lines.push("");
  lines.push("1. `npx prisma migrate deploy` (sourceScope column)");
  lines.push("2. `npm run backfill:behavior-flag-sources -- --apply` (optional audit labels)");
  lines.push("3. Re-run portfolio recompute + recommendation/signal pipeline so `MarketSignal.behaviorPenalty` refreshes");
  lines.push("4. `npm run backfill:decision-policy-snapshots` if that script exists in your branch");

  const mdPath = path.join(dumpDir, "paper-policy-unblock-verification-report.md");
  await fs.writeFile(mdPath, lines.join("\n"), "utf8");
  console.log("Wrote", mdPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
