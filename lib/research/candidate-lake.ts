import type { PaperTradingCandidate } from "@/lib/paper-trading/candidates";
import type { PaperDecisionTraceEntry } from "@/lib/paper-trading/decision-trace-types";

export type CandidateSourceFamily =
  | "event_graph_relative_value"
  | "maker_rebate_inventory"
  | "event_triggered_maker"
  | "event_triggered_news"
  | "exogenous_directional"
  | "ensemble_adversarial"
  | "runtime_fallback"
  | "unknown";

export interface CandidateLakeRecord {
  candidateId: string;
  recommendationId: string;
  marketId: string;
  assetId: string;
  side: string;
  sourceFamily: CandidateSourceFamily;
  horizon: string | null;
  expectedNetEdge: number | null;
  uncertainty: number | null;
  diversityCluster: string | null;
  comparatorId: string | null;
  portfolioMarginalUtility: number | null;
  constraintFamily: string | null;
  eventGraphViolationType: string | null;
  syntheticLegCount: number | null;
  impliedProbGap: number | null;
  resolutionRuleHash: string | null;
  netEdgeAfterFeesAndImpact: number | null;
  visibleDepthScore: number | null;
  fillProbability: number | null;
  timeToFillEstimateSeconds: number | null;
  edgeDecayRisk: number | null;
  expectedRealizedEdge: number | null;
  executionRealismReasonCodes: string[];
  sourceNetEdgeReasonCodes: string[];
  sourceEconomicsComponents: {
    sourceFamily: string | null;
    spreadBps: number | null;
    recentSpreadChangeBps: number | null;
    freshnessScore: number | null;
    recentActivityScore: number | null;
    estimatedSlippageBps: number | null;
    netEdgeAfterFeesAndImpact: number | null;
    expectedNetEdge: number | null;
    fillProbability: number | null;
    edgeDecayRisk: number | null;
    expectedRealizedEdge: number | null;
    uncertainty: number | null;
    netEdgeGuardOutcome?:
      | "existing_edge_used"
      | "insufficient_inputs"
      | "spread_out_of_band"
      | "no_positive_spread_expansion"
      | "nonpositive_edge"
      | "computed_positive_edge"
      | null;
    netEdgeGuardContext?: {
      spreadBps: number | null;
      estimatedSlippageBps: number | null;
      recentSpreadChangeBps: number | null;
      freshnessScore: number | null;
      recentActivityScore: number | null;
      grossOpportunityBps: number | null;
      frictionBps: number | null;
      netBps: number | null;
    } | null;
    dataQualityFlags: string[];
    missingComponentReasons: string[];
  } | null;
  createdAtIso: string;
}

export const CANDIDATE_LAKE_SCHEMA_VERSION = "v1";

export interface CandidateLakePersistedRecord {
  writerSchemaTag?: string;
  schemaVersion: string;
  tickTimestampIso: string;
  tickBatchId: string | null;
  engineBranch: string;
  modelRunId: string | null;
  botType: string;
  candidateId: string;
  recommendationId: string;
  marketId: string;
  assetId: string;
  side: string;
  finalDisposition: "admitted" | "rejected" | null;
  rejectReasonCode: string | null;
  candidateSourceFamily: CandidateSourceFamily;
  eventGraphViolationType: string | null;
  syntheticLegCount: number | null;
  impliedProbGap: number | null;
  resolutionRuleHash: string | null;
  netEdgeAfterFeesAndImpact: number | null;
  visibleDepthScore: number | null;
  fillProbability: number | null;
  timeToFillEstimateSeconds: number | null;
  edgeDecayRisk: number | null;
  expectedRealizedEdge: number | null;
  executionRealismReasonCodes: string[];
  sourceNetEdgeReasonCodes: string[];
  sourceEconomicsComponents: CandidateLakeRecord["sourceEconomicsComponents"];
  expectedNetEdge: number | null;
  uncertainty: number | null;
  comparatorId: string | null;
  admissionScore: number | null;
  thresholdEligible: boolean | null;
  explorationEligible: boolean | null;
  dedupeLimited: boolean | null;
  capsLimited: boolean | null;
  cooldownLimited: boolean | null;
  weakestEligibleAdmission: number | null;
  scoreDeltaVsWeakest: number | null;
  traceJoinKey: string;
  persistedAtIso: string;
}

