/**
 * Behavior flags block debug report.
 * Shows legacy vs automation-scoped behaviorPenalty and flags by sourceScope.
 *
 * Writes:
 * - dump/behavior-flags-block-debug-report.json
 * - dump/behavior-flags-block-debug-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getFunderForDecisionRecompute } from "../lib/decision/recompute";
import {
  deriveAutomationBehaviorPenaltyFromRows,
  deriveBehaviorPenaltyFromRows,
  scopeCountsTowardAutomationBehaviorPenalty,
} from "../lib/polymarket/behavior-flags";

const LOOKBACK_DAYS = 30;
const MAX_SAMPLE = 50;
const TAKE = 10;

async function main(): Promise<void> {
  const dumpDir = path.join(process.cwd(), "dump");
  await fs.mkdir(dumpDir, { recursive: true });

  const funder =
    (await getFunderForDecisionRecompute()) ??
    (await prisma.marketSignal.findFirst({ select: { funderAddress: true } }).then((r) => r?.funderAddress ?? ""))
      .toLowerCase()
      .trim();

  const now = new Date();
  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

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

  const behaviorPenaltyLegacy = deriveBehaviorPenaltyFromRows(last10Any);
  const behaviorPenaltyAutomationScoped = deriveAutomationBehaviorPenaltyFromRows(last10Automation);

  const byScope: Record<string, number> = {};
  for (const f of flagsInLookback) {
    const k = f.sourceScope ?? "(null)";
    byScope[k] = (byScope[k] ?? 0) + 1;
  }

  const recs = await prisma.recommendation.findMany({
    where: {
      marketSignal: { funderAddress: funder },
      createdAt: { gte: cutoff },
    },
    select: { id: true, blockedReason: true, action: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const blockedByBehavior = recs.filter(
    (r) => r.blockedReason === "Behavior flags suggest pausing new trades."
  );

  const report = {
    generatedAt: now.toISOString(),
    funderAddress: funder,
    lookbackDays: LOOKBACK_DAYS,
    note: "signals.ts behaviorPenalty uses only automation+runtime flags (last 10 in window). Legacy sim = last 10 any flag.",
    behaviorFlags: {
      rowsInLookbackWindow: flagsInLookback.length,
      countsBySourceScope: byScope,
      flagsCountingTowardAutomationPenalty: automationRelevant.length,
      behaviorPenaltyLegacySimulation: behaviorPenaltyLegacy,
      behaviorPenaltyAutomationScoped: behaviorPenaltyAutomationScoped,
      manualFlagsExcludedFromAutomationPenalty: flagsInLookback.filter(
        (f) => f.sourceScope === "manual" || f.sourceScope === "portfolio"
      ).length,
      portfolioStateFlagsInWindow: flagsInLookback.filter((f) => f.sourceScope === "portfolio").length,
      sampleFlags: flagsInLookback.slice(0, MAX_SAMPLE).map((f) => ({
        id: f.id,
        severity: f.severity,
        type: f.type,
        sourceScope: f.sourceScope,
        countsTowardAutomationBehaviorPenalty: scopeCountsTowardAutomationBehaviorPenalty(f.sourceScope),
        createdAt: f.createdAt,
        description: f.description.slice(0, 120),
      })),
    },
    portfolioFitSeparate:
      "Concentration still blocks via evaluatePortfolioFit: topThemeConcentrationPct ≥ 50, portfolioPenalty ≥ 0.3, theme exposure — independent of BehaviorFlag rows.",
    recommendations: {
      totalRecent: recs.length,
      blockedByBehaviorString: blockedByBehavior.length,
      sampleBlockedByBehavior: blockedByBehavior.slice(0, MAX_SAMPLE),
    },
  };

  const jsonPath = path.join(dumpDir, "behavior-flags-block-debug-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const lines: string[] = [];
  lines.push("# Behavior flags block debug report");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push("| Funder | " + funder + " |");
  lines.push("| Lookback days | " + LOOKBACK_DAYS + " |");
  lines.push("| Flags in window | " + flagsInLookback.length + " |");
  lines.push("| Legacy penalty (last 10 any) | " + behaviorPenaltyLegacy + " |");
  lines.push("| **Automation-scoped penalty** (last 10 automation/runtime) | **" + behaviorPenaltyAutomationScoped + "** |");
  lines.push("| Flags matching automation/runtime in window | " + automationRelevant.length + " |");
  lines.push("| Manual+portfolio flags (excluded from automation penalty) | " + report.behaviorFlags.manualFlagsExcludedFromAutomationPenalty + " |");
  lines.push("| Recent recommendations | " + recs.length + " |");
  lines.push("| BLOCK: Behavior flags suggest pausing… (stale until signal recompute) | " + blockedByBehavior.length + " |");
  lines.push("");
  lines.push("## Counts by sourceScope (window)");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(byScope, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Portfolio / concentration");
  lines.push("");
  lines.push(report.portfolioFitSeparate);
  lines.push("");
  lines.push("## Sample flags");
  lines.push("");
  lines.push("| scope | severity | type | automation penalty? | description |");
  lines.push("|-------|----------|------|---------------------|-------------|");
  for (const f of flagsInLookback.slice(0, 15)) {
    lines.push(
      "| " +
        (f.sourceScope ?? "null") +
        " | " +
        f.severity +
        " | " +
        f.type +
        " | " +
        (scopeCountsTowardAutomationBehaviorPenalty(f.sourceScope) ? "yes" : "no") +
        " | " +
        f.description.slice(0, 60).replace(/\|/g, " ") +
        " |"
    );
  }

  const mdPath = path.join(dumpDir, "behavior-flags-block-debug-report.md");
  await fs.writeFile(mdPath, lines.join("\n"), "utf8");
  console.log("Wrote", mdPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
