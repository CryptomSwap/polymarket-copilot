/**
 * Paper-only relaxation audit: snapshots, classification counts, and sample rows.
 * Outputs: dump/paper-relaxation-audit.json, dump/paper-relaxation-audit.md
 * Run: npx tsx tools/create-paper-relaxation-audit.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getFunderForDecisionRecompute } from "../lib/decision/recompute";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import {
  classifyPaperRelaxationEligibility,
  type PaperRelaxationEligibilityResult,
} from "../lib/paper-trading/paper-relaxation";
import { buildBlockReport } from "../lib/decision/block-report";
import { getPaperTradingCandidatesWithDiagnostics } from "../lib/paper-trading/candidates";

const DUMP_DIR = path.join(process.cwd(), "dump");

interface SampleRow {
  recommendationId: string | null;
  marketTitle: string | null;
  marketSlug: string | null;
  assetId: string | null;
  side: string | null;
  action: string | null;
  sourceDecisionState: string;
  originalBlockingReasons: string[];
  finalSuggestedSize: string;
  paperPolicyMode: string;
  paperRelaxationReason: string | null;
  eligibility: PaperRelaxationEligibilityResult;
  modelScore: number | null;
  paperTradeCreated: boolean;
  derivationSource?: string | null;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const timestamp = new Date().toISOString();
  const funder = await getFunderForDecisionRecompute();
  const active = await getActiveOrApprovedShadowModel();
  const config = getPaperTradingConfig();

  const snapshots = await prisma.decisionPolicySnapshot.findMany({
    where: funder ? { funderAddress: funder } : undefined,
    include: {
      recommendation: {
        include: {
          marketSignal: true,
        },
      },
    },
    orderBy: { recommendationId: "asc" },
  });

  const blockReport = await buildBlockReport(funder ?? undefined);

  const paperTradesByRecId = new Map<string, { score: number }>();
  const paperTrades = await prisma.paperTrade.findMany({
    select: { metadataJson: true, score: true },
  });
  for (const t of paperTrades) {
    try {
      const meta = t.metadataJson ? (JSON.parse(t.metadataJson) as Record<string, unknown>) : {};
      const recId = meta.recommendationId as string | undefined;
      if (recId) paperTradesByRecId.set(recId, { score: t.score });
    } catch {
      // ignore
    }
  }

  const byPolicyState: Record<string, number> = {};
  const byBlockReason: Record<string, number> = {};
  const byClassification: Record<string, number> = {};
  const acceptedByReason: Record<string, number> = { edge_too_small: 0, liquidity_too_low: 0, multi_allowed: 0 };
  const rejectedByReason: Record<string, number> = {};

  const samples: {
    accepted_edge_too_small: SampleRow[];
    accepted_liquidity_too_low: SampleRow[];
    accepted_multi_allowed: SampleRow[];
    rejected_crowded: SampleRow[];
    rejected_mixed_disallowed: SampleRow[];
  } = {
    accepted_edge_too_small: [],
    accepted_liquidity_too_low: [],
    accepted_multi_allowed: [],
    rejected_crowded: [],
    rejected_mixed_disallowed: [],
  };

  for (const snap of snapshots) {
    const state = snap.policyState ?? "UNKNOWN";
    byPolicyState[state] = (byPolicyState[state] ?? 0) + 1;

    let blockReason: string | null = null;
    if (snap.reasoningJson) {
      try {
        const o = JSON.parse(snap.reasoningJson) as Record<string, unknown>;
        blockReason = typeof o.blockReason === "string" ? o.blockReason : null;
        if (blockReason) byBlockReason[blockReason] = (byBlockReason[blockReason] ?? 0) + 1;
      } catch {
        // ignore
      }
    }

    const eligibility = classifyPaperRelaxationEligibility({
      policyState: snap.policyState,
      finalSuggestedSize: snap.finalSuggestedSize,
      reasoningJson: snap.reasoningJson,
    });

    const key = eligibility.mode === "relaxed_block_candidate" ? "accepted" : eligibility.mode;
    byClassification[key] = (byClassification[key] ?? 0) + 1;
    if (eligibility.mode === "relaxed_block_candidate" && eligibility.relaxationReason) {
      acceptedByReason[eligibility.relaxationReason] = (acceptedByReason[eligibility.relaxationReason] ?? 0) + 1;
    }
    if (eligibility.mode === "rejected" && eligibility.rejectionReason) {
      const short = eligibility.rejectionReason.slice(0, 60);
      rejectedByReason[short] = (rejectedByReason[short] ?? 0) + 1;
    }

    const rec = snap.recommendation;
    const ms = rec?.marketSignal;
    const marketTitle = ms?.marketTitle ?? null;
    const marketSlug = ms?.slug ?? null;
    let assetId: string | null = null;
    if (rec?.marketSignal?.marketId && rec?.marketSignal?.outcome) {
      const asset = await prisma.syncedAsset.findFirst({
        where: { syncedMarketId: rec.marketSignal.marketId, outcome: rec.marketSignal.outcome },
        select: { tokenId: true },
      });
      assetId = asset?.tokenId ?? null;
    }
    const side = ms?.side ?? null;
    const action = rec?.action ?? null;
    const paperTradeCreated = rec ? paperTradesByRecId.has(rec.id) : false;
    const modelScore = rec ? paperTradesByRecId.get(rec.id)?.score ?? null : null;

    const row: SampleRow = {
      recommendationId: rec?.id ?? null,
      marketTitle,
      marketSlug,
      assetId,
      side,
      action,
      sourceDecisionState: snap.policyState,
      originalBlockingReasons: eligibility.originalBlockingReasons,
      finalSuggestedSize: snap.finalSuggestedSize ?? "",
      paperPolicyMode: eligibility.mode,
      paperRelaxationReason: eligibility.relaxationReason,
      eligibility: { ...eligibility },
      modelScore,
      paperTradeCreated,
    };

    if (eligibility.mode === "relaxed_block_candidate") {
      if (eligibility.relaxationReason === "edge_too_small" && samples.accepted_edge_too_small.length < 20) {
        samples.accepted_edge_too_small.push(row);
      } else if (eligibility.relaxationReason === "liquidity_too_low" && samples.accepted_liquidity_too_low.length < 20) {
        samples.accepted_liquidity_too_low.push(row);
      } else if (eligibility.relaxationReason === "multi_allowed" && samples.accepted_multi_allowed.length < 20) {
        samples.accepted_multi_allowed.push(row);
      }
    } else if (eligibility.mode === "rejected") {
      const isCrowded = eligibility.originalBlockingReasons.some(
        (r) => r === "Market crowded or low liquidity." || r.toLowerCase().includes("market crowded")
      );
      const isMixed =
        (eligibility.rejectionReason?.includes("disallowed_block_reason") ?? false) ||
        (eligibility.rejectionReason?.includes("block_reason_not_allowlisted") ?? false);
      if (isCrowded && samples.rejected_crowded.length < 20) samples.rejected_crowded.push(row);
      else if (isMixed && samples.rejected_mixed_disallowed.length < 20) samples.rejected_mixed_disallowed.push(row);
    }
  }

  const recommendationsFound = await prisma.recommendation.count({
    where: funder ? { marketSignal: { funderAddress: funder } } : undefined,
  });

  let preScoreDropReasons: Record<string, number> = {};
  let sampleRelaxedDerivationFailures: { recommendationId: string; policyState: string; finalSuggestedSize: string; reason: string }[] = [];
  let successfulRelaxedCandidatesSample: { recommendationId: string; assetId: string; side: string; derivationSource: string }[] = [];
  try {
    const { candidates, loadDiagnostics } = await getPaperTradingCandidatesWithDiagnostics(funder ?? "paper");
    preScoreDropReasons = {
      relaxedCandidatesConsidered: loadDiagnostics.relaxedCandidatesConsidered ?? 0,
      relaxedBuiltSuccessfully: loadDiagnostics.relaxedBuiltSuccessfully ?? 0,
      relaxedDropped_actionTypeAvoid: loadDiagnostics.relaxedDropped_actionTypeAvoid ?? 0,
      relaxedDropped_actionTypeSyncFirst: loadDiagnostics.relaxedDropped_actionTypeSyncFirst ?? 0,
      relaxedDropped_missingAssetResolution: loadDiagnostics.relaxedDropped_missingAssetResolution ?? 0,
      relaxedDropped_missingSide: loadDiagnostics.relaxedDropped_missingSide ?? 0,
      relaxedDropped_missingPriceContext: loadDiagnostics.relaxedDropped_missingPriceContext ?? 0,
      relaxedDropped_other: loadDiagnostics.relaxedDropped_other ?? 0,
    };
    const filtered = loadDiagnostics.sampleFilteredByPolicy ?? [];
    sampleRelaxedDerivationFailures = filtered
      .filter((s) => (s.reason ?? "").includes("relaxed_derivation_failed"))
      .slice(0, 20)
      .map((s) => ({ recommendationId: s.recommendationId, policyState: s.policyState, finalSuggestedSize: s.finalSuggestedSize, reason: s.reason }));
    const relaxed = candidates.filter((c) => c.paperPolicyMode === "relaxed_block_candidate");
    successfulRelaxedCandidatesSample = relaxed.slice(0, 20).map((c) => ({
      recommendationId: c.recommendationId,
      assetId: c.assetId,
      side: c.side,
      derivationSource: c.derivationSource ?? "—",
    }));
  } catch (e) {
    console.warn("Candidate load for audit failed:", e instanceof Error ? e.message : e);
  }

  const audit = {
    timestamp,
    activeFunder: funder ?? null,
    activeModelRunId: active?.run.id ?? null,
    activeTargetLabel: active?.run.targetLabel ?? null,
    threshold: config.threshold,
    snapshotsExist: snapshots.length > 0,
    snapshotCount: snapshots.length,
    blockReportPopulated: blockReport.totalSnapshots > 0,
    recommendationsFound,
    countsByPolicyState: byPolicyState,
    countsByBlockReason: byBlockReason,
    countsByPaperRelaxationClassification: byClassification,
    acceptedCountsByRelaxationReason: acceptedByReason,
    rejectedCountsByRejectionReason: rejectedByReason,
    blockReportByPolicyState: blockReport.byPolicyState,
    blockReportByBlockReason: blockReport.byBlockReason,
    blockReportByCategory: blockReport.byCategory,
    samples,
    preScoreDropReasons,
    sampleRelaxedDerivationFailures,
    successfulRelaxedCandidatesSample,
  };

  const jsonPath = path.join(DUMP_DIR, "paper-relaxation-audit.json");
  await fs.writeFile(jsonPath, JSON.stringify(audit, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const md = toMarkdown(audit);
  const mdPath = path.join(DUMP_DIR, "paper-relaxation-audit.md");
  await fs.writeFile(mdPath, md, "utf8");
  console.log("Wrote", mdPath);
}

function toMarkdown(audit: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("# Paper relaxation audit");
  lines.push("");
  lines.push("**Generated:** " + audit.timestamp);
  lines.push("");
  lines.push("## Context");
  lines.push("- **Active funder:** " + (audit.activeFunder ?? "—"));
  lines.push("- **Model run ID:** " + (audit.activeModelRunId ?? "—"));
  lines.push("- **Target label:** " + (audit.activeTargetLabel ?? "—"));
  lines.push("- **Threshold:** " + audit.threshold);
  lines.push("- **Snapshots exist:** " + audit.snapshotsExist);
  lines.push("- **Snapshot count:** " + audit.snapshotCount);
  lines.push("- **Block report populated:** " + audit.blockReportPopulated);
  lines.push("- **Recommendations found:** " + audit.recommendationsFound);
  lines.push("");
  lines.push("## Counts by policy state");
  lines.push("| State | Count |");
  lines.push("|-------|-------|");
  for (const [k, v] of Object.entries((audit.countsByPolicyState as Record<string, number>) ?? {})) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push("## Counts by block reason");
  lines.push("| Reason | Count |");
  lines.push("|--------|-------|");
  for (const [k, v] of Object.entries((audit.countsByBlockReason as Record<string, number>) ?? {})) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push("## Counts by paper relaxation classification");
  lines.push("| Classification | Count |");
  lines.push("|----------------|-------|");
  for (const [k, v] of Object.entries((audit.countsByPaperRelaxationClassification as Record<string, number>) ?? {})) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push("## Accepted by relaxation reason");
  lines.push("| Reason | Count |");
  lines.push("|--------|-------|");
  for (const [k, v] of Object.entries((audit.acceptedCountsByRelaxationReason as Record<string, number>) ?? {})) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push("## Rejected by rejection reason (sample keys)");
  const rej = audit.rejectedCountsByRejectionReason as Record<string, number> | undefined;
  if (rej && Object.keys(rej).length > 0) {
    lines.push("| Reason (truncated) | Count |");
    lines.push("|-------------------|-------|");
    for (const [k, v] of Object.entries(rej).slice(0, 15)) {
      lines.push(`| ${k} | ${v} |`);
    }
  } else {
    lines.push("(none)");
  }
  lines.push("");
  lines.push("## Pre-score drop reasons (relaxed candidate build)");
  const drop = audit.preScoreDropReasons as Record<string, number> | undefined;
  if (drop && Object.keys(drop).length > 0) {
    lines.push("| Reason | Count |");
    lines.push("|--------|-------|");
    for (const [k, v] of Object.entries(drop)) {
      lines.push(`| ${k} | ${v} |`);
    }
  } else {
    lines.push("(not available)");
  }
  lines.push("");
  const failSample = audit.sampleRelaxedDerivationFailures as { recommendationId: string; reason: string }[] | undefined;
  if (failSample && failSample.length > 0) {
    lines.push("## Sample relaxed candidates that failed derivation (max 20)");
    lines.push("| recommendationId | reason |");
    lines.push("|------------------|--------|");
    for (const r of failSample) {
      lines.push(`| ${r.recommendationId} | ${r.reason} |`);
    }
    lines.push("");
  }
  const successSample = audit.successfulRelaxedCandidatesSample as { recommendationId: string; assetId: string; side: string; derivationSource: string }[] | undefined;
  if (successSample && successSample.length > 0) {
    lines.push("## Successful relaxed candidates (sample, with derivationSource)");
    lines.push("| recommendationId | assetId | side | derivationSource |");
    lines.push("|-------------------|---------|------|-----------------|");
    for (const r of successSample) {
      lines.push(`| ${r.recommendationId} | ${r.assetId} | ${r.side} | ${r.derivationSource} |`);
    }
    lines.push("");
  }
  lines.push("## Sample rows (max 20 each)");
  const samples = audit.samples as Record<string, SampleRow[]>;
  for (const [label, arr] of Object.entries(samples ?? {})) {
    lines.push("### " + label);
    if (!arr || arr.length === 0) {
      lines.push("(none)");
    } else {
      lines.push("| recommendationId | marketTitle | slug | assetId | side | sourceDecisionState | finalSuggestedSize | paperPolicyMode | paperRelaxationReason | modelScore | paperTradeCreated |");
      lines.push("|------------------|------------|------|---------|------|---------------------|--------------------|-----------------|------------------------|------------|--------------------|");
      for (const r of arr) {
        lines.push(
          `| ${r.recommendationId ?? "—"} | ${(r.marketTitle ?? "—").slice(0, 30)} | ${r.marketSlug ?? "—"} | ${r.assetId ?? "—"} | ${r.side ?? "—"} | ${r.sourceDecisionState} | ${r.finalSuggestedSize} | ${r.paperPolicyMode} | ${r.paperRelaxationReason ?? "—"} | ${r.modelScore ?? "—"} | ${r.paperTradeCreated} |`
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
