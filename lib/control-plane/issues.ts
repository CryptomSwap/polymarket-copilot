import { prisma } from "@/lib/db";
import { buildBotScorecards, buildMlScorecard } from "./audit";
import { getNextEligibleExperiments } from "./experiments";
import { decideIssueAction } from "./action-policy";
import type { ControlPlaneIssue, IssueConfidence, IssueSeverity, NullFieldReason } from "./contracts";

const ISSUE_THRESHOLDS = {
  bot: {
    highSample: 40,
    minSample: 15,
    negativeAvgMarkoutHigh: -0.0005,
    negativeAvgMarkoutMedium: -0.0001,
    lowHitRate: 0.42,
    weakRankLift: 0,
    highBandConcentrationPct: 0.8,
  },
  ml: {
    noLiftCorrelation: 0,
    weakLiftCorrelation: 0.05,
    noLiftBucketDelta: 0,
    weakLiftBucketDelta: 0.08,
    lowLabelCoverage: 0.6,
    minSampleForStrong: 40,
  },
} as const;

function severityRank(severity: IssueSeverity): number {
  return severity === "critical" ? 0 : severity === "high" ? 1 : severity === "medium" ? 2 : 3;
}

function confidenceRank(confidence: IssueConfidence): number {
  return confidence === "high" ? 0 : confidence === "medium" ? 1 : 2;
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function issueId(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join("_");
}

async function buildOperationalIssues(): Promise<ControlPlaneIssue[]> {
  const issues: ControlPlaneIssue[] = [];
  const [heartbeat, latestLoopStatus] = await Promise.all([
    prisma.workerHeartbeat.findFirst({
      where: { workerName: "polymarket-copilot-worker" },
      orderBy: { lastSeenAt: "desc" },
    }),
    prisma.scheduledJobRun.findFirst({
      where: { jobName: "self_improvement_status_report" },
      orderBy: { startedAt: "desc" },
      select: { status: true, errorMessage: true, startedAt: true, finishedAt: true },
    }),
  ]);
  if (latestLoopStatus?.status === "failure") {
    issues.push({
      id: "validation_blocked",
      type: "operational_guardrail",
      severity: "high",
      confidence: "medium",
      status: "open",
      botId: null,
      modelVersion: null,
      diagnosis: "validation_blocked",
      reason: "Latest self-improvement status validation job failed.",
      evidence: {
        jobName: "self_improvement_status_report",
        status: latestLoopStatus.status,
        startedAt: latestLoopStatus.startedAt.toISOString(),
        errorMessage: latestLoopStatus.errorMessage ?? null,
      },
      recommendedAction: "escalate",
      scope: "paper_only",
      nullFieldReasons: [],
    });
  }

  if (!heartbeat?.metadataJson) {
    return issues;
  }
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(heartbeat.metadataJson) as Record<string, unknown>;
  } catch {
    return issues;
  }
  const runtimeHealth = (metadata.runtimeHealth ?? null) as Record<string, unknown> | null;
  if (!runtimeHealth) return issues;
  const operatorHealth = (runtimeHealth.operatorHealth ?? null) as Record<string, unknown> | null;
  const readiness = (operatorHealth?.readiness ?? null) as Record<string, unknown> | null;
  const safeToAutomate = readiness?.safeToAutomate === true;
  const runtimePhase = typeof readiness?.runtimePhase === "string" ? readiness.runtimePhase : "unknown";

  if (!safeToAutomate || runtimePhase === "degraded") {
    issues.push({
      id: "runtime_unhealthy",
      type: "operational_guardrail",
      severity: runtimePhase === "degraded" ? "high" : "medium",
      confidence: "high",
      status: "open",
      botId: null,
      modelVersion: null,
      diagnosis: "runtime_unhealthy",
      reason: "Runtime readiness indicates degraded or unsafe automation state.",
      evidence: {
        runtimePhase,
        safeToAutomate: readiness?.safeToAutomate ?? null,
        operationalReadiness: readiness?.operationalReadiness ?? null,
      },
      recommendedAction: "auto_remediate",
      scope: "paper_only",
      nullFieldReasons: [],
    });
  }

  return issues;
}