export function buildCandidateLakeRecord(
  candidate: PaperTradingCandidate,
  extras?: {
    horizon?: string | null;
    expectedNetEdge?: number | null;
    uncertainty?: number | null;
    diversityCluster?: string | null;
    comparatorId?: string | null;
    portfolioMarginalUtility?: number | null;
    constraintFamily?: string | null;
  }
): CandidateLakeRecord {
  const source = candidate.candidateSourceFamily?.trim() || "unknown";
  const sourceFamily = normalizeCandidateSourceFamily(source);
  return {
    candidateId: candidate.shadowCandidateId ?? candidate.recommendationId,
    recommendationId: candidate.recommendationId,
    marketId: candidate.marketId,
    assetId: candidate.assetId,
    side: candidate.side,
    sourceFamily,
    horizon: extras?.horizon ?? null,
    diversityCluster: extras?.diversityCluster ?? null,
    portfolioMarginalUtility: extras?.portfolioMarginalUtility ?? null,
    constraintFamily: extras?.constraintFamily ?? null,
    eventGraphViolationType: candidate.eventGraphViolationType ?? null,
    syntheticLegCount: candidate.syntheticLegCount ?? null,
    impliedProbGap: candidate.impliedProbGap ?? null,
    resolutionRuleHash: candidate.resolutionRuleHash ?? null,
    netEdgeAfterFeesAndImpact: candidate.netEdgeAfterFeesAndImpact ?? null,
    visibleDepthScore: candidate.visibleDepthScore ?? null,
    fillProbability: candidate.fillProbability ?? null,
    timeToFillEstimateSeconds: candidate.timeToFillEstimateSeconds ?? null,
    edgeDecayRisk: candidate.edgeDecayRisk ?? null,
    expectedRealizedEdge: candidate.expectedRealizedEdge ?? null,
    executionRealismReasonCodes: candidate.executionRealismReasonCodes ?? [],
    sourceNetEdgeReasonCodes: candidate.sourceNetEdgeReasonCodes ?? [],
    sourceEconomicsComponents: candidate.sourceEconomicsComponents ?? null,
    expectedNetEdge: candidate.expectedNetEdge ?? extras?.expectedNetEdge ?? null,
    uncertainty: candidate.uncertainty ?? extras?.uncertainty ?? null,
    comparatorId: candidate.comparatorId ?? extras?.comparatorId ?? null,
    createdAtIso: new Date().toISOString(),
  };
}

export function normalizeCandidateSourceFamily(raw: string | null | undefined): CandidateSourceFamily {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (value === "event_graph_relative_value" || value === "event-graph-rv" || value === "event_graph_rv") {
    return "event_graph_relative_value";
  }
  if (value === "maker_rebate_inventory" || value === "maker" || value === "market_making") {
    return "maker_rebate_inventory";
  }
  if (value === "event_triggered_maker" || value === "event-triggered-maker") {
    return "event_triggered_maker";
  }
  if (value === "event_triggered_news" || value === "event-triggered-news") {
    return "event_triggered_news";
  }
  if (value === "exogenous_directional" || value === "exogenous") {
    return "exogenous_directional";
  }
  if (value === "ensemble_adversarial" || value === "ensemble") {
    return "ensemble_adversarial";
  }
  if (value === "runtime_fallback" || value === "paper_trading") {
    return "runtime_fallback";
  }
  return "unknown";
}

