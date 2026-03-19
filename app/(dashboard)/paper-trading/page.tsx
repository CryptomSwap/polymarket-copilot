"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface EffectiveBotProfile {
  botType: string;
  displayName: string;
  enabled: boolean;
  targetLabel: string | null;
  botVersion: string | null;
  threshold: number;
  minScoreBuffer: number;
  allowReviewRequired: boolean;
  allowPaperRelaxation: boolean;
  allowRelaxationReasons: string[] | null;
  allowedPolicyStates: string[] | null;
  allowedPriceBands: string[] | null;
  excludedThemes: string[];
  excludedCategories: string[];
  cooldownHours: number;
  cooldownMarketHours: number;
  maxOpenTotal: number;
  maxOpenPerMarket: number;
  maxOpenPerTheme: number;
  maxOpenPerCategory: number;
  maxDailyNewTrades: number;
  notes: string | null;
  effectiveEnabled: boolean;
  overrideSource?: "env" | null;
}

interface BotAnalyticsSummary {
  botType: string;
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  averagePnlPct: number | null;
  medianPnlPct: number | null;
  cumulativePnlPct: number | null;
  averageScore: number | null;
  averageThresholdGap: number | null;
  byEntryPriceBand: Record<string, number>;
  byPaperPolicyMode: Record<string, number>;
  byPaperRelaxationReason: Record<string, number>;
  byTheme: Record<string, number>;
  byCategory: Record<string, number>;
  byTargetLabel: Record<string, number>;
  byBotVersion: Record<string, number>;
  byProfileSnapshot: Record<string, number>;
  byChallengerAvailable?: Record<string, number>;
  byChampionModelRunId?: Record<string, number>;
  byChallengerModelRunId?: Record<string, number>;
  byChallengerScoreDeltaBucket?: Record<string, number>;
}

interface BotOverlapPair {
  botA: string;
  botB: string;
  sameMarketCount: number;
  sameAssetSideCount: number;
}

interface Summary {
  totalPaperTrades: number;
  openTrades: number;
  closedTrades: number;
  winRate: number | null;
  winCount: number;
  lossCount: number;
  averagePnlPct: number | null;
  cumulativePnlPct: number | null;
  averageScoreOfOpened: number | null;
  averageHoldTimeHours: number | null;
  pnlDistribution: { winCount: number; lossCount: number; flatCount: number; buckets: { min: number; max: number; count: number }[] };
  pnlByPolicyMode?: {
    normal: { count: number; winCount: number; lossCount: number; averagePnlPct: number | null; cumulativePnlPct: number | null };
    relaxed_block_candidate: { count: number; winCount: number; lossCount: number; averagePnlPct: number | null; cumulativePnlPct: number | null };
  };
  currentModelRunId: string | null;
  threshold: number;
  enabled: boolean;
}

interface Trade {
  id: string;
  modelRunId: string;
  championModelRunId?: string | null;
  challengerModelRunId?: string | null;
  marketId: string;
  assetId: string;
  side: string;
  score: number;
  championScore?: number | null;
  challengerScore?: number | null;
  challengerScoreDelta?: number | null;
  challengerAvailable?: boolean | null;
  threshold: number;
  entryPrice: string;
  entryTime: string;
  intendedSize: string;
  status: string;
  exitPrice?: string | null;
  exitTime?: string | null;
  markout12h?: string | null;
  pnlPct?: string | null;
  createdAt: string;
  // Optional exploration provenance if present in APIs (paper-only allocator).
  explorationAdmissionMode?: string | null;
  explorationBand?: string | null;
  explorationAllocatorVersion?: string | null;
}

interface EquityPoint {
  date: string;
  cumulativePnlPct: number;
}

interface Diagnostics {
  paperTradingEnabled: boolean;
  currentThreshold: number;
  cooldownHours: number;
  cooldownMarketHours: number;
  minScoreBuffer: number;
  maxOpenTotal: number;
  maxOpenPerMarket: number;
  maxOpenPerTheme: number;
  maxOpenPerCategory: number;
  maxDailyNewTrades: number;
  lastOpenTickAt: string | null;
  lastOpenTickResult: Record<string, unknown> | null;
  lastOpenTickError: string | null;
  lastTickCandidatesLoaded: number | null;
  lastTickCandidatesScored: number | null;
  lastTickMaxScore: number | null;
  lastTickAvgScore: number | null;
  lastTickAboveThresholdCount: number | null;
  lastTickRejectedByCooldownCount: number | null;
  lastTickRejectedByRiskLimitCount: number | null;
  lastTickTopCandidateScores: { assetId: string; side: string; score: number }[];
  lastTickLoadDiagnostics: Record<string, unknown> | null;
  lastTickZeroCandidatesReason: string | null;
  lastTickSampleSnapshotCheck: { recommendationId: string; funderUsed: string; snapshotExists: boolean; snapshotFunderAddresses?: string[] }[] | null;
  lastTickPolicyStateCounts: Record<string, number> | null;
  lastTickFilteredByPolicyStateCount: number | null;
  lastTickAvoidedCount: number | null;
  lastTickAllowedCount: number | null;
  lastTickZeroSizeAfterPolicyCount: number | null;
  lastTickSampleFilteredByPolicy: { recommendationId: string; policyState: string; finalSuggestedSize: string; reason: string }[] | null;
  lastTickRelaxedBlockedCount: number | null;
  lastTickRelaxedByReasonCounts: Record<string, number> | null;
  lastTickCandidatesPassedViaRelaxation: number | null;
  lastTickBlockedCandidatesSeen?: number | null;
  lastTickPaperRelaxationEligible?: number | null;
  lastTickPaperRelaxationRejected?: number | null;
  lastTickPaperRelaxationAccepted_edgeTooSmall?: number | null;
  lastTickPaperRelaxationAccepted_liquidityTooLow?: number | null;
  lastTickPaperRelaxationAccepted_multiAllowed?: number | null;
  lastTickScoredAfterRelaxation?: number | null;
  lastTickPaperTradesCreatedFromRelaxation?: number | null;
  lastTickRelaxedScoredSuccessfully?: number | null;
  lastTickRelaxedOpenedTrades?: number | null;
  lastTickRelaxedCandidatesConsidered?: number | null;
  lastTickRelaxedDropped_actionTypeAvoid?: number | null;
  lastTickRelaxedDropped_actionTypeSyncFirst?: number | null;
  lastTickRelaxedDropped_missingAssetResolution?: number | null;
  lastTickRelaxedDropped_missingSide?: number | null;
  lastTickRelaxedDropped_missingPriceContext?: number | null;
  lastTickRelaxedDropped_other?: number | null;
  lastTickRelaxedBuiltSuccessfully?: number | null;
  paperTradeCountByPolicyMode?: { normal: number; relaxed_block_candidate: number };
  relaxedTradeCountByReason?: Record<string, number>;
  lastCloseTickAt: string | null;
  lastCloseTickResult: Record<string, unknown> | null;
  lastCloseTickError: string | null;
  activeTargetLabel: string | null;
  modelRunId: string | null;
  tradeOpenRate24h: number;
  closeRate24h: number;
  lastTickPerBotSummary?: Record<
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
  > | null;
}