export async function buildControlPlaneIssues(lookbackDays = 14): Promise<{
  generatedAt: string;
  lookbackDays: number;
  issues: ControlPlaneIssue[];
}> {
  const [botAudit, mlScorecard, experiments, operationalIssues] = await Promise.all([
    buildBotScorecards(lookbackDays),
    buildMlScorecard(lookbackDays),
    getNextEligibleExperiments(),
    buildOperationalIssues(),
  ]);

  const issues: ControlPlaneIssue[] = [];

  for (const bot of botAudit.bots) {
    const bandEntries = Object.entries(bot.byBand);
    const topBand = bandEntries.sort((a, b) => b[1].sampleSize - a[1].sampleSize)[0] ?? null;
    const topBandPct = topBand && bot.sampleSize > 0 ? topBand[1].sampleSize / bot.sampleSize : null;

    if (bot.sampleSize < ISSUE_THRESHOLDS.bot.minSample) {
      issues.push({
        id: issueId(["bot", bot.botId, "low_sample_uncertain"]),
        type: "bot_productivity",
        severity: "low",
        confidence: "high",
        status: "open",
        botId: bot.botId,
        modelVersion: null,
        diagnosis: "low_sample_uncertain",
        reason: "Bot sample size is below minimum threshold for robust productivity conclusions.",
        evidence: { sampleSize: bot.sampleSize, minSample: ISSUE_THRESHOLDS.bot.minSample },
        recommendedAction: "observe",
        scope: "paper_only",
        nullFieldReasons: bot.nullFieldReasons,
      });
      continue;
    }

    if (
      bot.avgMarkout != null &&
      bot.sampleSize >= ISSUE_THRESHOLDS.bot.highSample &&
      bot.avgMarkout <= ISSUE_THRESHOLDS.bot.negativeAvgMarkoutHigh
    ) {
      issues.push({
        id: issueId(["bot", bot.botId, "negative_expectancy"]),
        type: "bot_productivity",
        severity: "high",
        confidence: "high",
        status: "open",
        botId: bot.botId,
        modelVersion: null,
        diagnosis: "negative_expectancy",
        reason: "Average markout is negative over a sufficiently large sample.",
        evidence: {
          sampleSize: bot.sampleSize,
          avgMarkout: bot.avgMarkout,
          hitRate: bot.hitRate,
        },
        recommendedAction: "open_experiment",
        scope: "paper_only",
        nullFieldReasons: bot.nullFieldReasons,
      });
    } else if (
      bot.avgMarkout != null &&
      bot.sampleSize >= ISSUE_THRESHOLDS.bot.minSample &&
      bot.avgMarkout <= ISSUE_THRESHOLDS.bot.negativeAvgMarkoutMedium
    ) {
      issues.push({
        id: issueId(["bot", bot.botId, "negative_expectancy"]),
        type: "bot_productivity",
        severity: "medium",
        confidence: "medium",
        status: "open",
        botId: bot.botId,
        modelVersion: null,
        diagnosis: "negative_expectancy",
        reason: "Average markout is slightly negative, but evidence is moderate.",
        evidence: {
          sampleSize: bot.sampleSize,
          avgMarkout: bot.avgMarkout,
          hitRate: bot.hitRate,
        },
        recommendedAction: "observe",
        scope: "paper_only",
        nullFieldReasons: bot.nullFieldReasons,
      });
    }

    if (bot.inactivityFlag) {
      issues.push({
        id: issueId(["bot", bot.botId, "inactive_bot"]),
        type: "bot_productivity",
        severity: bot.sampleSize >= ISSUE_THRESHOLDS.bot.highSample ? "high" : "medium",
        confidence: "high",
        status: "open",
        botId: bot.botId,
        modelVersion: null,
        diagnosis: "inactive_bot",
        reason: "Bot has no recent activity within inactivity threshold.",
        evidence: { sampleSize: bot.sampleSize, inactivityFlag: bot.inactivityFlag },
        recommendedAction: "observe",
        scope: "paper_only",
        nullFieldReasons: bot.nullFieldReasons,
      });
    }

    if (bot.rankLift != null && bot.rankLift <= ISSUE_THRESHOLDS.bot.weakRankLift) {
      issues.push({
        id: issueId(["bot", bot.botId, "weak_rank_lift"]),
        type: "bot_productivity",
        severity: "medium",
        confidence: "medium",
        status: "open",
        botId: bot.botId,
        modelVersion: null,
        diagnosis: "weak_rank_lift",
        reason: "Observed challenger-vs-champion rank lift is weak or non-positive.",
        evidence: { sampleSize: bot.sampleSize, rankLift: bot.rankLift },
        recommendedAction: "open_experiment",
        scope: "paper_only",
        nullFieldReasons: bot.nullFieldReasons,
      });
    }

    if (bot.redundancyFlag) {
      issues.push({
        id: issueId(["bot", bot.botId, "redundant_bot"]),
        type: "bot_productivity",
        severity: "medium",
        confidence: "medium",
        status: "open",
        botId: bot.botId,
        modelVersion: null,
        diagnosis: "redundant_bot",
        reason: "Bot overlap indicates potentially redundant behavior relative to peers.",
        evidence: { sampleSize: bot.sampleSize, redundancyFlag: bot.redundancyFlag },
        recommendedAction: "open_experiment",
        scope: "paper_only",
        nullFieldReasons: bot.nullFieldReasons,
      });
    }

    if (topBandPct != null && topBandPct >= ISSUE_THRESHOLDS.bot.highBandConcentrationPct) {
      issues.push({
        id: issueId(["bot", bot.botId, "band_concentration_problem"]),
        type: "bot_productivity",
        severity: "medium",
        confidence: "medium",
        status: "open",
        botId: bot.botId,
        modelVersion: null,
        diagnosis: "band_concentration_problem",
        reason: "Trade distribution is overly concentrated in a single score band.",
        evidence: {
          sampleSize: bot.sampleSize,
          dominantBand: topBand?.[0] ?? null,
          dominantBandPct: topBandPct,
        },
        recommendedAction: "open_experiment",
        scope: "paper_only",
        nullFieldReasons: bot.nullFieldReasons,
      });
    }
  }

  const mlNullReasons: NullFieldReason[] = mlScorecard.nullFieldReasons;
  const bucketDelta = safeNumber(mlScorecard.bucketLift?.delta);
  const corr = mlScorecard.scoreCorrelation;
  const labelCoverage = safeNumber((mlScorecard.labelHealth as { coverage?: unknown } | null)?.coverage ?? null);
  const holdoutNoisy = (mlScorecard.driftStatus as { holdoutNoisy?: unknown } | null)?.holdoutNoisy === true;
  const challengerWouldPromote =
    (mlScorecard.challengerVsChampion as { wouldPromote?: unknown } | null)?.wouldPromote === true;

  if (corr == null || bucketDelta == null) {
    issues.push({
      id: "ml_helpfulness_unclear",
      type: "ml_effectiveness",
      severity: "low",
      confidence: "high",
      status: "open",
      botId: null,
      modelVersion: mlScorecard.modelVersion,
      diagnosis: "ml_helpfulness_unclear",
      reason: "ML helpfulness cannot be established due to missing predictive-lift evidence.",
      evidence: {
        scoreCorrelation: mlScorecard.scoreCorrelation,
        bucketLiftDelta: bucketDelta,
      },
      recommendedAction: "observe",
      scope: "paper_only",
      nullFieldReasons: mlNullReasons,
    });
  } else if (corr <= ISSUE_THRESHOLDS.ml.noLiftCorrelation && bucketDelta <= ISSUE_THRESHOLDS.ml.noLiftBucketDelta) {
    issues.push({
      id: "ml_no_predictive_lift",
      type: "ml_effectiveness",
      severity: "high",
      confidence: "high",
      status: "open",
      botId: null,
      modelVersion: mlScorecard.modelVersion,
      diagnosis: "no_predictive_lift",
      reason: "Both score correlation and bucket lift are non-positive over available sample.",
      evidence: {
        scoreCorrelation: corr,
        bucketLiftDelta: bucketDelta,
      },
      recommendedAction: "cursor_repair",
      scope: "paper_only",
      nullFieldReasons: mlNullReasons,
    });
  } else if (corr <= ISSUE_THRESHOLDS.ml.weakLiftCorrelation || bucketDelta <= ISSUE_THRESHOLDS.ml.weakLiftBucketDelta) {
    issues.push({
      id: "ml_weak_predictive_lift",
      type: "ml_effectiveness",
      severity: "medium",
      confidence: "medium",
      status: "open",
      botId: null,
      modelVersion: mlScorecard.modelVersion,
      diagnosis: "weak_predictive_lift",
      reason: "Predictive lift exists but is weak relative to conservative thresholds.",
      evidence: {
        scoreCorrelation: corr,
        bucketLiftDelta: bucketDelta,
      },
      recommendedAction: "open_experiment",
      scope: "paper_only",
      nullFieldReasons: mlNullReasons,
    });
  }

  if (labelCoverage != null && labelCoverage < ISSUE_THRESHOLDS.ml.lowLabelCoverage) {
    issues.push({
      id: "ml_low_label_coverage",
      type: "ml_effectiveness",
      severity: "high",
      confidence: "high",
      status: "open",
      botId: null,
      modelVersion: mlScorecard.modelVersion,
      diagnosis: "low_label_coverage",
      reason: "Training-label coverage is below conservative minimum threshold.",
      evidence: {
        coverage: labelCoverage,
        threshold: ISSUE_THRESHOLDS.ml.lowLabelCoverage,
      },
      recommendedAction: "auto_remediate",
      scope: "paper_only",
      nullFieldReasons: mlNullReasons,
    });
  }

  const hasCoefficients =
    (mlScorecard.featureHealth as { hasCoefficients?: unknown } | null)?.hasCoefficients === true;
  if (!hasCoefficients && mlScorecard.featureHealth != null) {
    issues.push({
      id: "ml_feature_health_problem",
      type: "ml_effectiveness",
      severity: "high",
      confidence: "high",
      status: "open",
      botId: null,
      modelVersion: mlScorecard.modelVersion,
      diagnosis: "feature_health_problem",
      reason: "Feature health indicates missing or unusable model coefficients/feature artifacts.",
      evidence: {
        featureHealth: mlScorecard.featureHealth,
      },
      recommendedAction: "cursor_repair",
      scope: "paper_only",
      nullFieldReasons: mlNullReasons,
    });
  }

  if (holdoutNoisy) {
    issues.push({
      id: "ml_drift_risk",
      type: "ml_effectiveness",
      severity: "medium",
      confidence: "medium",
      status: "open",
      botId: null,
      modelVersion: mlScorecard.modelVersion,
      diagnosis: "drift_risk",
      reason: "Holdout diagnostics indicate noisy/unstable evaluation conditions.",
      evidence: {
        driftStatus: mlScorecard.driftStatus,
      },
      recommendedAction: "open_experiment",
      scope: "paper_only",
      nullFieldReasons: mlNullReasons,
    });
  }

  if (!challengerWouldPromote) {
    issues.push({
      id: "ml_challenger_not_better",
      type: "ml_effectiveness",
      severity: "low",
      confidence: "medium",
      status: "open",
      botId: null,
      modelVersion: mlScorecard.modelVersion,
      diagnosis: "challenger_not_better",
      reason: "Current challenger does not clear promotion guardrails vs champion.",
      evidence: {
        challengerVsChampion: mlScorecard.challengerVsChampion,
      },
      recommendedAction: "observe",
      scope: "paper_only",
      nullFieldReasons: mlNullReasons,
    });
  }

  for (const exp of experiments.experiments) {
    if (!exp.eligible) {
      issues.push({
        id: issueId(["experiment", exp.id, "guardrail_blocked"]),
        type: "operational_guardrail",
        severity: "low",
        confidence: "high",
        status: "open",
        botId: null,
        modelVersion: null,
        diagnosis: "experiment_guardrail_blocked",
        reason: "Experiment is blocked by guardrails, preserving fail-closed behavior.",
        evidence: { experimentId: exp.id, reason: exp.reason },
        recommendedAction: "observe",
        scope: "paper_only",
        nullFieldReasons: [],
      });
    }
  }

  const withOperational = [...issues, ...operationalIssues];
  const sorted = withOperational
    .map((issue) => {
      const actionDecision = decideIssueAction(issue);
      return {
        ...issue,
        recommendedAction: actionDecision.action,
      };
    })
    .sort((a, b) => {
      const s = severityRank(a.severity) - severityRank(b.severity);
      if (s !== 0) return s;
      const c = confidenceRank(a.confidence) - confidenceRank(b.confidence);
      if (c !== 0) return c;
      const ae = safeNumber(a.evidence.sampleSize) ?? 0;
      const be = safeNumber(b.evidence.sampleSize) ?? 0;
      return be - ae;
    });

  return {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    issues: sorted,
  };
}

export async function getIssueById(issueIdValue: string, lookbackDays = 14): Promise<ControlPlaneIssue | null> {
  const all = await buildControlPlaneIssues(lookbackDays);
  return all.issues.find((i) => i.id === issueIdValue) ?? null;
}