export function buildCandidateLakePersistedRecordFromTrace(params: {
  trace: PaperDecisionTraceEntry;
  tickTimestampIso: string;
  tickBatchId?: string | null;
  engineBranch: string;
  modelRunId?: string | null;
}): CandidateLakePersistedRecord {
  const { trace, tickTimestampIso, tickBatchId, engineBranch, modelRunId } = params;
  const sourceFamily = normalizeCandidateSourceFamily(trace.candidateSourceFamily);
  const resolvedModelRunId =
    modelRunId ??
    trace.championModelRunId ??
    trace.challengerModelRunId ??
    null;
  const marketId = trace.marketId ?? "";
  const traceJoinKey = `${tickTimestampIso}|${trace.botType}|${trace.recommendationId}|${trace.assetId}|${trace.side ?? ""}`;
  const normalizedSourceFamily = normalizeCandidateSourceFamily(trace.candidateSourceFamily);
  const fallbackSourceEconomicsComponents =
    trace.sourceEconomicsComponents ??
    buildFallbackSourceEconomicsComponentsFromTrace({
      sourceFamily: normalizedSourceFamily,
      trace,
    });
  return {
    writerSchemaTag: "v1_with_source_econ",
    schemaVersion: CANDIDATE_LAKE_SCHEMA_VERSION,
    tickTimestampIso,
    tickBatchId: tickBatchId ?? null,
    engineBranch,
    modelRunId: resolvedModelRunId,
    botType: trace.botType,
    candidateId: trace.shadowCandidateId ?? trace.recommendationId,
    recommendationId: trace.recommendationId,
    marketId,
    assetId: trace.assetId,
    side: trace.side ?? "",
    finalDisposition: trace.finalDisposition ?? null,
    rejectReasonCode: trace.rejectReasonCode ?? null,
    candidateSourceFamily: sourceFamily,
    eventGraphViolationType: trace.eventGraphViolationType ?? null,
    syntheticLegCount: trace.syntheticLegCount ?? null,
    impliedProbGap: trace.impliedProbGap ?? null,
    resolutionRuleHash: trace.resolutionRuleHash ?? null,
    netEdgeAfterFeesAndImpact: trace.netEdgeAfterFeesAndImpact ?? null,
    visibleDepthScore: trace.visibleDepthScore ?? null,
    fillProbability: trace.fillProbability ?? null,
    timeToFillEstimateSeconds: trace.timeToFillEstimateSeconds ?? null,
    edgeDecayRisk: trace.edgeDecayRisk ?? null,
    expectedRealizedEdge: trace.expectedRealizedEdge ?? null,
    executionRealismReasonCodes: trace.executionRealismReasonCodes ?? [],
    sourceNetEdgeReasonCodes: trace.sourceNetEdgeReasonCodes ?? [],
    sourceEconomicsComponents: fallbackSourceEconomicsComponents,
    expectedNetEdge: trace.expectedNetEdge ?? null,
    uncertainty: trace.uncertainty ?? null,
    comparatorId: trace.comparatorId ?? null,
    admissionScore: trace.admissionScore ?? null,
    thresholdEligible: typeof trace.thresholdEligible === "boolean" ? trace.thresholdEligible : null,
    explorationEligible: typeof trace.explorationEligible === "boolean" ? trace.explorationEligible : null,
    dedupeLimited: typeof trace.dedupeLimited === "boolean" ? trace.dedupeLimited : null,
    capsLimited: typeof trace.capsLimited === "boolean" ? trace.capsLimited : null,
    cooldownLimited: typeof trace.cooldownLimited === "boolean" ? trace.cooldownLimited : null,
    // Candidate-level weakest comparator fields are not universally available in current trace payload.
    weakestEligibleAdmission: null,
    scoreDeltaVsWeakest: null,
    traceJoinKey,
    persistedAtIso: new Date().toISOString(),
  };
}

/** Diagnostics-only lake row from RSS/news → market match (not produced by paper engine traces). */
export function buildCandidateLakePersistedRecordFromEventTriggeredNews(params: {
  tickTimestampIso: string;
  tickBatchId: string | null;
  engineBranch: string;
  botType: string;
  recommendationId: string;
  marketId: string;
  assetId: string;
  side: string;
  netEdgeAfterFeesAndImpact: number | null;
  expectedNetEdge: number | null;
  uncertainty: number | null;
  freshnessScore: number;
  spreadBps: number | null;
  mappingConfidence: number;
  eventTimestampIso: string;
  rssSourceId: string;
  rssUrl: string;
  rssTitle: string;
}): CandidateLakePersistedRecord {
  const {
    tickTimestampIso,
    tickBatchId,
    engineBranch,
    botType,
    recommendationId,
    marketId,
    assetId,
    side,
    netEdgeAfterFeesAndImpact,
    expectedNetEdge,
    uncertainty,
    freshnessScore,
    spreadBps,
    mappingConfidence,
    eventTimestampIso,
    rssSourceId,
    rssUrl,
    rssTitle,
  } = params;
  const sourceFamily: CandidateSourceFamily = "event_triggered_news";
  const traceJoinKey = `event_triggered_news|${eventTimestampIso}|${recommendationId}|${assetId}|${side}`;
  const sourceEconomicsComponents: CandidateLakeRecord["sourceEconomicsComponents"] = {
    sourceFamily,
    spreadBps,
    recentSpreadChangeBps: null,
    freshnessScore,
    recentActivityScore: null,
    estimatedSlippageBps: null,
    netEdgeAfterFeesAndImpact,
    expectedNetEdge,
    fillProbability: null,
    edgeDecayRisk: null,
    expectedRealizedEdge: null,
    uncertainty,
    netEdgeGuardOutcome: null,
    netEdgeGuardContext: null,
    dataQualityFlags: [
      "diagnostics_only_event_triggered_news",
      `rss_source:${rssSourceId}`,
      `mapping_confidence:${Math.round(mappingConfidence * 1000) / 1000}`,
      `event_at:${eventTimestampIso}`,
    ],
    missingComponentReasons: [`rss_title:${rssTitle.slice(0, 120)}`, `rss_url:${rssUrl.slice(0, 200)}`],
  };
  return {
    writerSchemaTag: "v1_event_triggered_news_diagnostics",
    schemaVersion: CANDIDATE_LAKE_SCHEMA_VERSION,
    tickTimestampIso,
    tickBatchId,
    engineBranch,
    modelRunId: null,
    botType,
    candidateId: recommendationId,
    recommendationId,
    marketId,
    assetId,
    side,
    finalDisposition: null,
    rejectReasonCode: null,
    candidateSourceFamily: sourceFamily,
    eventGraphViolationType: null,
    syntheticLegCount: null,
    impliedProbGap: null,
    resolutionRuleHash: null,
    netEdgeAfterFeesAndImpact,
    visibleDepthScore: null,
    fillProbability: null,
    timeToFillEstimateSeconds: null,
    edgeDecayRisk: null,
    expectedRealizedEdge: null,
    executionRealismReasonCodes: [],
    sourceNetEdgeReasonCodes: netEdgeAfterFeesAndImpact != null ? ["event_triggered_news_edge_heuristic"] : [],
    sourceEconomicsComponents,
    expectedNetEdge,
    uncertainty,
    comparatorId: null,
    admissionScore: null,
    thresholdEligible: null,
    explorationEligible: null,
    dedupeLimited: null,
    capsLimited: null,
    cooldownLimited: null,
    weakestEligibleAdmission: null,
    scoreDeltaVsWeakest: null,
    traceJoinKey,
    persistedAtIso: new Date().toISOString(),
  };
}