interface ProfileRevision {
  id: string;
  botType: string;
  revisionKey: string;
  status: "DRAFT" | "STAGED" | "ACTIVE" | "ARCHIVED" | string;
  targetLabel: string | null;
  profileSnapshotJson: string;
  notes: string | null;
  promotedAt: string | null;
  rollbackTargetRevision: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProfileModelLink {
  id: string;
  botType: string;
  profileRevisionId: string;
  modelRunId: string;
  linkageRole: "EVALUATED_WITH" | "INTENDED_ACTIVE" | "ROLLBACK_TARGET" | string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BotControlSummary {
  botType: string;
  thresholdAdmissions: number;
  explorationAdmissions: number;
  challengerCoverageCount: number;
  challengerCoveragePct: number | null;
  budgetRank: number | null;
  budgetWeight: number | null;
  maxNewTradesToday: number | null;
  lastTickOpened: number | null;
  lastTickRejectedByBudgetCount: number | null;
  constrainedByBudget: boolean | null;
  budgetReasonSummary: string | null;
}

interface BotBudgetDecision {
  botType: string;
  rank: number;
  budgetWeight: number;
  maxNewTradesToday: number;
  reasonSummary: string;
  allocatorVersion: string;
  metrics: {
    lookbackDays: number;
    closedTrades: number;
    winRate: number | null;
    averagePnlPct: number | null;
    cumulativePnlPct: number | null;
    medianPnlPct: number | null;
    overlapScore: number;
    enabled: boolean;
  };
}

export default function PaperTradingPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [openTrades, setOpenTrades] = useState<Trade[]>([]);
  const [recentClosed, setRecentClosed] = useState<Trade[]>([]);
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [tickLoading, setTickLoading] = useState(false);
  const [closeLoading, setCloseLoading] = useState(false);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotsMessage, setSnapshotsMessage] = useState<string | null>(null);
  const [blockReportOpen, setBlockReportOpen] = useState(false);
  const [blockReport, setBlockReport] = useState<{
    byPolicyState: Record<string, number>;
    byCategory: Record<string, number>;
    byBlockReason: Record<string, number>;
    liquidityRelatedCount: number;
    riskRelatedCount: number;
    portfolioThemeConcentrationCount: number;
    missingOrQualityCount: number;
    sampleBlocked: { recommendationId: string; policyState: string; finalSuggestedSize: string; blockReason: string | null; category: string }[];
  } | null>(null);
  const [blockReportLoading, setBlockReportLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [modelRunFilter, setModelRunFilter] = useState<string>("");
  const [modelRuns, setModelRuns] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [botTypeFilter, setBotTypeFilter] = useState<string>("");

  const [profiles, setProfiles] = useState<EffectiveBotProfile[]>([]);
  const [botAnalytics, setBotAnalytics] = useState<BotAnalyticsSummary[]>([]);
  const [overlap, setOverlap] = useState<BotOverlapPair[]>([]);
  const [selectedBotType, setSelectedBotType] = useState<string | null>(null);
  const [selectedBotEquity, setSelectedBotEquity] = useState<EquityPoint[]>([]);
  const [selectedBotTrades, setSelectedBotTrades] = useState<Trade[]>([]);
  const [selectedBotExplorationFilter, setSelectedBotExplorationFilter] = useState<
    "all" | "exploration_only" | "challenger_only"
  >("all");
  const [botBudgets, setBotBudgets] = useState<BotBudgetDecision[]>([]);
  const [botBudgetFlagEnabled, setBotBudgetFlagEnabled] = useState<boolean | null>(null);
  const [profileRevisions, setProfileRevisions] = useState<ProfileRevision[]>([]);
  const [revisionForm, setRevisionForm] = useState<{
    status: "DRAFT" | "STAGED";
    revisionKey: string;
    notes: string;
    rollbackTargetRevision: string;
    submitting: boolean;
    error: string | null;
  }>({
    status: "DRAFT",
    revisionKey: "",
    notes: "",
    rollbackTargetRevision: "",
    submitting: false,
    error: null,
  });
  const [profileModelLinks, setProfileModelLinks] = useState<ProfileModelLink[]>([]);
  const [linkageForm, setLinkageForm] = useState<{
    botType: string;
    profileRevisionId: string;
    modelRunId: string;
    linkageRole: "EVALUATED_WITH" | "INTENDED_ACTIVE" | "ROLLBACK_TARGET";
    notes: string;
    submitting: boolean;
    error: string | null;
    success: string | null;
  }>({
    botType: "",
    profileRevisionId: "",
    modelRunId: "",
    linkageRole: "EVALUATED_WITH",
    notes: "",
    submitting: false,
    error: null,
    success: null,
  });
  const [controlSummary, setControlSummary] = useState<BotControlSummary[]>([]);

  const queryParams = useCallback(() => {
    const p = new URLSearchParams();
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    if (modelRunFilter) p.set("modelRunId", modelRunFilter);
    return p.toString();
  }, [dateFrom, dateTo, modelRunFilter]);

  const fetchData = useCallback(async () => {
    const q = queryParams();
    const suffix = q ? `?${q}` : "";
    const withLimit = q ? `?limit=30&${q}` : "?limit=30";
    const withPoints = q ? `?points=80&${q}` : "?points=80";
    try {
      const [summaryRes, openRes, tradesRes, equityRes, diagRes, profilesRes, botsRes, overlapRes, budgetsRes, revisionsRes, linksRes, controlRes] =
        await Promise.all([
        fetch(`/api/paper-trading/summary${suffix}`),
        fetch("/api/paper-trading/open"),
        fetch(`/api/paper-trading/trades${withLimit}`),
        fetch(`/api/paper-trading/equity${withPoints}`),
        fetch("/api/paper-trading/diagnostics"),
        fetch("/api/paper-trading/profiles"),
        fetch(`/api/paper-trading/by-bot${suffix ? `?${q}` : ""}`),
        fetch(`/api/paper-trading/overlap${suffix}`),
        fetch("/api/paper-trading/bot-budgets"),
        fetch("/api/paper-trading/profile-revisions"),
        fetch("/api/paper-trading/profile-model-links"),
        fetch("/api/paper-trading/control-summary"),
      ]);
      if (summaryRes.ok) setSummary(await summaryRes.json());
      else setSummary(null);
      if (openRes.ok) {
        const j = await openRes.json();
        setOpenTrades(j.trades ?? []);
      } else setOpenTrades([]);
      if (tradesRes.ok) {
        const j = await tradesRes.json();
        const trades = j.trades ?? [];
        setRecentClosed(trades.filter((t: Trade) => t.status === "closed"));
        const runs = [...new Set(trades.map((t: Trade) => t.modelRunId))].filter(Boolean) as string[];
        setModelRuns(runs);
      } else setRecentClosed([]);
      if (equityRes.ok) {
        const j = await equityRes.json();
        setEquityCurve(j.equityCurve ?? []);
      } else setEquityCurve([]);
      if (diagRes.ok) setDiagnostics(await diagRes.json());
      else setDiagnostics(null);
      if (profilesRes.ok) {
        const j = await profilesRes.json();
        setProfiles(j.profiles ?? []);
      } else setProfiles([]);
      if (botsRes.ok) {
        const j = await botsRes.json();
        setBotAnalytics(j.bots ?? []);
      } else setBotAnalytics([]);
      if (overlapRes.ok) {
        const j = await overlapRes.json();
        setOverlap(j.overlap ?? []);
      } else setOverlap([]);
      if (budgetsRes.ok) {
        const j = await budgetsRes.json();
        setBotBudgets(j.budgets ?? []);
        setBotBudgetFlagEnabled(j.featureFlagEnabled ?? null);
      } else {
        setBotBudgets([]);
        setBotBudgetFlagEnabled(null);
      }
      if (revisionsRes.ok) {
        const j = await revisionsRes.json();
        setProfileRevisions(j.revisions ?? []);
      } else {
        setProfileRevisions([]);
      }
      if (linksRes.ok) {
        const j = await linksRes.json();
        setProfileModelLinks(j.links ?? []);
      } else {
        setProfileModelLinks([]);
      }
      if (controlRes.ok) {
        const j = await controlRes.json();
        setControlSummary(j.bots ?? []);
      } else {
        setControlSummary([]);
      }
    } catch {
      setSummary(null);
      setOpenTrades([]);
      setRecentClosed([]);
      setEquityCurve([]);
      setDiagnostics(null);
      setBotBudgets([]);
      setBotBudgetFlagEnabled(null);
      setProfileRevisions([]);
      setProfileModelLinks([]);
      setControlSummary([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData, queryParams]);

  // Selected bot drilldown: equity + trades
  useEffect(() => {
    async function loadBotDrilldown() {
      if (!selectedBotType) {
        setSelectedBotEquity([]);
        setSelectedBotTrades([]);
        return;
      }
      const q = queryParams();
      const base = q ? `${q}&botType=${selectedBotType}` : `botType=${selectedBotType}`;
      const equityUrl = `/api/paper-trading/equity?points=80&${base}`;
      const tradesUrl = `/api/paper-trading/trades?limit=50&status=closed&${base}`;
      try {
        const [eqRes, trRes] = await Promise.all([fetch(equityUrl), fetch(tradesUrl)]);
        if (eqRes.ok) {
          const j = await eqRes.json();
          setSelectedBotEquity(j.equityCurve ?? []);
        } else setSelectedBotEquity([]);
        if (trRes.ok) {
          const j = await trRes.json();
          setSelectedBotTrades(j.trades ?? []);
        } else setSelectedBotTrades([]);
      } catch {
        setSelectedBotEquity([]);
        setSelectedBotTrades([]);
      }
    }
    loadBotDrilldown();
  }, [selectedBotType, queryParams]);

  useEffect(() => {
    if (!blockReportOpen || blockReport != null) return;
    setBlockReportLoading(true);
    fetch("/api/decision/block-report")
      .then((r) => r.json())
      .then((d) => {
        if (d.byPolicyState != null) setBlockReport(d);
      })
      .catch(() => setBlockReport(null))
      .finally(() => setBlockReportLoading(false));
  }, [blockReportOpen, blockReport]);

  const runTick = async () => {
    setTickLoading(true);
    try {
      await fetch("/api/paper-trading/tick", { method: "POST" });
      await fetchData();
    } finally {
      setTickLoading(false);
    }
  };

  const runCloseDue = async () => {
    setCloseLoading(true);
    try {
      await fetch("/api/paper-trading/close-due", { method: "POST" });
      await fetchData();
    } finally {
      setCloseLoading(false);
    }
  };

  const ensureDecisionSnapshots = async () => {
    setSnapshotsMessage(null);
    setSnapshotsLoading(true);
    try {
      const res = await fetch("/api/paper-trading/ensure-decision-snapshots", {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      await fetchData();
      if (data.success) {
        setSnapshotsMessage(
          `Snapshots created: ${data.snapshotsUpserted ?? 0} (funder: ${data.funderAddress ?? "—"})`
        );
      } else {
        setSnapshotsMessage(data.error ?? "Request failed.");
      }
    } catch (e) {
      setSnapshotsMessage(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setSnapshotsLoading(false);
    }
  };

  const filteredClosed =
    statusFilter === "closed" || statusFilter === "all"
      ? recentClosed.filter(
          (t) =>
            (!modelRunFilter || t.modelRunId === modelRunFilter) &&
            (!botTypeFilter || (t as any).botType === botTypeFilter)
        )
      : [];
  const filteredOpen =
    statusFilter === "open" || statusFilter === "all"
      ? openTrades.filter(
          (t) =>
            (!modelRunFilter || t.modelRunId === modelRunFilter) &&
            (!botTypeFilter || (t as any).botType === botTypeFilter)
        )
      : [];

  const filteredSelectedBotTrades = selectedBotTrades.filter((t) => {
    if (selectedBotExplorationFilter === "exploration_only") {
      return (
        t.explorationAdmissionMode &&
        t.explorationAdmissionMode !== "legacy_threshold_only"
      );
    }
    if (selectedBotExplorationFilter === "challenger_only") {
      return t.challengerAvailable === true;
    }
    return true;
  });

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Paper trading
        </h2>
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Paper trading
        </h2>
        <p className="text-muted-foreground">
          Shadow-ML paper trades (no real orders). Opens when score ≥ threshold;
          closes after 12h with markout.
        </p>
        {botBudgetFlagEnabled !== null && (
          <p className="text-xs text-muted-foreground mt-1">
            Bot budget allocator v1:{" "}
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                botBudgetFlagEnabled
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {botBudgetFlagEnabled ? "enabled (paper-only)" : "disabled"}
            </span>
          </p>
        )}
      </div>

      {/* Headline cards */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4 lg:grid-cols-8">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total trades
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {summary?.totalPaperTrades ?? 0}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Open
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {summary?.openTrades ?? 0}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Closed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {summary?.closedTrades ?? 0}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Win rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {summary?.winRate != null
                ? `${(summary.winRate * 100).toFixed(1)}%`
                : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Avg PnL %
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className={cn(
                "text-2xl font-semibold tabular-nums",
                summary?.averagePnlPct != null && summary.averagePnlPct >= 0
                  ? "text-green-600 dark:text-green-500"
                  : summary?.averagePnlPct != null
                    ? "text-red-600 dark:text-red-500"
                    : ""
              )}
            >
              {summary?.averagePnlPct != null
                ? `${(summary.averagePnlPct * 100).toFixed(2)}%`
                : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Cumulative PnL %
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className={cn(
                "text-2xl font-semibold tabular-nums",
                summary?.cumulativePnlPct != null && summary.cumulativePnlPct >= 0
                  ? "text-green-600 dark:text-green-500"
                  : summary?.cumulativePnlPct != null
                    ? "text-red-600 dark:text-red-500"
                    : ""
              )}
            >
              {summary?.cumulativePnlPct != null
                ? `${(summary.cumulativePnlPct * 100).toFixed(2)}%`
                : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Threshold
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {summary?.threshold != null ? summary.threshold : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Model run
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-mono truncate" title={summary?.currentModelRunId ?? undefined}>
              {summary?.currentModelRunId
                ? `${summary.currentModelRunId.slice(0, 8)}…`
                : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Avg score (opened)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {summary?.averageScoreOfOpened != null
                ? summary.averageScoreOfOpened.toFixed(3)
                : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Avg hold (hours)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {summary?.averageHoldTimeHours != null
                ? summary.averageHoldTimeHours.toFixed(1)
                : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Wins / Losses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {(summary?.winCount ?? 0)} / {(summary?.lossCount ?? 0)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Diagnostics */}
      <Card>
        <CardHeader>
          <CardTitle>Diagnostics</CardTitle>
          <CardDescription>
            Paper trading status, risk limits, last tick times, and model info.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div><strong>Paper trading enabled:</strong> {diagnostics?.paperTradingEnabled === true ? "Yes" : "No"}</div>
            <div><strong>Current threshold:</strong> {diagnostics?.currentThreshold ?? "—"}</div>
            <div><strong>Cooldown (hours):</strong> {diagnostics?.cooldownHours ?? "—"}</div>
            <div><strong>Cooldown market (hours):</strong> {diagnostics?.cooldownMarketHours ?? "—"}</div>
            <div><strong>Min score buffer:</strong> {diagnostics?.minScoreBuffer ?? "—"}</div>
            <div><strong>Max open total:</strong> {diagnostics?.maxOpenTotal ?? "—"}</div>
            <div><strong>Max open per market:</strong> {diagnostics?.maxOpenPerMarket ?? "—"}</div>
            <div><strong>Max open per theme:</strong> {diagnostics?.maxOpenPerTheme ?? "—"}</div>
            <div><strong>Max open per category:</strong> {diagnostics?.maxOpenPerCategory ?? "—"}</div>
            <div><strong>Max daily new trades:</strong> {diagnostics?.maxDailyNewTrades ?? "—"}</div>
            <div><strong>Last open tick:</strong> {diagnostics?.lastOpenTickAt ? new Date(diagnostics.lastOpenTickAt).toLocaleString() : "—"}</div>
            <div><strong>Last close tick:</strong> {diagnostics?.lastCloseTickAt ? new Date(diagnostics.lastCloseTickAt).toLocaleString() : "—"}</div>
            <div><strong>Latest model run:</strong> <span className="font-mono">{diagnostics?.modelRunId ? `${diagnostics.modelRunId.slice(0, 8)}…` : "—"}</span></div>
            <div><strong>Active target label:</strong> {diagnostics?.activeTargetLabel ?? "—"}</div>
            <div><strong>Trades opened (24h):</strong> {diagnostics?.tradeOpenRate24h ?? "—"}</div>
            <div><strong>Trades closed (24h):</strong> {diagnostics?.closeRate24h ?? "—"}</div>
          </div>
          {/* Last tick debug */}
          <div className="rounded border border-border bg-muted/30 p-3 text-sm space-y-2">
            <p className="font-medium">Last tick debug</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div><span className="text-muted-foreground">Candidates loaded:</span> {diagnostics?.lastTickCandidatesLoaded ?? "—"}</div>
              <div><span className="text-muted-foreground">Candidates scored:</span> {diagnostics?.lastTickCandidatesScored ?? "—"}</div>
              <div><span className="text-muted-foreground">Max score:</span> {diagnostics?.lastTickMaxScore != null ? diagnostics.lastTickMaxScore.toFixed(3) : "—"}</div>
              <div><span className="text-muted-foreground">Avg score:</span> {diagnostics?.lastTickAvgScore != null ? diagnostics.lastTickAvgScore.toFixed(3) : "—"}</div>
              <div><span className="text-muted-foreground">Above threshold:</span> {diagnostics?.lastTickAboveThresholdCount ?? "—"}</div>
              <div><span className="text-muted-foreground">Rejected (cooldown):</span> {diagnostics?.lastTickRejectedByCooldownCount ?? "—"}</div>
              <div><span className="text-muted-foreground">Rejected (risk limit):</span> {diagnostics?.lastTickRejectedByRiskLimitCount ?? "—"}</div>
            </div>
            {(diagnostics?.lastTickZeroCandidatesReason ?? "") !== "" && (
              <p><span className="text-muted-foreground">Why 0 candidates:</span> <code className="text-xs bg-muted px-1 rounded">{diagnostics?.lastTickZeroCandidatesReason}</code></p>
            )}
            {diagnostics?.lastTickLoadDiagnostics && (diagnostics.lastTickCandidatesLoaded === 0) && (
              <p className="text-muted-foreground text-xs">
                Recs: {String(diagnostics.lastTickLoadDiagnostics.recommendationsFound)} · No snapshot: {String(diagnostics.lastTickLoadDiagnostics.noDecisionSnapshot)} · After policy: {String(diagnostics.lastTickLoadDiagnostics.afterPolicyFilter)} · No asset: {String(diagnostics.lastTickLoadDiagnostics.noAssetResolve)} · Zero size: {String(diagnostics.lastTickLoadDiagnostics.zeroSizeBuy)}
              </p>
            )}
            {diagnostics?.lastTickSampleSnapshotCheck && diagnostics.lastTickSampleSnapshotCheck.length > 0 && (
              <div className="text-xs space-y-1">
                <p className="text-muted-foreground font-medium">Snapshot match sample (funder used vs snapshots that exist):</p>
                <ul className="list-disc list-inside space-y-0.5 font-mono">
                  {diagnostics.lastTickSampleSnapshotCheck.map((s, i) => (
                    <li key={i}>
                      rec {s.recommendationId.slice(-8)} · looked up with <code className="bg-muted px-0.5">{s.funderUsed.slice(0, 10)}…</code>
                      {s.snapshotFunderAddresses && s.snapshotFunderAddresses.length > 0 ? (
                        <> · snapshots exist for: {s.snapshotFunderAddresses.map((f) => `${f.slice(0, 10)}…`).join(", ")}</>
                      ) : (
                        <> · no snapshots for this rec</>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(diagnostics?.lastTickPolicyStateCounts != null || diagnostics?.lastTickFilteredByPolicyStateCount != null) && (
              <div className="text-xs space-y-1">
                <p className="text-muted-foreground font-medium">Policy filter:</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-0.5">
                  {diagnostics?.lastTickFilteredByPolicyStateCount != null && (
                    <div>Filtered by state: <span className="font-mono">{diagnostics.lastTickFilteredByPolicyStateCount}</span></div>
                  )}
                  {diagnostics?.lastTickAvoidedCount != null && (
                    <div>Avoided (avoid/sync_first): <span className="font-mono">{diagnostics.lastTickAvoidedCount}</span></div>
                  )}
                  {diagnostics?.lastTickAllowedCount != null && (
                    <div>Allowed (after policy): <span className="font-mono">{diagnostics.lastTickAllowedCount}</span></div>
                  )}
                  {diagnostics?.lastTickZeroSizeAfterPolicyCount != null && (
                    <div>Zero size (BUY): <span className="font-mono">{diagnostics.lastTickZeroSizeAfterPolicyCount}</span></div>
                  )}
                </div>
                {diagnostics?.lastTickPolicyStateCounts && Object.keys(diagnostics.lastTickPolicyStateCounts).length > 0 && (
                  <p className="text-muted-foreground mt-1">By policyState: {Object.entries(diagnostics.lastTickPolicyStateCounts).map(([k, v]) => `${k}=${v}`).join(", ")}</p>
                )}
              </div>
            )}
            {(diagnostics?.lastTickRelaxedBlockedCount != null || diagnostics?.lastTickBlockedCandidatesSeen != null) && (
              <div className="text-xs space-y-1">
                <p className="text-muted-foreground font-medium">Paper-only relaxation (paper_relax_v1):</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-0.5">
                  {diagnostics?.lastTickBlockedCandidatesSeen != null && <div>BLOCK seen: <span className="font-mono">{diagnostics.lastTickBlockedCandidatesSeen}</span></div>}
                  {diagnostics?.lastTickPaperRelaxationEligible != null && <div>Eligible: <span className="font-mono">{diagnostics.lastTickPaperRelaxationEligible}</span></div>}
                  {diagnostics?.lastTickPaperRelaxationRejected != null && <div>Rejected: <span className="font-mono">{diagnostics.lastTickPaperRelaxationRejected}</span></div>}
                  {diagnostics?.lastTickRelaxedBlockedCount != null && <div>Accepted (total): <span className="font-mono">{diagnostics.lastTickRelaxedBlockedCount}</span></div>}
                  {diagnostics?.lastTickPaperRelaxationAccepted_edgeTooSmall != null && <div>Accepted (edge): <span className="font-mono">{diagnostics.lastTickPaperRelaxationAccepted_edgeTooSmall}</span></div>}
                  {diagnostics?.lastTickPaperRelaxationAccepted_liquidityTooLow != null && <div>Accepted (liq): <span className="font-mono">{diagnostics.lastTickPaperRelaxationAccepted_liquidityTooLow}</span></div>}
                  {diagnostics?.lastTickPaperRelaxationAccepted_multiAllowed != null && <div>Accepted (multi): <span className="font-mono">{diagnostics.lastTickPaperRelaxationAccepted_multiAllowed}</span></div>}
                  {diagnostics?.lastTickScoredAfterRelaxation != null && <div>Scored (relaxed): <span className="font-mono">{diagnostics.lastTickScoredAfterRelaxation}</span></div>}
                  {diagnostics?.lastTickPaperTradesCreatedFromRelaxation != null && <div>Opened (relaxed): <span className="font-mono">{diagnostics.lastTickPaperTradesCreatedFromRelaxation}</span></div>}
                </div>
                {(diagnostics?.lastTickRelaxedCandidatesConsidered != null || diagnostics?.lastTickRelaxedBuiltSuccessfully != null) && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-0.5 mt-1">
                    {diagnostics?.lastTickRelaxedCandidatesConsidered != null && <div>Relaxed considered: <span className="font-mono">{diagnostics.lastTickRelaxedCandidatesConsidered}</span></div>}
                    {diagnostics?.lastTickRelaxedBuiltSuccessfully != null && <div>Relaxed built: <span className="font-mono">{diagnostics.lastTickRelaxedBuiltSuccessfully}</span></div>}
                    {diagnostics?.lastTickRelaxedDropped_missingAssetResolution != null && diagnostics.lastTickRelaxedDropped_missingAssetResolution > 0 && <div>Dropped (no asset): <span className="font-mono">{diagnostics.lastTickRelaxedDropped_missingAssetResolution}</span></div>}
                    {diagnostics?.lastTickRelaxedDropped_missingSide != null && diagnostics.lastTickRelaxedDropped_missingSide > 0 && <div>Dropped (no side): <span className="font-mono">{diagnostics.lastTickRelaxedDropped_missingSide}</span></div>}
                    {diagnostics?.lastTickRelaxedDropped_missingPriceContext != null && diagnostics.lastTickRelaxedDropped_missingPriceContext > 0 && <div>Dropped (no price): <span className="font-mono">{diagnostics.lastTickRelaxedDropped_missingPriceContext}</span></div>}
                    {diagnostics?.lastTickRelaxedDropped_other != null && diagnostics.lastTickRelaxedDropped_other > 0 && <div>Dropped (other): <span className="font-mono">{diagnostics.lastTickRelaxedDropped_other}</span></div>}
                  </div>
                )}
                <p>Candidates from relaxation: <span className="font-mono">{diagnostics?.lastTickCandidatesPassedViaRelaxation ?? 0}</span></p>
                {diagnostics?.paperTradeCountByPolicyMode && (
                  <p>Total by mode: normal=<span className="font-mono">{diagnostics.paperTradeCountByPolicyMode.normal}</span> · relaxed=<span className="font-mono">{diagnostics.paperTradeCountByPolicyMode.relaxed_block_candidate}</span></p>
                )}
                {diagnostics?.lastTickRelaxedByReasonCounts && Object.keys(diagnostics.lastTickRelaxedByReasonCounts).length > 0 && (
                  <p>By reason (last tick): {Object.entries(diagnostics.lastTickRelaxedByReasonCounts).map(([r, c]) => `${r}=${c}`).join(", ")}</p>
                )}
                {diagnostics?.relaxedTradeCountByReason && Object.keys(diagnostics.relaxedTradeCountByReason).length > 0 && (
                  <p>Relaxed trades by reason (DB): {Object.entries(diagnostics.relaxedTradeCountByReason).map(([r, c]) => `${r}=${c}`).join(", ")}</p>
                )}
              </div>
            )}
            {diagnostics?.lastTickSampleFilteredByPolicy && diagnostics.lastTickSampleFilteredByPolicy.length > 0 && (
              <div className="text-xs space-y-1">
                <p className="text-muted-foreground font-medium">Sample filtered by policy (first 5):</p>
                <ul className="list-disc list-inside space-y-0.5 font-mono">
                  {diagnostics.lastTickSampleFilteredByPolicy.map((s, i) => (
                    <li key={i}>rec {s.recommendationId.slice(-8)} · {s.policyState} · size={s.finalSuggestedSize} · {s.reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {diagnostics?.lastTickZeroCandidatesReason === "filtering_removed_all_policy_or_avoid" && (
              <p className="text-sm text-amber-600 dark:text-amber-400 pt-1">
                All candidates removed by policy (state not allowed or avoid/sync_first). Set <code className="bg-muted px-0.5">PAPER_TRADING_ALLOW_REVIEW_REQUIRED=1</code> to include REVIEW_REQUIRED. Use &quot;Block report&quot; below to see why snapshots are BLOCK.
              </p>
            )}
            {diagnostics?.lastTickTopCandidateScores && diagnostics.lastTickTopCandidateScores.length > 0 && (
              <div>
                <p className="text-muted-foreground text-xs mb-1">Top candidate scores:</p>
                <ul className="text-xs font-mono space-y-0.5">
                  {diagnostics.lastTickTopCandidateScores.map((s, i) => (
                    <li key={i}>{s.assetId} {s.side} {s.score.toFixed(3)}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {(diagnostics?.lastOpenTickError || diagnostics?.lastCloseTickError) && (
            <div className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-sm">
              {diagnostics?.lastOpenTickError && <p><strong>Last open tick error:</strong> {diagnostics.lastOpenTickError}</p>}
              {diagnostics?.lastCloseTickError && <p><strong>Last close tick error:</strong> {diagnostics.lastCloseTickError}</p>}
            </div>
          )}
          {(diagnostics?.lastOpenTickResult || diagnostics?.lastCloseTickResult) && (
            <details className="text-sm">
              <summary>Last tick results (JSON)</summary>
              <pre className="mt-1 p-2 rounded bg-muted overflow-auto max-h-32 text-xs">
                {JSON.stringify({ open: diagnostics?.lastOpenTickResult, close: diagnostics?.lastCloseTickResult }, null, 2)}
              </pre>
            </details>
          )}
          <details
            className="text-sm"
            open={blockReportOpen}
            onToggle={(e) => setBlockReportOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary>Block report (why recommendations are BLOCK)</summary>
            {blockReportLoading && <p className="text-muted-foreground mt-1">Loading…</p>}
            {!blockReportLoading && blockReport && (
              <div className="mt-2 space-y-2 text-xs">
                <p><span className="text-muted-foreground">By policyState:</span> {Object.entries(blockReport.byPolicyState).map(([k, v]) => `${k}=${v}`).join(", ")}</p>
                <p><span className="text-muted-foreground">By category:</span> {Object.entries(blockReport.byCategory).map(([k, v]) => `${k}=${v}`).join(", ")}</p>
                <p><span className="text-muted-foreground">Liquidity:</span> {blockReport.liquidityRelatedCount} · <span className="text-muted-foreground">Risk/theme:</span> {blockReport.riskRelatedCount} · <span className="text-muted-foreground">Missing/quality:</span> {blockReport.missingOrQualityCount ?? 0}</p>
                {Object.keys(blockReport.byBlockReason).length > 0 && (
                  <p><span className="text-muted-foreground">Top block reasons:</span> {Object.entries(blockReport.byBlockReason).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, c]) => `${r} (${c})`).join("; ")}</p>
                )}
                {blockReport.sampleBlocked.length > 0 && (
                  <div>
                    <p className="text-muted-foreground font-medium">Sample BLOCK (first 5):</p>
                    <ul className="list-disc list-inside space-y-0.5 font-mono mt-0.5">
                      {blockReport.sampleBlocked.slice(0, 5).map((s, i) => (
                        <li key={i}>rec {s.recommendationId.slice(-8)} · {s.policyState} · size={s.finalSuggestedSize} · {s.blockReason ?? "—"} · {s.category}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="text-muted-foreground">Full report: <code className="bg-muted px-0.5">GET /api/decision/block-report</code></p>
              </div>
            )}
          </details>
          {diagnostics?.lastTickZeroCandidatesReason === "filtering_removed_all_no_decision_snapshot" && (
            <p className="text-sm text-amber-600 dark:text-amber-400 pt-1">
              Recommendations exist but none have decision snapshots. Use &quot;Generate decision snapshots&quot; below, or run the decision_recompute job.
            </p>
          )}
          {snapshotsMessage != null && (
            <p className={cn("text-sm pt-1", snapshotsMessage.startsWith("Snapshots") ? "text-green-600 dark:text-green-400" : "text-destructive")}>
              {snapshotsMessage}
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={snapshotsLoading}
              onClick={ensureDecisionSnapshots}
              title="Create decision snapshots for all recommendations so paper trading has candidates"
            >
              {snapshotsLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : null}
              Generate decision snapshots
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={tickLoading}
              onClick={runTick}
            >
              {tickLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-1" />
              )}
              Run tick (score & open)
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={closeLoading}
              onClick={runCloseDue}
            >
              {closeLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : null}
              Close due (12h)
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Equity curve */}
      <Card>
        <CardHeader>
          <CardTitle>Paper equity curve</CardTitle>
          <CardDescription>
            Cumulative PnL % over time (closed trades only).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {equityCurve.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No closed trades yet. Run tick to open and close-due after 12h.
            </p>
          ) : (
            <div className="h-64 w-full">
              <EquityChart data={equityCurve} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* PnL distribution */}
      {summary?.pnlDistribution && (summary.pnlDistribution.winCount + summary.pnlDistribution.lossCount + summary.pnlDistribution.flatCount > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>PnL distribution</CardTitle>
            <CardDescription>Win / loss / flat counts and buckets (filtered by date range and model run).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-4 text-sm">
              <span>Wins: <strong>{summary.pnlDistribution.winCount}</strong></span>
              <span>Losses: <strong>{summary.pnlDistribution.lossCount}</strong></span>
              <span>Flat: <strong>{summary.pnlDistribution.flatCount}</strong></span>
            </div>
            {summary.pnlDistribution.buckets.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {summary.pnlDistribution.buckets.map((b, i) => (
                  <span key={i} className="rounded bg-muted px-2 py-1 text-xs">
                    [{b.min.toFixed(2)}%, {b.max.toFixed(2)}%): {b.count}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* PnL by paper policy mode (normal vs relaxed_block_candidate) */}
      {summary?.pnlByPolicyMode && (summary.pnlByPolicyMode.normal.count + summary.pnlByPolicyMode.relaxed_block_candidate.count > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>PnL by policy mode</CardTitle>
            <CardDescription>Normal vs relaxed (salvaged BLOCK) paper trades (closed only).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-muted-foreground font-medium">Normal</p>
                <p>Count: <span className="font-mono">{summary.pnlByPolicyMode.normal.count}</span> · Win: <span className="font-mono">{summary.pnlByPolicyMode.normal.winCount}</span> · Loss: <span className="font-mono">{summary.pnlByPolicyMode.normal.lossCount}</span></p>
                {summary.pnlByPolicyMode.normal.averagePnlPct != null && <p>Avg PnL: {(summary.pnlByPolicyMode.normal.averagePnlPct * 100).toFixed(2)}%{summary.pnlByPolicyMode.normal.cumulativePnlPct != null ? ` · Cum: ${(summary.pnlByPolicyMode.normal.cumulativePnlPct * 100).toFixed(2)}%` : ""}</p>}
              </div>
              <div>
                <p className="text-muted-foreground font-medium">Relaxed (BLOCK salvage)</p>
                <p>Count: <span className="font-mono">{summary.pnlByPolicyMode.relaxed_block_candidate.count}</span> · Win: <span className="font-mono">{summary.pnlByPolicyMode.relaxed_block_candidate.winCount}</span> · Loss: <span className="font-mono">{summary.pnlByPolicyMode.relaxed_block_candidate.lossCount}</span></p>
                {summary.pnlByPolicyMode.relaxed_block_candidate.averagePnlPct != null && <p>Avg PnL: {(summary.pnlByPolicyMode.relaxed_block_candidate.averagePnlPct * 100).toFixed(2)}%{summary.pnlByPolicyMode.relaxed_block_candidate.cumulativePnlPct != null ? ` · Cum: ${(summary.pnlByPolicyMode.relaxed_block_candidate.cumulativePnlPct * 100).toFixed(2)}%` : ""}</p>}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-center">
        <label className="text-sm font-medium">
          Date from:{" "}
          <input
            type="date"
            className="rounded border border-input bg-background px-2 py-1 text-sm"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label className="text-sm font-medium">
          Date to:{" "}
          <input
            type="date"
            className="rounded border border-input bg-background px-2 py-1 text-sm"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        <label className="text-sm font-medium">
          Status:{" "}
          <select
            className="rounded border border-input bg-background px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </label>
        <label className="text-sm font-medium">
          Model run:{" "}
          <select
            className="rounded border border-input bg-background px-2 py-1 text-sm"
            value={modelRunFilter}
            onChange={(e) => setModelRunFilter(e.target.value)}
          >
            <option value="">All</option>
            {modelRuns.map((id) => (
              <option key={id} value={id}>
                {id.slice(0, 12)}…
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">
          Bot type:{" "}
          <select
            className="rounded border border-input bg-background px-2 py-1 text-sm"
            value={botTypeFilter}
            onChange={(e) => {
              setBotTypeFilter(e.target.value);
              setSelectedBotType(e.target.value || null);
            }}
          >
            <option value="">All</option>
            {Array.from(new Set(botAnalytics.map((b) => b.botType))).map((bt) => (
              <option key={bt} value={bt}>
                {bt}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-muted-foreground">Threshold: {summary?.threshold ?? "—"}</span>
      </div>

      {/* Strategy Lab / Bot Profiles */}
      <Card>
        <CardHeader>
          <CardTitle>Bot profiles / Strategy lab</CardTitle>
          <CardDescription>
            Compare paper bots and profile revisions. Effective config values include global fallbacks and env overrides.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="py-2 px-2 text-left font-medium">Bot</th>
                  <th className="py-2 px-2 text-left font-medium">Status</th>
                  <th className="py-2 px-2 text-left font-medium">Version</th>
                  <th className="py-2 px-2 text-left font-medium">Target</th>
                  <th className="py-2 px-2 text-right font-medium">Total</th>
                  <th className="py-2 px-2 text-right font-medium">Open</th>
                  <th className="py-2 px-2 text-right font-medium">Closed</th>
                  <th className="py-2 px-2 text-right font-medium">Win rate</th>
                  <th className="py-2 px-2 text-right font-medium">Avg PnL %</th>
                  <th className="py-2 px-2 text-right font-medium">Med PnL %</th>
                  <th className="py-2 px-2 text-right font-medium">Cum PnL %</th>
                  <th className="py-2 px-2 text-right font-medium">Avg score</th>
                  <th className="py-2 px-2 text-right font-medium">Avg gap</th>
                  <th className="py-2 px-2 text-center font-medium">Exploration</th>
                  <th className="py-2 px-2 text-center font-medium">Challenger</th>
                  <th className="py-2 px-2 text-center font-medium">Budget</th>
                </tr>
              </thead>
              <tbody>
                {profiles.length === 0 ? (
                  <tr>
                    <td colSpan={16} className="py-3 px-2 text-sm text-muted-foreground">
                      No profiles configured.
                    </td>
                  </tr>
                ) : (
                  profiles.map((p) => {
                    const stats = botAnalytics.find((b) => b.botType === p.botType);
                    const totalTrades = stats?.totalTrades ?? 0;
                    const explorationTrades =
                      stats?.byPaperPolicyMode?.["explore_uncertain"] ??
                      stats?.byPaperPolicyMode?.["explore_under_sampled_segment"] ??
                      0;
                    const challengerCounts = stats?.byChallengerAvailable ?? {};
                    const challengerTrue = challengerCounts["true"] ?? 0;
                    const budget = botBudgets.find((b) => b.botType === p.botType);
                    const revisionsForBot = profileRevisions.filter(
                      (r) => r.botType === p.botType
                    );
                    const activeRev = revisionsForBot.find((r) => r.status === "ACTIVE");
                    const linksForBot = profileModelLinks.filter(
                      (l) => l.botType === p.botType
                    );
                    const intendedLinksForActive =
                      activeRev
                        ? linksForBot
                            .filter(
                              (l) =>
                                l.profileRevisionId === activeRev.id &&
                                l.linkageRole === "INTENDED_ACTIVE"
                            )
                            .sort(
                              (a, b) =>
                                new Date(a.createdAt).getTime() -
                                new Date(b.createdAt).getTime()
                            )
                        : [];
                    const latestIntendedForActive =
                      intendedLinksForActive[intendedLinksForActive.length - 1];
                    const isSelected = selectedBotType === p.botType;
                    return (
                      <tr
                        key={p.botType}
                        className={cn(
                          "border-b border-border/50 hover:bg-muted/40 cursor-pointer",
                          isSelected && "bg-muted/60"
                        )}
                        onClick={() => setSelectedBotType(p.botType)}
                      >
                        <td className="py-2 px-2">
                          <div className="flex flex-col">
                            <span className="font-medium">{p.displayName}</span>
                            <span className="text-xs text-muted-foreground font-mono">
                              {p.botType}
                            </span>
                          </div>
                        </td>
                        <td className="py-2 px-2">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                              p.effectiveEnabled
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : "bg-red-500/10 text-red-600 dark:text-red-400"
                            )}
                          >
                            {p.effectiveEnabled ? "Enabled" : "Disabled"}
                            {p.overrideSource && (
                              <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                                {p.overrideSource}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-sm font-mono">
                          {p.botVersion ?? "—"}
                        </td>
                        <td className="py-2 px-2 text-sm font-mono">
                          {p.targetLabel ?? "—"}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {stats?.totalTrades ?? 0}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {stats?.openTrades ?? 0}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {stats?.closedTrades ?? 0}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {stats?.winRate != null
                            ? `${(stats.winRate * 100).toFixed(1)}%`
                            : "—"}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {stats?.averagePnlPct != null
                            ? `${(stats.averagePnlPct * 100).toFixed(2)}%`
                            : "—"}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {stats?.medianPnlPct != null
                            ? `${(stats.medianPnlPct * 100).toFixed(2)}%`
                            : "—"}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {stats?.cumulativePnlPct != null
                            ? `${(stats.cumulativePnlPct * 100).toFixed(2)}%`
                            : "—"}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {stats?.averageScore != null
                            ? stats.averageScore.toFixed(3)
                            : "—"}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {stats?.averageThresholdGap != null
                            ? stats.averageThresholdGap.toFixed(3)
                            : "—"}
                        </td>
                        <td className="py-2 px-2 text-center">
                          <div className="flex flex-col items-center gap-0.5">
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                                explorationTrades > 0
                                  ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
                                  : "bg-muted text-muted-foreground"
                              )}
                            >
                              {p.allowPaperRelaxation ? "Exploration enabled" : "Threshold only"}
                            </span>
                            {explorationTrades > 0 && totalTrades > 0 && (
                              <span className="text-[10px] text-muted-foreground tabular-nums">
                                {explorationTrades}/{totalTrades} trades
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 px-2 text-center">
                          <div className="flex flex-col items-center gap-0.5">
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                                challengerTrue > 0
                                  ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                                  : "bg-muted text-muted-foreground"
                              )}
                            >
                              {challengerTrue > 0 ? "Challenger coverage" : "Champion only"}
                            </span>
                            {challengerTrue > 0 && totalTrades > 0 && (
                              <span className="text-[10px] text-muted-foreground tabular-nums">
                                {( (challengerTrue / totalTrades) * 100 ).toFixed(1)}%
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 px-2 text-center">
                          {budget ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="text-[10px] text-muted-foreground tabular-nums">
                                Rank #{budget.rank}
                              </span>
                              <span className="text-[11px] font-mono">
                                w={budget.budgetWeight.toFixed(2)} · max={budget.maxNewTradesToday}
                              </span>
                            </div>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">n/a</span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-center">
                          {activeRev ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="text-[10px] font-mono text-muted-foreground">
                                rev:{activeRev.revisionKey}
                              </span>
                              {latestIntendedForActive ? (
                                <span className="text-[10px] font-mono">
                                  mdl:
                                  <span
                                    className="ml-0.5"
                                    title={latestIntendedForActive.modelRunId}
                                  >
                                    {formatCompactId(latestIntendedForActive.modelRunId)}
                                  </span>
                                </span>
                              ) : (
                                <span className="text-[10px] text-muted-foreground">
                                  No active pairing
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">
                              No active pairing
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Selected bot governance + drilldown */}
          {selectedBotType && (
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {/* Governance / effective config */}
              <div className="space-y-3 rounded border border-border p-3 bg-muted/30">
                <p className="text-sm font-medium">
                  Effective profile config ({selectedBotType})
                </p>
                {(() => {
                  const p = profiles.find((x) => x.botType === selectedBotType);
                  if (!p) return <p className="text-sm text-muted-foreground">No profile.</p>;
                  return (
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <strong>Display name:</strong> {p.displayName}
                      </div>
                      <div>
                        <strong>Version:</strong> {p.botVersion ?? "—"}
                      </div>
                      <div>
                        <strong>Target label:</strong> {p.targetLabel ?? "—"}
                      </div>
                      <div>
                        <strong>Override source:</strong> {p.overrideSource ?? "none"}
                      </div>
                      <div>
                        <strong>Threshold:</strong> {p.threshold}
                      </div>
                      <div>
                        <strong>Score buffer:</strong> {p.minScoreBuffer}
                      </div>
                      <div>
                        <strong>Cooldown hrs:</strong> {p.cooldownHours}
                      </div>
                      <div>
                        <strong>Cooldown mkt hrs:</strong> {p.cooldownMarketHours}
                      </div>
                      <div>
                        <strong>Max open total:</strong> {p.maxOpenTotal}
                      </div>
                      <div>
                        <strong>Max per market:</strong> {p.maxOpenPerMarket}
                      </div>
                      <div>
                        <strong>Max per theme:</strong> {p.maxOpenPerTheme}
                      </div>
                      <div>
                        <strong>Max per category:</strong> {p.maxOpenPerCategory}
                      </div>
                      <div>
                        <strong>Daily new trades:</strong> {p.maxDailyNewTrades}
                      </div>
                      <div>
                        <strong>Allow review-required:</strong>{" "}
                        {p.allowReviewRequired ? "yes" : "no"}
                      </div>
                      <div>
                        <strong>Paper relaxation:</strong>{" "}
                        {p.allowPaperRelaxation ? "enabled" : "disabled"}
                      </div>
                      <div className="col-span-2">
                        <strong>Allowed price bands:</strong>{" "}
                        {(p.allowedPriceBands ?? []).join(", ") || "—"}
                      </div>
                      <div className="col-span-2">
                        <strong>Relaxation reasons:</strong>{" "}
                        {(p.allowRelaxationReasons ?? []).join(", ") || "—"}
                      </div>
                      <div className="col-span-2">
                        <strong>Exploration allocator:</strong>{" "}
                        {p.allowPaperRelaxation ? "Exploration allocator v1 eligible" : "Legacy threshold only"}
                      </div>
                      <div className="col-span-2">
                        <strong>Notes:</strong>{" "}
                        {p.notes ?? <span className="text-muted-foreground">—</span>}
                      </div>
                    </div>
                  );
                })()}

                {/* Bot budget allocator (latest decision + applied state) */}
                <div className="mt-4 rounded border border-border bg-background/60 p-2 text-xs space-y-1">
                  <p className="font-medium text-sm">Bot budget allocator (v1)</p>
                  {(() => {
                    const budget = botBudgets.find((b) => b.botType === selectedBotType);
                    if (!budget) {
                      return (
                        <p className="text-xs text-muted-foreground">
                          No allocator decision loaded for this bot (check feature flag or lookback window).
                        </p>
                      );
                    }
                    const perBotSummary =
                      diagnostics?.lastTickPerBotSummary?.[selectedBotType] ?? null;
                    // We don't have createdTodayBeforeTick directly from diagnostics; treat opened as this-tick behavior only.
                    const openedThisTick = perBotSummary?.opened ?? 0;
                    return (
                      <div className="grid grid-cols-2 gap-1">
                        <div>
                          <strong>Rank:</strong> #{budget.rank}
                        </div>
                        <div>
                          <strong>Budget weight:</strong> {budget.budgetWeight.toFixed(3)}
                        </div>
                        <div>
                          <strong>Max new trades (today):</strong>{" "}
                          {budget.maxNewTradesToday}
                        </div>
                        <div>
                          <strong>Lookback (days):</strong> {budget.metrics.lookbackDays}
                        </div>
                        <div>
                          <strong>Closed (lookback):</strong> {budget.metrics.closedTrades}
                        </div>
                        <div>
                          <strong>Win rate:</strong>{" "}
                          {budget.metrics.winRate != null
                            ? `${(budget.metrics.winRate * 100).toFixed(1)}%`
                            : "n/a"}
                        </div>
                        <div>
                          <strong>Avg PnL %:</strong>{" "}
                          {budget.metrics.averagePnlPct != null
                            ? `${(budget.metrics.averagePnlPct * 100).toFixed(2)}%`
                            : "n/a"}
                        </div>
                        <div>
                          <strong>Cum PnL %:</strong>{" "}
                          {budget.metrics.cumulativePnlPct != null
                            ? `${(budget.metrics.cumulativePnlPct * 100).toFixed(2)}%`
                            : "n/a"}
                        </div>
                        <div>
                          <strong>Overlap score:</strong>{" "}
                          {budget.metrics.overlapScore.toFixed(2)}
                        </div>
                        <div>
                          <strong>Enabled:</strong>{" "}
                          {budget.metrics.enabled ? "yes" : "no"}
                        </div>
                        <div className="col-span-2">
                          <strong>Last tick opens (this bot):</strong>{" "}
                          {openedThisTick}
                        </div>
                        <div className="col-span-2">
                          <strong>Reason summary:</strong>{" "}
                          <span className="font-mono break-all">
                            {budget.reasonSummary}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Profile revisions for selected bot */}
                <div className="mt-4 rounded border border-border bg-background/60 p-2 text-xs space-y-2">
                  <p className="font-medium text-sm">Profile revisions (paper-only governance)</p>
                  <p className="text-[11px] text-muted-foreground">
                    ACTIVE revisions mark governance intent only in v1. Engine behavior still comes from code-defined/effective profiles unless wired otherwise.
                  </p>
                  {(() => {
                    const revisionsForBot = profileRevisions.filter(
                      (r) => r.botType === selectedBotType
                    );
                    if (revisionsForBot.length === 0) {
                      return (
                        <p className="text-xs text-muted-foreground">
                          No revisions recorded yet for this bot.
                        </p>
                      );
                    }
                    const active = revisionsForBot.find((r) => r.status === "ACTIVE");
                    const staged = revisionsForBot.filter((r) => r.status === "STAGED");
                    return (
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-1">
                          <div>
                            <strong>ACTIVE revision:</strong>{" "}
                            {active ? (
                              <span className="font-mono text-emerald-600 dark:text-emerald-400">
                                {active.revisionKey}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">none</span>
                            )}
                          </div>
                          <div>
                            <strong>STAGED revisions:</strong>{" "}
                            {staged.length > 0 ? staged.length : 0}
                          </div>
                        </div>
                        <div className="max-h-48 overflow-auto rounded border border-border/60 bg-muted/40">
                          <table className="w-full text-[11px] border-collapse">
                            <thead>
                              <tr className="border-b border-border/60">
                                <th className="py-1 px-2 text-left font-medium">Key</th>
                                <th className="py-1 px-2 text-left font-medium">Status</th>
                                <th className="py-1 px-2 text-left font-medium">Snapshot</th>
                                <th className="py-1 px-2 text-left font-medium">Created</th>
                                <th className="py-1 px-2 text-left font-medium">Promoted</th>
                              </tr>
                            </thead>
                            <tbody>
                              {revisionsForBot.map((r) => (
                                <tr
                                  key={r.id}
                                  className={cn(
                                    "border-b border-border/40",
                                    r.status === "ACTIVE" && "bg-emerald-500/5",
                                    r.status === "STAGED" && "bg-amber-500/5"
                                  )}
                                >
                                  <td className="py-1 px-2 font-mono truncate max-w-[80px]">
                                    {r.revisionKey}
                                  </td>
                                  <td className="py-1 px-2">
                                    <span
                                      className={cn(
                                        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                                        r.status === "ACTIVE"
                                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                          : r.status === "STAGED"
                                            ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                            : "bg-muted text-muted-foreground"
                                      )}
                                    >
                                      {r.status}
                                    </span>
                                  </td>
                                  <td className="py-1 px-2 font-mono text-[10px]">
                                    {formatSnapshotId(r.profileSnapshotJson)}
                                  </td>
                                  <td className="py-1 px-2 text-xs text-muted-foreground">
                                    {new Date(r.createdAt).toLocaleString()}
                                  </td>
                                  <td className="py-1 px-2 text-xs text-muted-foreground">
                                    {r.promotedAt
                                      ? new Date(r.promotedAt).toLocaleString()
                                      : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Current governance pairing / handshake summary */}
                <div className="mt-4 rounded border border-border bg-background/60 p-2 text-xs space-y-1">
                  <p className="font-medium text-sm">Current governance pairing (paper-only)</p>
                  <p className="text-[11px] text-muted-foreground">
                    Linkages here are governance metadata only. Intended model runs do not yet auto-switch engine behavior; the paper engine still uses its configured shadow model selection.
                  </p>
                  {(() => {
                    const revisionsForBot = profileRevisions.filter(
                      (r) => r.botType === selectedBotType
                    );
                    const activeRev = revisionsForBot.find((r) => r.status === "ACTIVE") ?? null;
                    const linksForBot = profileModelLinks.filter(
                      (l) => l.botType === selectedBotType
                    );
                    if (!activeRev) {
                      return (
                        <p className="text-xs text-muted-foreground">
                          No ACTIVE revision for this bot; create and promote a revision to enable handshake planning.
                        </p>
                      );
                    }
                    const activeLinks = linksForBot.filter(
                      (l) => l.profileRevisionId === activeRev.id
                    );
                    const intended = activeLinks
                      .filter((l) => l.linkageRole === "INTENDED_ACTIVE")
                      .sort(
                        (a, b) =>
                          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                      );
                    const evaluated = activeLinks
                      .filter((l) => l.linkageRole === "EVALUATED_WITH")
                      .sort(
                        (a, b) =>
                          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                      );
                    const latestIntended = intended[intended.length - 1];
                    const latestEval = evaluated[evaluated.length - 1];
                    const stagedCount = revisionsForBot.filter(
                      (r) => r.status === "STAGED"
                    ).length;
                    return (
                      <div className="grid grid-cols-2 gap-1 mt-1">
                        <div>
                          <strong>ACTIVE revision:</strong>{" "}
                          <span className="font-mono text-emerald-600 dark:text-emerald-400">
                            {activeRev.revisionKey}
                          </span>
                        </div>
                        <div>
                          <strong>Target label:</strong>{" "}
                          <span className="font-mono">
                            {activeRev.targetLabel ?? "—"}
                          </span>
                        </div>
                        <div>
                          <strong>Intended model run:</strong>{" "}
                          {latestIntended ? (
                            <span className="font-mono" title={latestIntended.modelRunId}>
                              {formatCompactId(latestIntended.modelRunId)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">none</span>
                          )}
                        </div>
                        <div>
                          <strong>Latest evaluated-with:</strong>{" "}
                          {latestEval ? (
                            <span className="font-mono" title={latestEval.modelRunId}>
                              {formatCompactId(latestEval.modelRunId)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">none</span>
                          )}
                        </div>
                        <div>
                          <strong>STAGED revisions:</strong>{" "}
                          {stagedCount}
                        </div>
                        <div>
                          <strong>Intended linkage exists:</strong>{" "}
                          {latestIntended ? "yes" : "no"}
                        </div>
                        <div className="col-span-2">
                          <strong>Links on ACTIVE:</strong>{" "}
                          {activeLinks.length}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Selected bot equity + recent trades */}
              <div className="space-y-3">
                <div className="rounded border border-border p-3 bg-muted/30">
                  <p className="text-sm font-medium mb-2">
                    Equity curve ({selectedBotType})
                  </p>
                  {selectedBotEquity.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No closed trades yet for this bot in the selected window.
                    </p>
                  ) : (
                    <div className="h-40 w-full">
                      <EquityChart data={selectedBotEquity} />
                    </div>
                  )}
                </div>
                <div className="rounded border border-border p-3 bg-muted/30">
                  <p className="text-sm font-medium mb-2">
                    Recent trades ({selectedBotType})
                  </p>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-muted-foreground">Filter:</span>
                    <select
                      className="rounded border border-input bg-background px-2 py-1 text-xs"
                      value={selectedBotExplorationFilter}
                      onChange={(e) =>
                        setSelectedBotExplorationFilter(
                          e.target.value as "all" | "exploration_only" | "challenger_only"
                        )
                      }
                    >
                      <option value="all">All trades</option>
                      <option value="exploration_only">Exploration-admitted only</option>
                      <option value="challenger_only">Challenger-available only</option>
                    </select>
                  </div>
                  {selectedBotTrades.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No trades for this bot in the selected window.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="py-1 px-2 text-left font-medium">Asset</th>
                            <th className="py-1 px-2 text-left font-medium">Side</th>
                            <th className="py-1 px-2 text-right font-medium">Score</th>
                            <th className="py-1 px-2 text-right font-medium">Entry</th>
                            <th className="py-1 px-2 text-right font-medium">PnL %</th>
                            <th className="py-1 px-2 text-left font-medium">Exploration</th>
                            <th className="py-1 px-2 text-left font-medium">Champion / Challenger</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredSelectedBotTrades.slice(0, 15).map((t) => (
                            <tr key={t.id} className="border-b border-border/40">
                              <td className="py-1 px-2 font-mono truncate max-w-[100px]" title={t.assetId}>
                                {t.assetId.slice(0, 10)}…
                              </td>
                              <td className="py-1 px-2">{t.side}</td>
                              <td className="py-1 px-2 text-right tabular-nums">
                                {t.score.toFixed(3)}
                              </td>
                              <td className="py-1 px-2 text-right tabular-nums">
                                {t.entryPrice}
                              </td>
                              <td className="py-1 px-2 text-right tabular-nums">
                                {t.pnlPct != null
                                  ? `${(parseFloat(t.pnlPct) * 100).toFixed(2)}%`
                                  : "—"}
                              </td>
                              <td className="py-1 px-2">
                                {t.explorationAdmissionMode ? (
                                  <span className="inline-flex items-center rounded-full bg-sky-500/10 text-sky-700 dark:text-sky-400 px-2 py-0.5 text-[10px] font-mono">
                                    {t.explorationAdmissionMode}
                                    {t.explorationBand && (
                                      <span className="ml-1 text-[9px] text-muted-foreground">
                                        [{t.explorationBand}]
                                      </span>
                                    )}
                                  </span>
                                ) : (
                                  <span className="text-[10px] text-muted-foreground">
                                    threshold_only
                                  </span>
                                )}
                              </td>
                              <td className="py-1 px-2">
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-[10px] font-mono text-muted-foreground">
                                    C:{formatCompactId(t.championModelRunId ?? t.modelRunId)}
                                  </span>
                                  {t.challengerModelRunId && (
                                    <span className="text-[10px] font-mono text-purple-600 dark:text-purple-400">
                                      Ch:{formatCompactId(t.challengerModelRunId)}{" "}
                                      {t.challengerScoreDelta != null && (
                                        <span
                                          className={cn(
                                            "ml-1",
                                            t.challengerScoreDelta > 0
                                              ? "text-emerald-600 dark:text-emerald-400"
                                              : t.challengerScoreDelta < 0
                                                ? "text-red-600 dark:text-red-400"
                                                : "text-muted-foreground"
                                          )}
                                        >
                                          Δ{t.challengerScoreDelta.toFixed(3)}
                                        </span>
                                      )}
                                    </span>
                                  )}
                                  {!t.challengerModelRunId && t.challengerAvailable === false && (
                                    <span className="text-[10px] text-muted-foreground">
                                      Challenger: none
                                    </span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Segmentation for selected bot */}
          {selectedBotType && (
            <div className="mt-4 rounded border border-border p-3 bg-muted/20 space-y-3">
              <p className="text-sm font-medium">
                Segmentation &amp; exploration / model comparison ({selectedBotType})
              </p>
              {(() => {
                const s = botAnalytics.find((b) => b.botType === selectedBotType);
                if (!s) {
                  return (
                    <p className="text-xs text-muted-foreground">
                      No analytics for this bot.
                    </p>
                  );
                }
                const renderChips = (label: string, data: Record<string, number>) => (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <div className="flex flex-wrap gap-1">
                      {Object.keys(data).length === 0 ? (
                        <span className="text-xs text-muted-foreground">none</span>
                      ) : (
                        Object.entries(data)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 12)
                          .map(([k, v]) => (
                            <span
                              key={k}
                              className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-mono"
                            >
                              {k}: {v}
                            </span>
                          ))
                      )}
                    </div>
                  </div>
                );
                const compactSnapshots: Record<string, number> = {};
                for (const [snap, count] of Object.entries(s.byProfileSnapshot)) {
                  const label =
                    snap && snap.length > 0
                      ? `cfg-${btoa(snap).slice(0, 8)}`
                      : "unknown";
                  compactSnapshots[label] = (compactSnapshots[label] ?? 0) + count;
                }
                return (
                  <div className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 text-xs">
                      {renderChips("Entry price bands", s.byEntryPriceBand)}
                      {renderChips("Paper policy mode", s.byPaperPolicyMode)}
                      {renderChips("Relaxation reasons", s.byPaperRelaxationReason)}
                      {renderChips("Categories", s.byCategory)}
                      {renderChips("Themes", s.byTheme)}
                      {renderChips("Bot versions", s.byBotVersion)}
                      {renderChips("Profile snapshots (compact)", compactSnapshots)}
                    </div>
                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 text-xs">
                      {renderChips(
                        "Challenger availability",
                        s.byChallengerAvailable ?? {}
                      )}
                      {renderChips(
                        "Champion model runs",
                        s.byChampionModelRunId ?? {}
                      )}
                      {renderChips(
                        "Challenger model runs",
                        s.byChallengerModelRunId ?? {}
                      )}
                      {renderChips(
                        "Challenger score delta buckets",
                        s.byChallengerScoreDeltaBucket ?? {}
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Open trades table */}
      <Card>
        <CardHeader>
          <CardTitle>Open trades</CardTitle>
          <CardDescription>Paper trades not yet closed at 12h.</CardDescription>
        </CardHeader>
        <CardContent>
          {filteredOpen.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open trades.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-2 font-medium">Asset</th>
                    <th className="text-left py-2 px-2 font-medium">Side</th>
                    <th className="text-right py-2 px-2 font-medium">Score</th>
                    <th className="text-right py-2 px-2 font-medium">Entry price</th>
                    <th className="text-right py-2 px-2 font-medium">Size</th>
                    <th className="text-left py-2 px-2 font-medium">Entry time</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOpen.map((t) => (
                    <tr key={t.id} className="border-b border-border/50">
                      <td className="py-2 px-2 font-mono truncate max-w-[120px]" title={t.assetId}>
                        {t.assetId.slice(0, 10)}…
                      </td>
                      <td className="py-2 px-2">{t.side}</td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {t.score.toFixed(3)}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {t.entryPrice}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {t.intendedSize}
                      </td>
                      <td className="py-2 px-2 text-muted-foreground">
                        {new Date(t.entryTime).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent closed trades */}
      <Card>
        <CardHeader>
          <CardTitle>Recent closed trades</CardTitle>
          <CardDescription>Closed paper trades with 12h markout.</CardDescription>
        </CardHeader>
        <CardContent>
          {filteredClosed.length === 0 ? (
            <p className="text-sm text-muted-foreground">No closed trades.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-2 font-medium">Asset</th>
                    <th className="text-left py-2 px-2 font-medium">Side</th>
                    <th className="text-right py-2 px-2 font-medium">Score</th>
                    <th className="text-right py-2 px-2 font-medium">Entry</th>
                    <th className="text-right py-2 px-2 font-medium">Exit</th>
                    <th className="text-right py-2 px-2 font-medium">PnL %</th>
                    <th className="text-left py-2 px-2 font-medium">Exit time</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredClosed.slice(0, 20).map((t) => (
                    <tr key={t.id} className="border-b border-border/50">
                      <td className="py-2 px-2 font-mono truncate max-w-[120px]" title={t.assetId}>
                        {t.assetId.slice(0, 10)}…
                      </td>
                      <td className="py-2 px-2">{t.side}</td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {t.score.toFixed(3)}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {t.entryPrice}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {t.exitPrice ?? "—"}
                      </td>
                      <td
                        className={cn(
                          "py-2 px-2 text-right tabular-nums",
                          t.pnlPct && parseFloat(t.pnlPct) >= 0
                            ? "text-green-600 dark:text-green-500"
                            : "text-red-600 dark:text-red-500"
                        )}
                      >
                        {t.pnlPct != null
                          ? `${(parseFloat(t.pnlPct) * 100).toFixed(2)}%`
                          : "—"}
                      </td>
                      <td className="py-2 px-2 text-muted-foreground">
                        {t.exitTime
                          ? new Date(t.exitTime).toLocaleString()
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bot overlap */}
      {overlap.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Bot overlap</CardTitle>
            <CardDescription>
              Markets and asset/sides traded by multiple bots (competition / co-participation).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-2 px-2 text-left font-medium">Bot A</th>
                    <th className="py-2 px-2 text-left font-medium">Bot B</th>
                    <th className="py-2 px-2 text-right font-medium">Same markets</th>
                    <th className="py-2 px-2 text-right font-medium">Same asset/side</th>
                  </tr>
                </thead>
                <tbody>
                  {overlap.slice(0, 30).map((o) => (
                    <tr key={`${o.botA}-${o.botB}`} className="border-b border-border/40">
                      <td className="py-2 px-2 font-mono">{o.botA}</td>
                      <td className="py-2 px-2 font-mono">{o.botB}</td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {o.sameMarketCount}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {o.sameAssetSideCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Decision controls summary */}
      <Card>
        <CardHeader>
          <CardTitle>Decision controls summary</CardTitle>
          <CardDescription>
            Per-bot summary of how thresholding, exploration allocator, challenger coverage, and budget allocation shape paper trade openings (paper-only, no live impact).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {controlSummary.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No control summary available yet. Run at least one paper tick and ensure paper trades exist in the lookback window.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-2 px-2 text-left font-medium">Bot</th>
                    <th className="py-2 px-2 text-right font-medium">Threshold admits</th>
                    <th className="py-2 px-2 text-right font-medium">Exploration admits</th>
                    <th className="py-2 px-2 text-right font-medium">Challenger coverage</th>
                    <th className="py-2 px-2 text-right font-medium">Budget</th>
                    <th className="py-2 px-2 text-right font-medium">Last tick opened</th>
                    <th className="py-2 px-2 text-right font-medium">Budget rejections</th>
                  </tr>
                </thead>
                <tbody>
                  {controlSummary.map((b) => (
                    <tr key={b.botType} className="border-b border-border/50">
                      <td className="py-2 px-2 font-mono text-xs">{b.botType}</td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {b.thresholdAdmissions}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {b.explorationAdmissions}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {b.challengerCoverageCount}
                        {b.challengerCoveragePct != null && (
                          <span className="text-xs text-muted-foreground">
                            {" "}
                            ({(b.challengerCoveragePct * 100).toFixed(1)}%)
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-xs">
                        {b.budgetRank != null ? (
                          <span>
                            rank {b.budgetRank} · w=
                            {b.budgetWeight != null ? b.budgetWeight.toFixed(2) : "-"}
                            {" · "}
                            max={b.maxNewTradesToday ?? "-"}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">n/a</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {b.lastTickOpened ?? "—"}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-xs">
                        {b.lastTickRejectedByBudgetCount ?? 0}
                        {b.constrainedByBudget && (
                          <span className="ml-1 text-[11px] text-amber-600 dark:text-amber-400">
                            constrained
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bot budget allocator overview */}
      {botBudgets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Bot budget allocator v1</CardTitle>
            <CardDescription>
              Paper-only per-bot budgets and ranks based on recent performance and overlap (no live trading impact).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-2 px-2 text-left font-medium">Bot</th>
                    <th className="py-2 px-2 text-right font-medium">Rank</th>
                    <th className="py-2 px-2 text-right font-medium">Budget weight</th>
                    <th className="py-2 px-2 text-right font-medium">Max new trades (today)</th>
                    <th className="py-2 px-2 text-right font-medium">Closed (lookback)</th>
                    <th className="py-2 px-2 text-right font-medium">Win rate</th>
                    <th className="py-2 px-2 text-right font-medium">Avg PnL %</th>
                    <th className="py-2 px-2 text-right font-medium">Cum PnL %</th>
                    <th className="py-2 px-2 text-right font-medium">Overlap</th>
                    <th className="py-2 px-2 text-left font-medium">Reason summary</th>
                  </tr>
                </thead>
                <tbody>
                  {botBudgets.map((b) => (
                    <tr key={b.botType} className="border-b border-border/40">
                      <td className="py-2 px-2 font-mono">{b.botType}</td>
                      <td className="py-2 px-2 text-right tabular-nums">#{b.rank}</td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {b.budgetWeight.toFixed(3)}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {b.maxNewTradesToday}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {b.metrics.closedTrades}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {b.metrics.winRate != null
                          ? `${(b.metrics.winRate * 100).toFixed(1)}%`
                          : "n/a"}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {b.metrics.averagePnlPct != null
                          ? `${(b.metrics.averagePnlPct * 100).toFixed(2)}%`
                          : "n/a"}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {b.metrics.cumulativePnlPct != null
                          ? `${(b.metrics.cumulativePnlPct * 100).toFixed(2)}%`
                          : "n/a"}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {b.metrics.overlapScore.toFixed(2)}
                      </td>
                      <td className="py-2 px-2 text-xs text-muted-foreground">
                        <span className="font-mono break-all">{b.reasonSummary}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Profile revisions overview */}
      <Card>
        <CardHeader>
          <CardTitle>Profile revisions (paper-only)</CardTitle>
          <CardDescription>
            Governance records for paper bot profiles. ACTIVE revisions indicate governance intent only and do not yet auto-switch engine behavior.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Register new revision form */}
          <div className="rounded border border-border/60 bg-muted/40 p-3 text-xs space-y-2">
            <p className="font-medium text-sm">Register current effective profile as revision</p>
            <div className="grid gap-2 md:grid-cols-4 items-end">
              <div className="md:col-span-1">
                <label className="text-xs font-medium block mb-1">
                  Bot type
                </label>
                <select
                  className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
                  value={selectedBotType ?? ""}
                  onChange={(e) => setSelectedBotType(e.target.value || null)}
                >
                  <option value="">Select bot</option>
                  {profiles.map((p) => (
                    <option key={p.botType} value={p.botType}>
                      {p.botType}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1">Revision key</label>
                <input
                  type="text"
                  className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                  placeholder="e.g. v1.0.1-experiment"
                  value={revisionForm.revisionKey}
                  onChange={(e) =>
                    setRevisionForm((f) => ({ ...f, revisionKey: e.target.value }))
                  }
                />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1">Status</label>
                <select
                  className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
                  value={revisionForm.status}
                  onChange={(e) =>
                    setRevisionForm((f) => ({
                      ...f,
                      status: e.target.value as "DRAFT" | "STAGED",
                    }))
                  }
                >
                  <option value="DRAFT">DRAFT</option>
                  <option value="STAGED">STAGED</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1">
                  Rollback target (optional)
                </label>
                <input
                  type="text"
                  className="w-full rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                  placeholder="revisionKey to roll back to"
                  value={revisionForm.rollbackTargetRevision}
                  onChange={(e) =>
                    setRevisionForm((f) => ({
                      ...f,
                      rollbackTargetRevision: e.target.value,
                    }))
                  }
                />
              </div>
            </div>
            <div className="mt-2">
              <label className="text-xs font-medium block mb-1">Notes</label>
              <textarea
                className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
                rows={2}
                placeholder="Short rationale for this revision"
                value={revisionForm.notes}
                onChange={(e) =>
                  setRevisionForm((f) => ({ ...f, notes: e.target.value }))
                }
              />
            </div>
            {revisionForm.error && (
              <p className="text-xs text-destructive">{revisionForm.error}</p>
            )}
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={revisionForm.submitting || !selectedBotType}
                onClick={async () => {
                  if (!selectedBotType) return;
                  setRevisionForm((f) => ({ ...f, submitting: true, error: null }));
                  try {
                    const res = await fetch("/api/paper-trading/profile-revisions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        botType: selectedBotType,
                        revisionKey:
                          revisionForm.revisionKey || undefined,
                        status: revisionForm.status,
                        notes: revisionForm.notes || undefined,
                        rollbackTargetRevision:
                          revisionForm.rollbackTargetRevision || undefined,
                      }),
                    });
                    if (!res.ok) {
                      const j = await res.json().catch(() => ({}));
                      throw new Error(j.error ?? `Request failed (${res.status})`);
                    }
                    // Refresh revisions
                    const listRes = await fetch(
                      "/api/paper-trading/profile-revisions"
                    );
                    if (listRes.ok) {
                      const j = await listRes.json();
                      setProfileRevisions(j.revisions ?? []);
                    }
                    setRevisionForm((f) => ({
                      ...f,
                      submitting: false,
                      error: null,
                    }));
                  } catch (e) {
                    setRevisionForm((f) => ({
                      ...f,
                      submitting: false,
                      error:
                        e instanceof Error ? e.message : "Failed to register revision",
                    }));
                  }
                }}
              >
                {revisionForm.submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : null}
                Register revision
              </Button>
            </div>
          </div>

          {/* Revisions grouped by bot */}
          <div className="overflow-x-auto">
            {profileRevisions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No profile revisions recorded yet.
              </p>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-2 px-2 text-left font-medium">Bot</th>
                    <th className="py-2 px-2 text-left font-medium">Revision</th>
                    <th className="py-2 px-2 text-left font-medium">Status</th>
                    <th className="py-2 px-2 text-left font-medium">Snapshot</th>
                    <th className="py-2 px-2 text-left font-medium">Created</th>
                    <th className="py-2 px-2 text-left font-medium">Promoted</th>
                    <th className="py-2 px-2 text-left font-medium">Rollback target</th>
                    <th className="py-2 px-2 text-left font-medium">Notes</th>
                    <th className="py-2 px-2 text-center font-medium">Promote</th>
                  </tr>
                </thead>
                <tbody>
                  {profileRevisions.map((r) => (
                    <tr
                      key={r.id}
                      className={cn(
                        "border-b border-border/40",
                        r.status === "ACTIVE" && "bg-emerald-500/5",
                        r.status === "STAGED" && "bg-amber-500/5"
                      )}
                    >
                      <td className="py-2 px-2 font-mono text-xs">{r.botType}</td>
                      <td className="py-2 px-2 font-mono text-xs">{r.revisionKey}</td>
                      <td className="py-2 px-2 text-xs">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                            r.status === "ACTIVE"
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : r.status === "STAGED"
                                ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                : "bg-muted text-muted-foreground"
                          )}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="py-2 px-2 font-mono text-[10px]">
                        {formatSnapshotId(r.profileSnapshotJson)}
                      </td>
                      <td className="py-2 px-2 text-xs text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString()}
                      </td>
                      <td className="py-2 px-2 text-xs text-muted-foreground">
                        {r.promotedAt
                          ? new Date(r.promotedAt).toLocaleString()
                          : "—"}
                      </td>
                      <td className="py-2 px-2 font-mono text-[10px]">
                        {r.rollbackTargetRevision ?? "—"}
                      </td>
                      <td className="py-2 px-2 text-xs text-muted-foreground max-w-[200px] truncate">
                        {r.notes ?? "—"}
                      </td>
                      <td className="py-2 px-2 text-xs text-muted-foreground">
                        {(() => {
                          const linksForRev = profileModelLinks.filter(
                            (l) => l.profileRevisionId === r.id
                          );
                          if (linksForRev.length === 0) {
                            return (
                              <span className="text-[10px] text-muted-foreground">
                                none
                              </span>
                            );
                          }
                          const counts: Record<string, number> = {};
                          for (const l of linksForRev) {
                            counts[l.linkageRole] = (counts[l.linkageRole] ?? 0) + 1;
                          }
                          return (
                            <span className="text-[10px] font-mono">
                              {Object.entries(counts)
                                .map(([role, c]) => `${role}:${c}`)
                                .join(" ")}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="py-2 px-2 text-center">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={r.status === "ACTIVE"}
                          title="Promote this revision to ACTIVE (paper governance only)"
                          onClick={async () => {
                            try {
                              const res = await fetch(
                                "/api/paper-trading/profile-revisions/promote",
                                {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    revisionId: r.id,
                                    demotePreviousTo: "ARCHIVED",
                                  }),
                                }
                              );
                              if (!res.ok) {
                                const j = await res.json().catch(() => ({}));
                                throw new Error(
                                  j.error ?? `Promotion failed (${res.status})`
                                );
                              }
                              const listRes = await fetch(
                                "/api/paper-trading/profile-revisions"
                              );
                              if (listRes.ok) {
                                const j = await listRes.json();
                                setProfileRevisions(j.revisions ?? []);
                              }
                            } catch (e) {
                              console.error("Promotion failed", e);
                            }
                          }}
                        >
                          Promote
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Profile / Model Links overview */}
      <Card>
        <CardHeader>
          <CardTitle>Profile / Model links (paper-only)</CardTitle>
          <CardDescription>
            Governance linkages between profile revisions and shadow model runs. These do not change model selection automatically; they document evaluation and intent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-xs">
          {/* Create new linkage */}
          <div className="rounded border border-border/60 bg-muted/40 p-3 space-y-2">
            <p className="font-medium text-sm">Create profile/model linkage</p>
            <p className="text-[11px] text-muted-foreground">
              Use this to record which model run a revision was evaluated with or is intended to pair with. No runtime behavior changes in v1.
            </p>
            <div className="grid gap-2 md:grid-cols-4 items-end">
              <div>
                <label className="text-[11px] font-medium block mb-1">Bot type</label>
                <select
                  className="w-full rounded border border-input bg-background px-2 py-1 text-[11px]"
                  value={linkageForm.botType || selectedBotType || ""}
                  onChange={(e) =>
                    setLinkageForm((f) => ({
                      ...f,
                      botType: e.target.value,
                      profileRevisionId: "",
                      success: null,
                      error: null,
                    }))
                  }
                >
                  <option value="">Select bot</option>
                  {profiles.map((p) => (
                    <option key={p.botType} value={p.botType}>
                      {p.botType}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] font-medium block mb-1">Revision</label>
                <select
                  className="w-full rounded border border-input bg-background px-2 py-1 text-[11px]"
                  value={linkageForm.profileRevisionId}
                  onChange={(e) =>
                    setLinkageForm((f) => ({
                      ...f,
                      profileRevisionId: e.target.value,
                      success: null,
                      error: null,
                    }))
                  }
                  disabled={!(linkageForm.botType || selectedBotType)}
                >
                  <option value="">Select revision</option>
                  {profileRevisions
                    .filter(
                      (r) =>
                        r.botType === (linkageForm.botType || selectedBotType || "")
                    )
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.revisionKey} ({r.status})
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] font-medium block mb-1">Model run id</label>
                <input
                  type="text"
                  className="w-full rounded border border-input bg-background px-2 py-1 text-[11px] font-mono"
                  placeholder="mlModelRun.id"
                  value={linkageForm.modelRunId}
                  onChange={(e) =>
                    setLinkageForm((f) => ({
                      ...f,
                      modelRunId: e.target.value,
                      success: null,
                      error: null,
                    }))
                  }
                />
              </div>
              <div>
                <label className="text-[11px] font-medium block mb-1">Role</label>
                <select
                  className="w-full rounded border border-input bg-background px-2 py-1 text-[11px]"
                  value={linkageForm.linkageRole}
                  onChange={(e) =>
                    setLinkageForm((f) => ({
                      ...f,
                      linkageRole: e.target.value as
                        | "EVALUATED_WITH"
                        | "INTENDED_ACTIVE"
                        | "ROLLBACK_TARGET",
                      success: null,
                      error: null,
                    }))
                  }
                >
                  <option value="EVALUATED_WITH">EVALUATED_WITH</option>
                  <option value="INTENDED_ACTIVE">INTENDED_ACTIVE</option>
                  <option value="ROLLBACK_TARGET">ROLLBACK_TARGET</option>
                </select>
              </div>
            </div>
            <div className="mt-2">
              <label className="text-[11px] font-medium block mb-1">Notes</label>
              <textarea
                className="w-full rounded border border-input bg-background px-2 py-1 text-[11px]"
                rows={2}
                placeholder="Short rationale for this linkage"
                value={linkageForm.notes}
                onChange={(e) =>
                  setLinkageForm((f) => ({
                    ...f,
                    notes: e.target.value,
                    success: null,
                    error: null,
                  }))
                }
              />
            </div>
            {linkageForm.error && (
              <p className="text-[11px] text-destructive">{linkageForm.error}</p>
            )}
            {linkageForm.success && (
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                {linkageForm.success}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  linkageForm.submitting ||
                  !(linkageForm.botType || selectedBotType) ||
                  !linkageForm.profileRevisionId ||
                  !linkageForm.modelRunId
                }
                onClick={async () => {
                  const botTypeForLink = linkageForm.botType || selectedBotType;
                  if (!botTypeForLink) return;
                  if (!linkageForm.profileRevisionId || !linkageForm.modelRunId) return;
                  setLinkageForm((f) => ({
                    ...f,
                    submitting: true,
                    error: null,
                    success: null,
                  }));
                  try {
                    const res = await fetch(
                      "/api/paper-trading/profile-model-links",
                      {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          botType: botTypeForLink,
                          profileRevisionId: linkageForm.profileRevisionId,
                          modelRunId: linkageForm.modelRunId,
                          linkageRole: linkageForm.linkageRole,
                          notes: linkageForm.notes || undefined,
                        }),
                      }
                    );
                    if (!res.ok) {
                      const j = await res.json().catch(() => ({}));
                      throw new Error(
                        j.error ?? `Link creation failed (${res.status})`
                      );
                    }
                    // Refresh links
                    const linksRes = await fetch(
                      "/api/paper-trading/profile-model-links"
                    );
                    if (linksRes.ok) {
                      const j = await linksRes.json();
                      setProfileModelLinks(j.links ?? []);
                    }
                    setLinkageForm((f) => ({
                      ...f,
                      submitting: false,
                      success: "Linkage created (paper-only governance).",
                    }));
                  } catch (e) {
                    setLinkageForm((f) => ({
                      ...f,
                      submitting: false,
                      error:
                        e instanceof Error
                          ? e.message
                          : "Failed to create linkage",
                    }));
                  }
                }}
              >
                {linkageForm.submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : null}
                Create linkage
              </Button>
            </div>
          </div>

          {/* Links grouped by bot */}
          <div className="overflow-x-auto">
            {profileModelLinks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No profile/model links recorded yet.
              </p>
            ) : (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-2 px-2 text-left font-medium">Bot</th>
                    <th className="py-2 px-2 text-left font-medium">Revision</th>
                    <th className="py-2 px-2 text-left font-medium">Model run</th>
                    <th className="py-2 px-2 text-left font-medium">Role</th>
                    <th className="py-2 px-2 text-left font-medium">Created</th>
                    <th className="py-2 px-2 text-left font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {profileModelLinks.map((l) => {
                    const rev = profileRevisions.find((r) => r.id === l.profileRevisionId);
                    const isIntended = l.linkageRole === "INTENDED_ACTIVE";
                    return (
                      <tr
                        key={l.id}
                        className={cn(
                          "border-b border-border/40",
                          isIntended && "bg-emerald-500/5"
                        )}
                      >
                        <td className="py-2 px-2 font-mono">{l.botType}</td>
                        <td className="py-2 px-2 font-mono">
                          {rev?.revisionKey ?? "unknown"}
                        </td>
                        <td className="py-2 px-2 font-mono" title={l.modelRunId}>
                          {formatCompactId(l.modelRunId)}
                        </td>
                        <td className="py-2 px-2">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                              l.linkageRole === "INTENDED_ACTIVE"
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : l.linkageRole === "EVALUATED_WITH"
                                  ? "bg-sky-500/10 text-sky-700 dark:text-sky-400"
                                  : "bg-muted text-muted-foreground"
                            )}
                          >
                            {l.linkageRole}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-muted-foreground">
                          {new Date(l.createdAt).toLocaleString()}
                        </td>
                        <td className="py-2 px-2 text-muted-foreground max-w-[200px] truncate">
                          {l.notes ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function formatCompactId(id: string | null | undefined): string {
  if (!id) return "—";
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function formatSnapshotId(json: string | null | undefined): string {
  if (!json) return "snap-unknown";
  try {
    const hash = btoa(json).replace(/=+$/, "");
    return `snap-${hash.slice(0, 8)}`;
  } catch {
    return "snap-err";
  }
}

function EquityChart({ data }: { data: EquityPoint[] }) {
  if (data.length === 0) return null;
  const values = data.map((d) => d.cumulativePnlPct);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const width = 800;
  const height = 200;
  const padding = { top: 10, right: 10, bottom: 20, left: 40 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const x = (i: number) =>
    padding.left + (i / Math.max(1, data.length - 1)) * innerW;
  const y = (v: number) =>
    padding.top + innerH - ((v - min) / range) * innerH;

  const pathD = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.cumulativePnlPct)}`)
    .join(" ");
  const zeroY = y(0);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-full"
      preserveAspectRatio="none"
    >
      <line
        x1={padding.left}
        y1={zeroY}
        x2={width - padding.right}
        y2={zeroY}
        stroke="var(--muted-foreground)"
        strokeDasharray="4"
        opacity={0.6}
      />
      <path
        d={pathD}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
