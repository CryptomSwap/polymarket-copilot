import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getActiveOrApprovedShadowModel } from "@/lib/ml/shadow-score";
import { getPaperTradingConfig } from "@/lib/paper-trading/config";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper-trading/diagnostics
 * Full diagnostics: enabled, threshold, cooldowns, risk limits, last open/close tick times and results, model, open/close rates in last 24h.
 */
export async function GET() {
  try {
    const config = getPaperTradingConfig();
    const active = await getActiveOrApprovedShadowModel();

    const state = await prisma.paperTradingState.findUnique({
      where: { id: "default" },
    });

    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [openTicks24h, closeTicks24h, tradesCreated24h, tradesClosed24h] = await Promise.all([
      state?.lastOpenTickAt && state.lastOpenTickAt >= last24h ? 1 : 0,
      state?.lastCloseTickAt && state.lastCloseTickAt >= last24h ? 1 : 0,
      prisma.paperTrade.count({ where: { createdAt: { gte: last24h } } }),
      prisma.paperTrade.count({ where: { status: "closed", exitTime: { gte: last24h } } }),
    ]);

    let lastOpenTickResult: Record<string, unknown> | null = null;
    let lastCloseTickResult: Record<string, unknown> | null = null;
    if (state?.lastOpenTickResultJson) {
      try {
        lastOpenTickResult = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
      } catch {
        lastOpenTickResult = { raw: state.lastOpenTickResultJson };
      }
    }
    if (state?.lastCloseTickResultJson) {
      try {
        lastCloseTickResult = JSON.parse(state.lastCloseTickResultJson) as Record<string, unknown>;
      } catch {
        lastCloseTickResult = { raw: state.lastCloseTickResultJson };
      }
    }

    const r = lastOpenTickResult;
    const lastTickCandidatesLoaded = typeof r?.candidatesLoaded === "number" ? r.candidatesLoaded : null;
    const lastTickCandidatesScored = typeof r?.candidatesScored === "number" ? r.candidatesScored : null;
    const lastTickMaxScore = typeof r?.maxScore === "number" ? r.maxScore : null;
    const lastTickAvgScore = typeof r?.avgScore === "number" ? r.avgScore : null;
    const lastTickAboveThresholdCount = typeof r?.aboveThresholdCount === "number" ? r.aboveThresholdCount : null;
    const lastTickRejectedByCooldownCount = typeof r?.rejectedByCooldownCount === "number" ? r.rejectedByCooldownCount : null;
    const lastTickRejectedByRiskLimitCount = typeof r?.rejectedByRiskLimitCount === "number" ? r.rejectedByRiskLimitCount : null;
    const lastTickTopCandidateScores = Array.isArray(r?.topCandidateScores) ? r.topCandidateScores : [];
    const lastTickLoadDiagnostics = r?.loadDiagnostics && typeof r.loadDiagnostics === "object" ? r.loadDiagnostics : null;
    const lastTickZeroCandidatesReason = lastTickLoadDiagnostics && typeof (lastTickLoadDiagnostics as Record<string, unknown>).zeroCandidatesReason === "string"
      ? (lastTickLoadDiagnostics as Record<string, unknown>).zeroCandidatesReason
      : null;
    const lastTickSampleSnapshotCheck = lastTickLoadDiagnostics && Array.isArray((lastTickLoadDiagnostics as Record<string, unknown>).sampleSnapshotCheck)
      ? (lastTickLoadDiagnostics as Record<string, unknown>).sampleSnapshotCheck
      : null;
    const d = lastTickLoadDiagnostics as Record<string, unknown> | null;
    const lastTickPolicyStateCounts = d && typeof d.policyStateCounts === "object" && d.policyStateCounts !== null ? d.policyStateCounts : null;
    const lastTickFilteredByPolicyStateCount = d && typeof d.filteredByPolicyStateCount === "number" ? d.filteredByPolicyStateCount : null;
    const lastTickAvoidedCount = d && typeof d.avoidedCount === "number" ? d.avoidedCount : null;
    const lastTickAllowedCount = d && typeof d.allowedCount === "number" ? d.allowedCount : null;
    const lastTickZeroSizeAfterPolicyCount = d && typeof d.zeroSizeAfterPolicyCount === "number" ? d.zeroSizeAfterPolicyCount : null;
    const lastTickSampleFilteredByPolicy = d && Array.isArray(d.sampleFilteredByPolicy) ? d.sampleFilteredByPolicy : null;
    const lastTickRelaxedBlockedCount = d && typeof d.relaxedBlockedCount === "number" ? d.relaxedBlockedCount : null;
    const lastTickRelaxedByReasonCounts = d && typeof d.relaxedByReasonCounts === "object" && d.relaxedByReasonCounts !== null ? d.relaxedByReasonCounts : null;
    const lastTickCandidatesPassedViaRelaxation = d && typeof d.candidatesPassedViaRelaxation === "number" ? d.candidatesPassedViaRelaxation : null;
    const lastTickBlockedCandidatesSeen = d && typeof d.blockedCandidatesSeen === "number" ? d.blockedCandidatesSeen : null;
    const lastTickPaperRelaxationEligible = d && typeof d.paperRelaxationEligible === "number" ? d.paperRelaxationEligible : null;
    const lastTickPaperRelaxationRejected = d && typeof d.paperRelaxationRejected === "number" ? d.paperRelaxationRejected : null;
    const lastTickPaperRelaxationAccepted_edgeTooSmall = d && typeof d.paperRelaxationAccepted_edgeTooSmall === "number" ? d.paperRelaxationAccepted_edgeTooSmall : null;
    const lastTickPaperRelaxationAccepted_liquidityTooLow = d && typeof d.paperRelaxationAccepted_liquidityTooLow === "number" ? d.paperRelaxationAccepted_liquidityTooLow : null;
    const lastTickPaperRelaxationAccepted_multiAllowed = d && typeof d.paperRelaxationAccepted_multiAllowed === "number" ? d.paperRelaxationAccepted_multiAllowed : null;
    const lastTickScoredAfterRelaxation = typeof r?.scoredAfterRelaxation === "number" ? r.scoredAfterRelaxation : null;
    const lastTickPaperTradesCreatedFromRelaxation = typeof r?.paperTradesCreatedFromRelaxation === "number" ? r.paperTradesCreatedFromRelaxation : null;
    const lastTickRelaxedScoredSuccessfully = typeof r?.relaxedScoredSuccessfully === "number" ? r.relaxedScoredSuccessfully : lastTickScoredAfterRelaxation;
    const lastTickRelaxedOpenedTrades = typeof r?.relaxedOpenedTrades === "number" ? r.relaxedOpenedTrades : lastTickPaperTradesCreatedFromRelaxation;
    const lastTickRelaxedCandidatesConsidered = d && typeof d.relaxedCandidatesConsidered === "number" ? d.relaxedCandidatesConsidered : null;
    const lastTickRelaxedDropped_actionTypeAvoid = d && typeof d.relaxedDropped_actionTypeAvoid === "number" ? d.relaxedDropped_actionTypeAvoid : null;
    const lastTickRelaxedDropped_actionTypeSyncFirst = d && typeof d.relaxedDropped_actionTypeSyncFirst === "number" ? d.relaxedDropped_actionTypeSyncFirst : null;
    const lastTickRelaxedDropped_missingAssetResolution = d && typeof d.relaxedDropped_missingAssetResolution === "number" ? d.relaxedDropped_missingAssetResolution : null;
    const lastTickRelaxedDropped_missingSide = d && typeof d.relaxedDropped_missingSide === "number" ? d.relaxedDropped_missingSide : null;
    const lastTickRelaxedDropped_missingPriceContext = d && typeof d.relaxedDropped_missingPriceContext === "number" ? d.relaxedDropped_missingPriceContext : null;
    const lastTickRelaxedDropped_other = d && typeof d.relaxedDropped_other === "number" ? d.relaxedDropped_other : null;
    const lastTickRelaxedBuiltSuccessfully = d && typeof d.relaxedBuiltSuccessfully === "number" ? d.relaxedBuiltSuccessfully : null;

    const perBotResults =
      r && typeof (r as Record<string, unknown>).perBotResults === "object" && (r as Record<string, unknown>).perBotResults !== null
        ? ((r as Record<string, unknown>).perBotResults as Record<string, Record<string, unknown>>)
        : null;

    let lastTickPerBotSummary: Record<
      string,
      {
        opened: number;
        skipped: number;
        candidatesLoaded: number;
        candidatesScored: number;
        maxScore: number | null;
        avgScore: number | null;
        aboveThresholdCount: number;
        rejectedByCooldownCount: number;
        rejectedByRiskLimitCount: number;
        scoredAfterRelaxation: number | null;
        paperTradesCreatedFromRelaxation: number | null;
      }
    > | null = null;

    if (perBotResults) {
      lastTickPerBotSummary = {};
      for (const [botType, raw] of Object.entries(perBotResults)) {
        const x = raw ?? {};
        const obj = x as Record<string, unknown>;
        lastTickPerBotSummary[botType] = {
          opened: typeof obj.opened === "number" ? obj.opened : 0,
          skipped: typeof obj.skipped === "number" ? obj.skipped : 0,
          candidatesLoaded:
            typeof obj.candidatesLoaded === "number" ? obj.candidatesLoaded : 0,
          candidatesScored:
            typeof obj.candidatesScored === "number" ? obj.candidatesScored : 0,
          maxScore: typeof obj.maxScore === "number" ? obj.maxScore : null,
          avgScore: typeof obj.avgScore === "number" ? obj.avgScore : null,
          aboveThresholdCount:
            typeof obj.aboveThresholdCount === "number" ? obj.aboveThresholdCount : 0,
          rejectedByCooldownCount:
            typeof obj.rejectedByCooldownCount === "number"
              ? obj.rejectedByCooldownCount
              : 0,
          rejectedByRiskLimitCount:
            typeof obj.rejectedByRiskLimitCount === "number"
              ? obj.rejectedByRiskLimitCount
              : 0,
          scoredAfterRelaxation:
            typeof obj.scoredAfterRelaxation === "number"
              ? obj.scoredAfterRelaxation
              : null,
          paperTradesCreatedFromRelaxation:
            typeof obj.paperTradesCreatedFromRelaxation === "number"
              ? obj.paperTradesCreatedFromRelaxation
              : null,
        };
      }
    }

    const [normalTradeCount, relaxedTradeCount] = await Promise.all([
      prisma.paperTrade.count({ where: { paperPolicyMode: { not: "relaxed_block_candidate" } } }),
      prisma.paperTrade.count({ where: { paperPolicyMode: "relaxed_block_candidate" } }),
    ]);
    const relaxedByReasonCount = await prisma.paperTrade.groupBy({
      by: ["paperRelaxationReason"],
      where: { paperPolicyMode: "relaxed_block_candidate" },
      _count: { id: true },
    });
    const relaxedByReasonCountsDb: Record<string, number> = {};
    for (const row of relaxedByReasonCount) {
      const key = row.paperRelaxationReason ?? "unknown";
      relaxedByReasonCountsDb[key] = row._count.id;
    }

    return NextResponse.json({
      paperTradingEnabled: config.enabled,
      currentThreshold: config.threshold,
      cooldownHours: config.cooldownHours,
      cooldownMarketHours: config.cooldownMarketHours,
      minScoreBuffer: config.minScoreBuffer,
      maxOpenTotal: config.maxOpenTotal,
      maxOpenPerMarket: config.maxOpenPerMarket,
      maxOpenPerTheme: config.maxOpenPerTheme,
      maxOpenPerCategory: config.maxOpenPerCategory,
      maxDailyNewTrades: config.maxDailyNewTrades,
      lastOpenTickAt: state?.lastOpenTickAt?.toISOString() ?? null,
      lastOpenTickResult: lastOpenTickResult,
      lastOpenTickError: state?.lastOpenTickError ?? null,
      lastTickCandidatesLoaded: lastTickCandidatesLoaded,
      lastTickCandidatesScored: lastTickCandidatesScored,
      lastTickMaxScore: lastTickMaxScore,
      lastTickAvgScore: lastTickAvgScore,
      lastTickAboveThresholdCount: lastTickAboveThresholdCount,
      lastTickRejectedByCooldownCount: lastTickRejectedByCooldownCount,
      lastTickRejectedByRiskLimitCount: lastTickRejectedByRiskLimitCount,
      lastTickTopCandidateScores: lastTickTopCandidateScores,
      lastTickLoadDiagnostics: lastTickLoadDiagnostics,
      lastTickZeroCandidatesReason: lastTickZeroCandidatesReason,
      lastTickSampleSnapshotCheck: lastTickSampleSnapshotCheck,
      lastTickPolicyStateCounts: lastTickPolicyStateCounts,
      lastTickFilteredByPolicyStateCount: lastTickFilteredByPolicyStateCount,
      lastTickAvoidedCount: lastTickAvoidedCount,
      lastTickAllowedCount: lastTickAllowedCount,
      lastTickZeroSizeAfterPolicyCount: lastTickZeroSizeAfterPolicyCount,
      lastTickSampleFilteredByPolicy: lastTickSampleFilteredByPolicy,
      lastTickRelaxedBlockedCount: lastTickRelaxedBlockedCount,
      lastTickRelaxedByReasonCounts: lastTickRelaxedByReasonCounts,
      lastTickCandidatesPassedViaRelaxation: lastTickCandidatesPassedViaRelaxation,
      lastTickBlockedCandidatesSeen: lastTickBlockedCandidatesSeen,
      lastTickPaperRelaxationEligible: lastTickPaperRelaxationEligible,
      lastTickPaperRelaxationRejected: lastTickPaperRelaxationRejected,
      lastTickPaperRelaxationAccepted_edgeTooSmall: lastTickPaperRelaxationAccepted_edgeTooSmall,
      lastTickPaperRelaxationAccepted_liquidityTooLow: lastTickPaperRelaxationAccepted_liquidityTooLow,
      lastTickPaperRelaxationAccepted_multiAllowed: lastTickPaperRelaxationAccepted_multiAllowed,
      lastTickScoredAfterRelaxation: lastTickScoredAfterRelaxation,
      lastTickPaperTradesCreatedFromRelaxation: lastTickPaperTradesCreatedFromRelaxation,
      lastTickRelaxedScoredSuccessfully: lastTickRelaxedScoredSuccessfully,
      lastTickRelaxedOpenedTrades: lastTickRelaxedOpenedTrades,
      lastTickRelaxedCandidatesConsidered: lastTickRelaxedCandidatesConsidered,
      lastTickRelaxedDropped_actionTypeAvoid: lastTickRelaxedDropped_actionTypeAvoid,
      lastTickRelaxedDropped_actionTypeSyncFirst: lastTickRelaxedDropped_actionTypeSyncFirst,
      lastTickRelaxedDropped_missingAssetResolution: lastTickRelaxedDropped_missingAssetResolution,
      lastTickRelaxedDropped_missingSide: lastTickRelaxedDropped_missingSide,
      lastTickRelaxedDropped_missingPriceContext: lastTickRelaxedDropped_missingPriceContext,
      lastTickRelaxedDropped_other: lastTickRelaxedDropped_other,
      lastTickRelaxedBuiltSuccessfully: lastTickRelaxedBuiltSuccessfully,
      paperTradeCountByPolicyMode: { normal: normalTradeCount, relaxed_block_candidate: relaxedTradeCount },
      relaxedTradeCountByReason: relaxedByReasonCountsDb,
      lastCloseTickAt: state?.lastCloseTickAt?.toISOString() ?? null,
      lastCloseTickResult: lastCloseTickResult,
      lastCloseTickError: state?.lastCloseTickError ?? null,
      activeTargetLabel: active?.run.targetLabel ?? null,
      modelRunId: active?.run.id ?? null,
      tradeOpenRate24h: tradesCreated24h,
      closeRate24h: tradesClosed24h,
      lastTickPerBotSummary,
    });
  } catch (e) {
    console.error("[GET /api/paper-trading/diagnostics]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Diagnostics failed" },
      { status: 500 }
    );
  }
}