/** Rebuild economics component map from trace economics fields when full `sourceEconomicsComponents` was not persisted on the trace. */
export function buildFallbackSourceEconomicsComponentsFromTrace(params: {
  sourceFamily: CandidateSourceFamily;
  trace: PaperDecisionTraceEntry;
}): CandidateLakeRecord["sourceEconomicsComponents"] {
  const { sourceFamily, trace } = params;
  const isTargetSource =
    sourceFamily === "event_triggered_maker" || sourceFamily === "maker_rebate_inventory";
  if (!isTargetSource) return null;

  const hasAnyEconomicsSignal =
    trace.fillProbability != null ||
    trace.edgeDecayRisk != null ||
    trace.expectedRealizedEdge != null ||
    trace.netEdgeAfterFeesAndImpact != null ||
    trace.expectedNetEdge != null ||
    trace.uncertainty != null ||
    (trace.executionRealismReasonCodes?.length ?? 0) > 0 ||
    (trace.sourceNetEdgeReasonCodes?.length ?? 0) > 0;
  if (!hasAnyEconomicsSignal) return null;

  const missingComponentReasons = [
    ...(trace.sourceNetEdgeReasonCodes ?? []),
    ...(trace.executionRealismReasonCodes ?? []),
  ];
  const dataQualityFlags: string[] = [];
  if (trace.spreadBps != null) dataQualityFlags.push("has_spread_bps");
  if (trace.estimatedSlippageBps != null) dataQualityFlags.push("has_estimated_slippage_bps");
  if (trace.netEdgeAfterFeesAndImpact != null) dataQualityFlags.push("has_net_edge_after_fees_and_impact");
  if (trace.fillProbability != null) dataQualityFlags.push("has_fill_probability");
  if (trace.expectedRealizedEdge != null) dataQualityFlags.push("has_expected_realized_edge");
  if (trace.uncertainty != null) dataQualityFlags.push("has_uncertainty");

  return {
    sourceFamily: sourceFamily === "unknown" ? null : sourceFamily,
    spreadBps: trace.spreadBps ?? null,
    recentSpreadChangeBps: null,
    freshnessScore: null,
    recentActivityScore: null,
    estimatedSlippageBps: trace.estimatedSlippageBps ?? null,
    netEdgeAfterFeesAndImpact: trace.netEdgeAfterFeesAndImpact ?? null,
    expectedNetEdge: trace.expectedNetEdge ?? null,
    fillProbability: trace.fillProbability ?? null,
    edgeDecayRisk: trace.edgeDecayRisk ?? null,
    expectedRealizedEdge: trace.expectedRealizedEdge ?? null,
    uncertainty: trace.uncertainty ?? null,
    netEdgeGuardOutcome: null,
    netEdgeGuardContext: null,
    dataQualityFlags,
    missingComponentReasons,
  };
}
