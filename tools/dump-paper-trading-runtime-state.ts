/**
 * Dump paper trading runtime state to audit-dumps/PAPER_TRADING_RUNTIME_STATE.md.
 * Uses same logic as /api/paper-trading/diagnostics and /api/decision/block-report.
 * Run from project root: npx tsx tools/dump-paper-trading-runtime-state.ts
 */

import * as fs from "fs";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { getFunderForDecisionRecompute } from "../lib/decision/recompute";
import { getPaperTradingCandidatesWithDiagnostics } from "../lib/paper-trading/candidates";
import { buildBlockReport } from "../lib/decision/block-report";

const OUT_PATH = path.join(process.cwd(), "audit-dumps", "PAPER_TRADING_RUNTIME_STATE.md");

function escapeMd(s: unknown): string {
  if (s === null || s === undefined) return "—";
  const t = typeof s;
  if (t === "object") return JSON.stringify(s);
  return String(s);
}

async function main(): Promise<void> {
  const lines: string[] = [];
  const now = new Date().toISOString();
  lines.push("# Paper Trading Runtime State");
  lines.push("");
  lines.push("**Generated:** " + now);
  lines.push("");

  try {
    const config = getPaperTradingConfig();
    const active = await getActiveOrApprovedShadowModel();
    const state = await prisma.paperTradingState.findUnique({ where: { id: "default" } });

    lines.push("## Config & model");
    lines.push("");
    lines.push("| Item | Value |");
    lines.push("|------|-------|");
    lines.push("| Paper trading enabled | " + escapeMd(config.enabled) + " |");
    lines.push("| Active threshold | " + escapeMd(config.threshold) + " |");
    lines.push("| Active modelRunId | " + escapeMd(active?.run.id) + " |");
    lines.push("| Active target label | " + escapeMd(active?.run.targetLabel) + " |");
    lines.push("");

    lines.push("## Last open tick");
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("|-------|-------|");
    lines.push("| lastOpenTickAt | " + escapeMd(state?.lastOpenTickAt?.toISOString()) + " |");
    lines.push("| lastOpenTickError | " + escapeMd(state?.lastOpenTickError) + " |");
    if (state?.lastOpenTickResultJson) {
      try {
        const r = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
        lines.push("| opened | " + escapeMd(r.opened) + " |");
        lines.push("| skipped | " + escapeMd(r.skipped) + " |");
        lines.push("| candidatesLoaded | " + escapeMd(r.candidatesLoaded) + " |");
        lines.push("| candidatesScored | " + escapeMd(r.candidatesScored) + " |");
        lines.push("| maxScore | " + escapeMd(r.maxScore) + " |");
        lines.push("| aboveThresholdCount | " + escapeMd(r.aboveThresholdCount) + " |");
      } catch {
        lines.push("| (result) | (parse error) |");
      }
    }
    lines.push("");

    lines.push("## Last close tick");
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("|-------|-------|");
    lines.push("| lastCloseTickAt | " + escapeMd(state?.lastCloseTickAt?.toISOString()) + " |");
    lines.push("| lastCloseTickError | " + escapeMd(state?.lastCloseTickError) + " |");
    if (state?.lastCloseTickResultJson) {
      try {
        const r = JSON.parse(state.lastCloseTickResultJson) as Record<string, unknown>;
        lines.push("| closed | " + escapeMd(r.closed) + " |");
        lines.push("| errors | " + escapeMd(Array.isArray(r.errors) ? r.errors.length : r.errors) + " |");
      } catch {
        lines.push("| (result) | (parse error) |");
      }
    }
    lines.push("");

    const funder = await getFunderForDecisionRecompute();
    const { loadDiagnostics } = await getPaperTradingCandidatesWithDiagnostics(funder ?? "paper");
    const blockReport = await buildBlockReport(funder ?? undefined);

    lines.push("## Candidate loading diagnostics (current)");
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("|-------|-------|");
    lines.push("| recommendationsFound | " + escapeMd(loadDiagnostics.recommendationsFound) + " |");
    lines.push("| noDecisionSnapshot | " + escapeMd(loadDiagnostics.noDecisionSnapshot) + " |");
    lines.push("| afterPolicyFilter | " + escapeMd(loadDiagnostics.afterPolicyFilter) + " |");
    lines.push("| noAssetResolve | " + escapeMd(loadDiagnostics.noAssetResolve) + " |");
    lines.push("| zeroSizeBuy | " + escapeMd(loadDiagnostics.zeroSizeBuy) + " |");
    lines.push("| policyStateCounts | " + escapeMd(loadDiagnostics.policyStateCounts) + " |");
    lines.push("| filteredByPolicyStateCount | " + escapeMd(loadDiagnostics.filteredByPolicyStateCount) + " |");
    lines.push("| avoidedCount | " + escapeMd(loadDiagnostics.avoidedCount) + " |");
    lines.push("| allowedCount | " + escapeMd(loadDiagnostics.allowedCount) + " |");
    lines.push("| zeroSizeAfterPolicyCount | " + escapeMd(loadDiagnostics.zeroSizeAfterPolicyCount) + " |");
    lines.push("| zeroCandidatesReason | " + escapeMd(loadDiagnostics.zeroCandidatesReason) + " |");
    lines.push("| relaxedBlockedCount | " + escapeMd(loadDiagnostics.relaxedBlockedCount) + " |");
    lines.push("| candidatesPassedViaRelaxation | " + escapeMd(loadDiagnostics.candidatesPassedViaRelaxation) + " |");
    lines.push("");

    if (loadDiagnostics.sampleFilteredByPolicy && loadDiagnostics.sampleFilteredByPolicy.length > 0) {
      lines.push("### sampleFilteredByPolicy");
      lines.push("");
      lines.push("| recommendationId | policyState | finalSuggestedSize | reason |");
      lines.push("|------------------|-------------|--------------------|--------|");
      for (const row of loadDiagnostics.sampleFilteredByPolicy) {
        lines.push("| " + escapeMd(row.recommendationId?.slice(0, 12) + "…") + " | " + escapeMd(row.policyState) + " | " + escapeMd(row.finalSuggestedSize) + " | " + escapeMd(row.reason) + " |");
      }
      lines.push("");
    }

    lines.push("## Block report summary");
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("|-------|-------|");
    lines.push("| funderAddress | " + escapeMd(funder) + " |");
    lines.push("| totalSnapshots | " + escapeMd(blockReport.totalSnapshots) + " |");
    lines.push("| byPolicyState | " + escapeMd(JSON.stringify(blockReport.byPolicyState)) + " |");
    lines.push("| byBlockReason | " + escapeMd(JSON.stringify(blockReport.byBlockReason)) + " |");
    lines.push("| byCategory | " + escapeMd(JSON.stringify(blockReport.byCategory)) + " |");
    lines.push("| liquidityRelatedCount | " + escapeMd(blockReport.liquidityRelatedCount) + " |");
    lines.push("| riskRelatedCount | " + escapeMd(blockReport.riskRelatedCount) + " |");
    lines.push("| portfolioThemeConcentrationCount | " + escapeMd(blockReport.portfolioThemeConcentrationCount) + " |");
    lines.push("| missingOrQualityCount | " + escapeMd(blockReport.missingOrQualityCount) + " |");
    lines.push("");

    if (blockReport.sampleBlocked.length > 0) {
      lines.push("### sampleBlocked (first 5)");
      lines.push("");
      lines.push("| recommendationId | policyState | blockReason | category |");
      lines.push("|------------------|-------------|-------------|----------|");
      for (const row of blockReport.sampleBlocked.slice(0, 5)) {
        lines.push("| " + escapeMd(row.recommendationId?.slice(0, 12) + "…") + " | " + escapeMd(row.policyState) + " | " + escapeMd(row.blockReason) + " | " + escapeMd(row.category) + " |");
      }
      lines.push("");
    }

    const zeroReason = loadDiagnostics.zeroCandidatesReason || (loadDiagnostics.afterPolicyFilter === 0 ? "all filtered by policy (BLOCK or avoid)" : "—");
    lines.push("## Current reason no paper trades are opening");
    lines.push("");
    lines.push(escapeMd(zeroReason));
    lines.push("");
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    lines.push("**Error:** " + err);
    lines.push("");
    lines.push("Ensure DATABASE_URL is set and migrations are applied, then re-run:");
    lines.push("`npx tsx tools/dump-paper-trading-runtime-state.ts`");
    lines.push("");
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, lines.join("\n"), "utf8");
  console.log("Wrote " + OUT_PATH);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
