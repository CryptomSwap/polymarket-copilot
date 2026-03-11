"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { RefreshCw, Loader2, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// Types matching GET /api/bot/dry-run response
interface BotGuardrailConfig {
  blockUnresolvedCatalog: boolean;
  blockStaleSync: boolean;
  perMarketCapPct: number;
  perThemeCapPct: number;
  nearResolutionBlockHours: number;
  allowNearResolutionAdd: boolean;
  duplicateThesisThemeCapPct: number;
}

interface BotCandidate {
  recommendationId: string;
  marketId: string;
  assetId: string;
  outcome: string;
  side: "BUY" | "SELL";
  limitPrice: string;
  size: string;
  primaryActionType: string | null;
  policyState: string;
  finalSuggestedSize: string;
  marketTitle: string | null;
  marketTheme?: string | null;
}

interface GuardrailResult {
  allowed: boolean;
  reason: string;
  failures: string[];
}

interface RegimeSnapshot {
  regime: { regime: string; explanation: string };
  signals: {
    meanReversionBuyCandidate: boolean;
    meanReversionSellCandidate: boolean;
    breakoutRisk: boolean;
    explanation: string[];
  };
}

interface DryRunCandidate {
  candidate: BotCandidate;
  executionKey: string;
  guardrail: GuardrailResult;
  regimeSnapshot?: RegimeSnapshot | null;
}

interface DryRunResult {
  mode: string;
  funderAddress: string;
  at: string;
  config: BotGuardrailConfig;
  candidates: DryRunCandidate[];
  summary: { total: number; allowed: number; blocked: number };
}

// Recommendation detail from GET /api/recommendations/[id] (for drawer)
interface RecommendationDetail {
  recommendation: {
    rationale: string | null;
    portfolioImpact: string | null;
    riskNote: string | null;
    timingNote: string | null;
    qualityBlocker: string | null;
  };
  signal: { thesis: string | null; invalidation: string | null };
  recommendationDiagnostics: {
    isHeld: boolean;
    categoryExposurePct: number;
    themeExposurePct: number;
    timeToResolutionDays: number | null;
    nearResolutionCount: number;
    staleCount: number;
    unresolvedCount: number;
  } | null;
}

const PRIMARY_ACTION_LABELS: Record<string, string> = {
  add: "Add",
  review_existing: "Review existing",
  trim: "Trim",
  hedge: "Hedge",
  avoid: "Avoid",
  monitor: "Monitor",
  sync_first: "Sync first",
};

// Approval Queue entry (from GET /api/bot/approval-queue)
interface ApprovalQueueEntryRow {
  id: string;
  funderAddress: string;
  idempotencyKey: string;
  recommendationId: string;
  marketId: string;
  assetId: string;
  outcome: string;
  side: string;
  limitPrice: string;
  size: string;
  marketTitle: string | null;
  status: string;
  reason: string | null;
  orderIntentId: string | null;
  createdAt: string;
  updatedAt: string;
}

function formatPct(val: string): string {
  const n = parseFloat(val);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function formatPrice(val: string): string {
  const n = parseFloat(val);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}¢`;
}

export default function BotCommandCenterPage() {
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeRegime, setIncludeRegime] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "allowed" | "blocked">("all");
  const [actionTypeFilter, setActionTypeFilter] = useState<string>("");
  const [failureFilter, setFailureFilter] = useState<string>("");
  const [selected, setSelected] = useState<DryRunCandidate | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailData, setDetailData] = useState<RecommendationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Approval Queue
  const [queueEntries, setQueueEntries] = useState<ApprovalQueueEntryRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [queueMessage, setQueueMessage] = useState<string | null>(null);
  const [previewForKey, setPreviewForKey] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{ postTopPct?: number; postThemePct?: number } | null>(null);

  // Execute modal (for APPROVED entries)
  const [executeEntry, setExecuteEntry] = useState<ApprovalQueueEntryRow | null>(null);
  const [precheck, setPrecheck] = useState<{
    guardrailAllowed: boolean;
    guardrailReason: string;
    guardrailFailures: string[];
    credentialsOk: boolean;
    connectionOk: boolean;
    previewValid: boolean;
    riskPreview: { concentrationImpact?: { postTopPct?: number; postThemePct?: number }; blocked?: boolean; warnings?: string[] } | null;
    validationErrors: string[];
  } | null>(null);
  const [precheckLoading, setPrecheckLoading] = useState(false);
  const [executeLoading, setExecuteLoading] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);

  // Execution telemetry
  // Bot policy config (guardrails)
  const [policyConfig, setPolicyConfig] = useState<{
    blockUnresolvedCatalog: boolean;
    blockStaleSync: boolean;
    perMarketCapPct: number;
    perThemeCapPct: number;
    nearResolutionBlockHours: number;
    allowNearResolutionAdd: boolean;
    duplicateThesisThemeCapPct: number;
    updatedAt: string | null;
  } | null>(null);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);

  const [telemetry, setTelemetry] = useState<{
    totalAttempts: number;
    successCount: number;
    failedCount: number;
    successRatePct: number | null;
    lastExecutionAt: string | null;
    topFailureReasons: Array<{ reason: string; count: number }>;
    recentAttempts: Array<{
      id: string;
      queueEntryId: string;
      resultStatus: string;
      errorMessage: string | null;
      orderIntentId: string | null;
      createdAt: string;
    }>;
  } | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);

  // Strategy backtest
  const [backtestStart, setBacktestStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [backtestEnd, setBacktestEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [backtestResult, setBacktestResult] = useState<{
    metrics: {
      totalTrades: number;
      winCount: number;
      lossCount: number;
      winRate: number | null;
      averageWinPct: number | null;
      averageLossPct: number | null;
      expectancyPct: number | null;
      drawdownProxyPct: number | null;
      averageHoldHours: number | null;
      blockedByReason: Array<{ reason: string; count: number }>;
    };
    trades: Array<{
      marketId: string;
      assetId: string;
      entryAt: string;
      exitAt: string;
      entryPrice: number;
      exitPrice: number;
      pnlPct: number;
      exitReason: string;
    }>;
    runAt: string;
  } | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [backtestError, setBacktestError] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      const res = await fetch("/api/bot/approval-queue");
      const data = await res.json();
      if (res.ok && Array.isArray(data.entries)) setQueueEntries(data.entries);
      else setQueueEntries([]);
    } catch {
      setQueueEntries([]);
    } finally {
      setQueueLoading(false);
    }
  }, []);

  // Readiness: portfolio intelligence + connection/credentials (for strip)
  const [readiness, setReadiness] = useState<{
    positions: { resolved: number; total: number } | null;
    staleCount: number | null;
    unresolvedCount: number | null;
    credentialsExist: boolean | null;
    walletConnected: boolean | null;
  }>({ positions: null, staleCount: null, unresolvedCount: null, credentialsExist: null, walletConnected: null });
  const [readinessLoading, setReadinessLoading] = useState(true);

  const fetchReadiness = useCallback(async () => {
    setReadinessLoading(true);
    try {
      const [healthRes, intelRes] = await Promise.all([
        fetch("/api/polymarket/health"),
        fetch("/api/portfolio/intelligence"),
      ]);
      const health = healthRes.ok ? await healthRes.json() : null;
      const intel = intelRes.ok ? await intelRes.json() : null;
      const summary = intel?.intelligence?.summary;
      setReadiness({
        positions: summary
          ? { resolved: summary.resolvedPositions ?? 0, total: summary.totalPositions ?? 0 }
          : null,
        staleCount: summary != null ? (summary.stalePositions ?? 0) : null,
        unresolvedCount: summary != null ? (summary.unresolvedPositions ?? 0) : null,
        credentialsExist: health?.credentialsExist ?? null,
        walletConnected: health?.walletConnectionExists ?? null,
      });
    } catch {
      setReadiness({
        positions: null,
        staleCount: null,
        unresolvedCount: null,
        credentialsExist: null,
        walletConnected: null,
      });
    } finally {
      setReadinessLoading(false);
    }
  }, []);

  const fetchDryRun = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/bot/dry-run${includeRegime ? "?regime=1" : ""}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? data.detail ?? "Dry-run failed.");
        setResult(null);
        return;
      }
      setResult(data as DryRunResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
      setResult(null);
    } finally {
      setLoading(false);
    }
    void fetchReadiness();
  }, [includeRegime, fetchReadiness]);

  useEffect(() => {
    fetchDryRun();
  }, [fetchDryRun]);

  useEffect(() => {
    fetchReadiness();
  }, [fetchReadiness]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  const fetchTelemetry = useCallback(async () => {
    setTelemetryLoading(true);
    try {
      const res = await fetch("/api/bot/execution-telemetry");
      const data = await res.json();
      if (res.ok && data != null && typeof data.totalAttempts === "number") setTelemetry(data);
      else setTelemetry(null);
    } catch {
      setTelemetry(null);
    } finally {
      setTelemetryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTelemetry();
  }, [fetchTelemetry]);

  const fetchPolicyConfig = useCallback(async () => {
    setPolicyLoading(true);
    try {
      const res = await fetch("/api/bot/policy-config");
      const data = await res.json();
      if (res.ok && data != null) setPolicyConfig(data);
      else setPolicyConfig(null);
    } catch {
      setPolicyConfig(null);
    } finally {
      setPolicyLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPolicyConfig();
  }, [fetchPolicyConfig]);

  const runBacktest = useCallback(async () => {
    setBacktestLoading(true);
    setBacktestError(null);
    setBacktestResult(null);
    try {
      const res = await fetch("/api/backtest/mean-reversion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: `${backtestStart}T00:00:00.000Z`,
          endDate: `${backtestEnd}T23:59:59.999Z`,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBacktestError(data.error ?? data.detail ?? "Backtest failed.");
        return;
      }
      setBacktestResult({
        metrics: data.metrics,
        trades: (data.trades ?? []).map((t: { entryAt: string; exitAt: string; [k: string]: unknown }) => ({
          ...t,
          entryAt: typeof t.entryAt === "string" ? t.entryAt : new Date(t.entryAt).toISOString(),
          exitAt: typeof t.exitAt === "string" ? t.exitAt : new Date(t.exitAt).toISOString(),
        })),
        runAt: data.runAt ?? new Date().toISOString(),
      });
    } catch (e) {
      setBacktestError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBacktestLoading(false);
    }
  }, [backtestStart, backtestEnd]);

  useEffect(() => {
    if (!executeEntry) {
      setPrecheck(null);
      setExecuteError(null);
      return;
    }
    setPrecheckLoading(true);
    setPrecheck(null);
    setExecuteError(null);
    fetch(`/api/bot/approval-queue/${executeEntry.id}/precheck`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) setPrecheck(data);
        else setPrecheck(null);
      })
      .catch(() => setPrecheck(null))
      .finally(() => setPrecheckLoading(false));
  }, [executeEntry?.id]);

  const addToQueuePayload = (row: DryRunCandidate) => ({
    recommendationId: row.candidate.recommendationId,
    marketId: row.candidate.marketId,
    assetId: row.candidate.assetId,
    outcome: row.candidate.outcome,
    side: row.candidate.side,
    limitPrice: row.candidate.limitPrice,
    size: row.candidate.finalSuggestedSize,
    marketTitle: row.candidate.marketTitle ?? null,
  });

  const runAddToQueue = async (row: DryRunCandidate) => {
    const key = row.executionKey;
    setActionKey(key);
    setQueueMessage(null);
    try {
      const res = await fetch("/api/bot/approval-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addToQueuePayload(row)),
      });
      const data = await res.json();
      if (!res.ok) {
        setQueueMessage(data.error ?? "Failed to add to queue.");
        return;
      }
      setQueueMessage("Added to queue.");
      await fetchQueue();
      setPreviewForKey(key);
      const previewRes = await fetch("/api/orders/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId: row.candidate.marketId,
          assetId: row.candidate.assetId,
          outcome: row.candidate.outcome,
          side: row.candidate.side,
          limitPrice: row.candidate.limitPrice,
          size: row.candidate.finalSuggestedSize,
          recommendationId: row.candidate.recommendationId,
        }),
      });
      const previewJson = await previewRes.json();
      if (previewJson?.riskPreview?.concentrationImpact) {
        setPreviewData({
          postTopPct: previewJson.riskPreview.concentrationImpact.postTopPct,
          postThemePct: previewJson.riskPreview.concentrationImpact.postThemePct,
        });
      } else setPreviewData(null);
    } finally {
      setActionKey(null);
    }
  };

  const runApprove = async (row: DryRunCandidate) => {
    const key = row.executionKey;
    setActionKey(key);
    setQueueMessage(null);
    try {
      const addRes = await fetch("/api/bot/approval-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addToQueuePayload(row)),
      });
      const addData = await addRes.json();
      if (!addRes.ok) {
        setQueueMessage(addData.error ?? "Failed to add to queue.");
        return;
      }
      const entryId = addData.id;
      const approveRes = await fetch(`/api/bot/approval-queue/${entryId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!approveRes.ok) {
        const err = await approveRes.json();
        setQueueMessage(err.error ?? "Failed to approve.");
        return;
      }
      setQueueMessage("Approved (no execution in v1).");
      await fetchQueue();
      setPreviewForKey(key);
      const previewRes = await fetch("/api/orders/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId: row.candidate.marketId,
          assetId: row.candidate.assetId,
          outcome: row.candidate.outcome,
          side: row.candidate.side,
          limitPrice: row.candidate.limitPrice,
          size: row.candidate.finalSuggestedSize,
          recommendationId: row.candidate.recommendationId,
        }),
      });
      const previewJson = await previewRes.json();
      if (previewJson?.riskPreview?.concentrationImpact) {
        setPreviewData({
          postTopPct: previewJson.riskPreview.concentrationImpact.postTopPct,
          postThemePct: previewJson.riskPreview.concentrationImpact.postThemePct,
        });
      } else setPreviewData(null);
    } finally {
      setActionKey(null);
    }
  };

  const runReject = async (row: DryRunCandidate, reason?: string) => {
    const key = row.executionKey;
    setActionKey(key);
    setQueueMessage(null);
    try {
      const addRes = await fetch("/api/bot/approval-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addToQueuePayload(row)),
      });
      const addData = await addRes.json();
      if (!addRes.ok) {
        setQueueMessage(addData.error ?? "Failed to add to queue.");
        return;
      }
      const entryId = addData.id;
      const rejectRes = await fetch(`/api/bot/approval-queue/${entryId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason ?? null }),
      });
      if (!rejectRes.ok) {
        const err = await rejectRes.json();
        setQueueMessage(err.error ?? "Failed to reject.");
        return;
      }
      setQueueMessage("Rejected.");
      await fetchQueue();
    } finally {
      setActionKey(null);
    }
  };

  // When opening detail drawer, fetch recommendation context
  useEffect(() => {
    if (!selected || !detailOpen) {
      setDetailData(null);
      return;
    }
    setDetailLoading(true);
    setDetailData(null);
    fetch(`/api/recommendations/${selected.candidate.recommendationId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json?.recommendation != null) {
          setDetailData({
            recommendation: json.recommendation,
            signal: json.signal ?? { thesis: null, invalidation: null },
            recommendationDiagnostics: json.recommendationDiagnostics ?? null,
          });
        } else {
          setDetailData(null);
        }
      })
      .catch(() => setDetailData(null))
      .finally(() => setDetailLoading(false));
  }, [selected?.candidate.recommendationId, detailOpen]);

  const openDetail = (row: DryRunCandidate) => {
    setSelected(row);
    setDetailOpen(true);
  };

  const filteredCandidates = result?.candidates?.filter((row) => {
    if (statusFilter === "allowed" && !row.guardrail.allowed) return false;
    if (statusFilter === "blocked" && row.guardrail.allowed) return false;
    if (actionTypeFilter && (row.candidate.primaryActionType ?? "") !== actionTypeFilter) return false;
    if (failureFilter) {
      const hasFailure = row.guardrail.failures?.some((f) => f === failureFilter);
      if (!hasFailure) return false;
    }
    return true;
  }) ?? [];

  const actionTypes = Array.from(
    new Set(
      (result?.candidates ?? []).map((r) => r.candidate.primaryActionType ?? "").filter(Boolean)
    )
  ).sort();

  const failureReasons = Array.from(
    new Set((result?.candidates ?? []).flatMap((r) => r.guardrail.failures ?? []))
  ).sort();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">
            Bot Command Center
          </h2>
          <p className="text-muted-foreground">
            Review dry-run candidates and guardrail results. No live execution.
          </p>
          {result && (
            <p className="mt-1 text-xs text-muted-foreground">
              Funder {result.funderAddress.slice(0, 6)}…{result.funderAddress.slice(-4)} · Run at{" "}
              {new Date(result.at).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={includeRegime}
              onChange={(e) => setIncludeRegime(e.target.checked)}
              className="rounded border-border"
            />
            Include regime
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchDryRun}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            Refresh dry-run
          </Button>
        </div>
      </div>

      {/* Bot Readiness strip */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-sm">
        <span className="font-medium text-muted-foreground">Readiness</span>
        {readinessLoading ? (
          <span className="text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
          </span>
        ) : (
          <>
            <span className="text-foreground" title="Resolved positions in catalog / total positions">
              Positions:{" "}
              {readiness.positions != null ? (
                <span className="tabular-nums font-medium">
                  {readiness.positions.resolved}/{readiness.positions.total}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
            <span className="text-foreground" title="Positions with stale sync">
              Stale:{" "}
              {readiness.staleCount != null ? (
                <span className={cn("tabular-nums font-medium", readiness.staleCount > 0 && "text-amber-600 dark:text-amber-400")}>
                  {readiness.staleCount}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
            <span className="text-foreground" title="Positions not resolved to catalog">
              Unresolved:{" "}
              {readiness.unresolvedCount != null ? (
                <span className={cn("tabular-nums font-medium", readiness.unresolvedCount > 0 && "text-amber-600 dark:text-amber-400")}>
                  {readiness.unresolvedCount}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
            <span className="text-foreground" title="Wallet connection saved (funder address)">
              Wallet:{" "}
              {readiness.walletConnected === true ? (
                <span className="font-medium text-emerald-600 dark:text-emerald-400">Connected</span>
              ) : readiness.walletConnected === false ? (
                <span className="font-medium text-amber-600 dark:text-amber-400">—</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
            <span className="text-foreground" title="Signer credentials stored for order placement">
              Credentials:{" "}
              {readiness.credentialsExist === true ? (
                <span className="font-medium text-emerald-600 dark:text-emerald-400">Valid</span>
              ) : readiness.credentialsExist === false ? (
                <span className="font-medium text-amber-600 dark:text-amber-400">None</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
            <span className="text-foreground" title="Guardrails applied in dry-run">
              Guardrails: <span className="font-medium text-emerald-600 dark:text-emerald-400">Active</span>
            </span>
          </>
        )}
      </div>

      {/* Bot Policy config */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bot Policy</CardTitle>
          <CardDescription>
            Guardrail config used by dry-run, precheck, and execute. Edit and save to apply.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {policyLoading ? (
            <p className="text-sm text-muted-foreground py-2">Loading…</p>
          ) : policyConfig ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-muted-foreground">Per-market cap %</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    className="w-20 rounded border border-input bg-background px-2 py-1 text-right tabular-nums"
                    value={policyConfig.perMarketCapPct}
                    onChange={(e) => setPolicyConfig((p) => p ? { ...p, perMarketCapPct: parseFloat(e.target.value) || 0 } : null)}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-muted-foreground">Per-theme cap %</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    className="w-20 rounded border border-input bg-background px-2 py-1 text-right tabular-nums"
                    value={policyConfig.perThemeCapPct}
                    onChange={(e) => setPolicyConfig((p) => p ? { ...p, perThemeCapPct: parseFloat(e.target.value) || 0 } : null)}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-muted-foreground">Near-resolution block (h)</label>
                  <input
                    type="number"
                    min={0}
                    max={720}
                    step={1}
                    className="w-20 rounded border border-input bg-background px-2 py-1 text-right tabular-nums"
                    value={policyConfig.nearResolutionBlockHours}
                    onChange={(e) => setPolicyConfig((p) => p ? { ...p, nearResolutionBlockHours: parseFloat(e.target.value) || 0 } : null)}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-muted-foreground">Duplicate-thesis theme cap %</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    className="w-20 rounded border border-input bg-background px-2 py-1 text-right tabular-nums"
                    value={policyConfig.duplicateThesisThemeCapPct}
                    onChange={(e) => setPolicyConfig((p) => p ? { ...p, duplicateThesisThemeCapPct: parseFloat(e.target.value) || 0 } : null)}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-muted-foreground">Allow add near resolution</label>
                  <input
                    type="checkbox"
                    className="rounded border-input"
                    checked={policyConfig.allowNearResolutionAdd}
                    onChange={(e) => setPolicyConfig((p) => p ? { ...p, allowNearResolutionAdd: e.target.checked } : null)}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-muted-foreground">Block stale sync</label>
                  <input
                    type="checkbox"
                    className="rounded border-input"
                    checked={policyConfig.blockStaleSync}
                    onChange={(e) => setPolicyConfig((p) => p ? { ...p, blockStaleSync: e.target.checked } : null)}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-muted-foreground">Block unresolved catalog</label>
                  <input
                    type="checkbox"
                    className="rounded border-input"
                    checked={policyConfig.blockUnresolvedCatalog}
                    onChange={(e) => setPolicyConfig((p) => p ? { ...p, blockUnresolvedCatalog: e.target.checked } : null)}
                  />
                </div>
              </div>
              {policyConfig.updatedAt && (
                <p className="text-xs text-muted-foreground">Last saved: {new Date(policyConfig.updatedAt).toLocaleString()}</p>
              )}
              <Button
                size="sm"
                disabled={policySaving}
                onClick={async () => {
                  if (!policyConfig) return;
                  setPolicySaving(true);
                  try {
                    const res = await fetch("/api/bot/policy-config", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        perMarketCapPct: policyConfig.perMarketCapPct,
                        perThemeCapPct: policyConfig.perThemeCapPct,
                        nearResolutionBlockHours: policyConfig.nearResolutionBlockHours,
                        allowNearResolutionAdd: policyConfig.allowNearResolutionAdd,
                        duplicateThesisThemeCapPct: policyConfig.duplicateThesisThemeCapPct,
                        blockStaleSync: policyConfig.blockStaleSync,
                        blockUnresolvedCatalog: policyConfig.blockUnresolvedCatalog,
                      }),
                    });
                    const data = await res.json();
                    if (res.ok) setPolicyConfig(data);
                  } finally {
                    setPolicySaving(false);
                  }
                }}
              >
                {policySaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                Save policy
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-2">Could not load policy. Using defaults.</p>
          )}
        </CardContent>
      </Card>

      {/* Strategy backtest */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Strategy backtest</CardTitle>
          <CardDescription>
            Simulate mean-reversion strategy on historical snapshots. Entry: range regime, near lower band, liquidity OK. Exit: near high, target profit, regime change, or max hold. No live execution.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">From</span>
              <input
                type="date"
                className="rounded border border-input bg-background px-2 py-1 text-sm"
                value={backtestStart}
                onChange={(e) => setBacktestStart(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">To</span>
              <input
                type="date"
                className="rounded border border-input bg-background px-2 py-1 text-sm"
                value={backtestEnd}
                onChange={(e) => setBacktestEnd(e.target.value)}
              />
            </label>
            <Button size="sm" onClick={runBacktest} disabled={backtestLoading}>
              {backtestLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Run backtest
            </Button>
          </div>
          {backtestError && (
            <p className="text-sm text-destructive">{backtestError}</p>
          )}
          {backtestResult && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="rounded border border-border p-2">
                  <p className="text-muted-foreground text-xs">Trades</p>
                  <p className="font-medium tabular-nums">{backtestResult.metrics.totalTrades}</p>
                </div>
                <div className="rounded border border-border p-2">
                  <p className="text-muted-foreground text-xs">Win rate</p>
                  <p className="font-medium tabular-nums">
                    {backtestResult.metrics.winRate != null ? `${(backtestResult.metrics.winRate * 100).toFixed(1)}%` : "—"}
                  </p>
                </div>
                <div className="rounded border border-border p-2">
                  <p className="text-muted-foreground text-xs">Avg win</p>
                  <p className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                    {backtestResult.metrics.averageWinPct != null ? `${(backtestResult.metrics.averageWinPct * 100).toFixed(2)}%` : "—"}
                  </p>
                </div>
                <div className="rounded border border-border p-2">
                  <p className="text-muted-foreground text-xs">Avg loss</p>
                  <p className="font-medium tabular-nums text-amber-600 dark:text-amber-400">
                    {backtestResult.metrics.averageLossPct != null ? `${(backtestResult.metrics.averageLossPct * 100).toFixed(2)}%` : "—"}
                  </p>
                </div>
                <div className="rounded border border-border p-2">
                  <p className="text-muted-foreground text-xs">Expectancy</p>
                  <p className="font-medium tabular-nums">
                    {backtestResult.metrics.expectancyPct != null ? `${(backtestResult.metrics.expectancyPct * 100).toFixed(2)}%` : "—"}
                  </p>
                </div>
                <div className="rounded border border-border p-2">
                  <p className="text-muted-foreground text-xs">Drawdown proxy</p>
                  <p className="font-medium tabular-nums">
                    {backtestResult.metrics.drawdownProxyPct != null ? `${(backtestResult.metrics.drawdownProxyPct * 100).toFixed(2)}%` : "—"}
                  </p>
                </div>
                <div className="rounded border border-border p-2">
                  <p className="text-muted-foreground text-xs">Avg hold (h)</p>
                  <p className="font-medium tabular-nums">
                    {backtestResult.metrics.averageHoldHours != null ? backtestResult.metrics.averageHoldHours.toFixed(1) : "—"}
                  </p>
                </div>
              </div>
              {backtestResult.metrics.blockedByReason.length > 0 && (
                <div>
                  <p className="text-muted-foreground text-xs mb-1">Blocked entries by reason</p>
                  <ul className="flex flex-wrap gap-2">
                    {backtestResult.metrics.blockedByReason.map((b) => (
                      <li key={b.reason} className="rounded bg-muted px-2 py-0.5 text-xs">
                        {b.reason}: {b.count}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {backtestResult.trades.length > 0 && (
                <div>
                  <p className="text-muted-foreground text-xs mb-1">Trades ({backtestResult.trades.length})</p>
                  <div className="max-h-40 overflow-y-auto rounded border border-border text-xs">
                    <table className="w-full border-collapse">
                      <thead className="sticky top-0 bg-muted/80">
                        <tr>
                          <th className="text-left py-1 px-2 font-medium">Market</th>
                          <th className="text-right py-1 px-2 font-medium">PnL%</th>
                          <th className="text-left py-1 px-2 font-medium">Exit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {backtestResult.trades.slice(0, 20).map((t, i) => (
                          <tr key={i} className="border-t border-border/50">
                            <td className="py-1 px-2 truncate max-w-[120px]" title={t.marketId}>{t.marketId.slice(0, 8)}…</td>
                            <td className={cn("py-1 px-2 text-right tabular-nums", t.pnlPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>
                              {(t.pnlPct * 100).toFixed(2)}%
                            </td>
                            <td className="py-1 px-2 text-muted-foreground">{t.exitReason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {backtestResult.trades.length > 20 && (
                      <p className="text-muted-foreground text-xs py-1 px-2 border-t border-border">+{backtestResult.trades.length - 20} more</p>
                    )}
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">Run at {new Date(backtestResult.runAt).toLocaleString()}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="py-4">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {result && !error && (
        <>
          {/* Summary cards */}
          <div className="grid gap-3 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-medium text-muted-foreground">
                  Total candidates
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tabular-nums">{result.summary.total}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-medium text-muted-foreground">
                  Allowed
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {result.summary.allowed}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-medium text-muted-foreground">
                  Blocked
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                  {result.summary.blocked}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Filters */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Filters</CardTitle>
              <CardDescription>Narrow by status, action type, or guardrail failure.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Status</label>
                <select
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm min-w-[120px]"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as "all" | "allowed" | "blocked")}
                >
                  <option value="all">All</option>
                  <option value="allowed">Allowed only</option>
                  <option value="blocked">Blocked only</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Action type</label>
                <select
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm min-w-[140px]"
                  value={actionTypeFilter}
                  onChange={(e) => setActionTypeFilter(e.target.value)}
                >
                  <option value="">All</option>
                  {actionTypes.map((a) => (
                    <option key={a} value={a}>
                      {PRIMARY_ACTION_LABELS[a] ?? a}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground">Failure reason</label>
                <select
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={failureFilter}
                  onChange={(e) => setFailureFilter(e.target.value)}
                >
                  <option value="">All</option>
                  {failureReasons.map((f) => (
                    <option key={f} value={f}>
                      {f.length > 48 ? f.slice(0, 45) + "…" : f}
                    </option>
                  ))}
                </select>
              </div>
            </CardContent>
          </Card>

          {/* Candidates table */}
          <Card>
            <CardHeader>
              <CardTitle>Candidates</CardTitle>
              <CardDescription>
                {filteredCandidates.length} of {result.candidates.length} shown. Click a row to open detail.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {result.candidates.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No candidates. Run recompute and ensure you have recommendations with allowed policy states.
                </p>
              ) : filteredCandidates.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No candidates match the current filters.
                </p>
              ) : (
                <div className="overflow-x-auto -mx-4 sm:mx-0">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 px-2 font-medium w-[72px]">Status</th>
                        <th className="text-left py-2 px-2 font-medium w-[88px]">Action</th>
                        <th className="text-left py-2 px-2 font-medium min-w-[160px]">Market</th>
                        <th className="text-left py-2 px-2 font-medium w-[72px]">Side</th>
                        <th className="text-left py-2 px-2 font-medium w-[72px]">Outcome</th>
                        <th className="text-right py-2 px-2 font-medium w-[72px]">Size</th>
                        <th className="text-right py-2 px-2 font-medium w-[64px]">Price</th>
                        <th className="text-left py-2 px-2 font-medium max-w-[140px]">Execution key</th>
                        <th className="text-left py-2 px-2 font-medium min-w-[100px]">Regime</th>
                        <th className="text-left py-2 px-2 font-medium min-w-[120px]">Guardrail</th>
                        <th className="text-left py-2 px-2 font-medium w-[140px]">Queue</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCandidates.map((row) => (
                        <tr
                          key={row.executionKey}
                          className={cn(
                            "border-b border-border/50 hover:bg-muted/50 cursor-pointer",
                            selected?.executionKey === row.executionKey && "bg-muted/70"
                          )}
                          onClick={() => openDetail(row)}
                        >
                          <td className="py-2 px-2 align-top">
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-xs font-medium",
                                row.guardrail.allowed
                                  ? "bg-emerald-600/20 text-emerald-700 dark:text-emerald-400"
                                  : "bg-amber-600/20 text-amber-700 dark:text-amber-400"
                              )}
                            >
                              {row.guardrail.allowed ? "Allowed" : "Blocked"}
                            </span>
                          </td>
                          <td className="py-2 px-2 align-top">
                            <span className="text-xs">
                              {PRIMARY_ACTION_LABELS[row.candidate.primaryActionType ?? ""] ?? row.candidate.primaryActionType ?? "—"}
                            </span>
                          </td>
                          <td className="py-2 px-2 max-w-[200px] truncate align-top" title={row.candidate.marketTitle ?? undefined}>
                            <Link
                              href={`/recommendations/${row.candidate.recommendationId}`}
                              className="hover:underline truncate block font-medium"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {row.candidate.marketTitle ?? "—"}
                            </Link>
                          </td>
                          <td className="py-2 px-2 align-top font-medium">{row.candidate.side}</td>
                          <td className="py-2 px-2 align-top text-muted-foreground">{row.candidate.outcome ?? "—"}</td>
                          <td className="py-2 px-2 text-right tabular-nums align-top">
                            {formatPct(row.candidate.finalSuggestedSize)}
                          </td>
                          <td className="py-2 px-2 text-right tabular-nums align-top">
                            {formatPrice(row.candidate.limitPrice)}
                          </td>
                          <td className="py-2 px-2 font-mono text-[11px] text-muted-foreground truncate max-w-[140px] align-top" title={row.executionKey}>
                            {row.executionKey.slice(0, 20)}…
                          </td>
                          <td className="py-2 px-2 align-top">
                            {row.regimeSnapshot ? (
                              <div className="flex flex-col gap-0.5">
                                <span className="text-xs font-medium text-foreground" title={row.regimeSnapshot.regime.explanation}>
                                  {row.regimeSnapshot.regime.regime.replace(/_/g, " ")}
                                </span>
                                {(row.regimeSnapshot.signals.meanReversionBuyCandidate || row.regimeSnapshot.signals.meanReversionSellCandidate || row.regimeSnapshot.signals.breakoutRisk) && (
                                  <span className="text-[10px] text-muted-foreground">
                                    {row.regimeSnapshot.signals.meanReversionBuyCandidate && "Buy-low "}
                                    {row.regimeSnapshot.signals.meanReversionSellCandidate && "Sell-high "}
                                    {row.regimeSnapshot.signals.breakoutRisk && "Breakout risk"}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="py-2 px-2 align-top">
                            {row.guardrail.failures?.length ? (
                              <ul className="list-disc list-inside text-xs text-amber-600 dark:text-amber-400 space-y-0.5">
                                {row.guardrail.failures.slice(0, 2).map((f, i) => (
                                  <li key={i} className="truncate max-w-[180px]" title={f}>{f}</li>
                                ))}
                                {row.guardrail.failures.length > 2 && (
                                  <li className="text-muted-foreground">+{row.guardrail.failures.length - 2} more</li>
                                )}
                              </ul>
                            ) : (
                              <span className="text-xs text-muted-foreground">{row.guardrail.reason ?? "—"}</span>
                            )}
                          </td>
                          <td className="py-2 px-2 align-top" onClick={(e) => e.stopPropagation()}>
                            {row.guardrail.allowed ? (
                              <div className="flex flex-wrap gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs"
                                  disabled={actionKey === row.executionKey}
                                  onClick={() => runAddToQueue(row)}
                                >
                                  {actionKey === row.executionKey ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs text-emerald-600 dark:text-emerald-400"
                                  disabled={actionKey === row.executionKey}
                                  onClick={() => runApprove(row)}
                                >
                                  Approve
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs text-amber-600 dark:text-amber-400"
                                  disabled={actionKey === row.executionKey}
                                  onClick={() => {
                                    const reason = window.prompt("Rejection reason (optional):");
                                    runReject(row, reason ?? undefined);
                                  }}
                                >
                                  Reject
                                </Button>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="py-2 px-2 align-top">
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {queueMessage && (
            <p className={cn(
              "text-sm",
              queueMessage.startsWith("Added") && "text-emerald-600 dark:text-emerald-400",
              queueMessage.startsWith("Approved") && "text-emerald-600 dark:text-emerald-400",
              queueMessage.startsWith("Rejected") && "text-amber-600 dark:text-amber-400",
              queueMessage.startsWith("Failed") && "text-destructive"
            )}>
              {queueMessage}
              {previewData && previewForKey && (
                <span className="ml-2 text-muted-foreground">
                  Impact: top {previewData.postTopPct?.toFixed(0) ?? "—"}%, theme {previewData.postThemePct?.toFixed(0) ?? "—"}%
                </span>
              )}
            </p>
          )}

          {/* Approval Queue */}
          <Card>
            <CardHeader>
              <CardTitle>Approval Queue</CardTitle>
              <CardDescription>
                Entries from dry-run candidates. Approve or reject; no orders are placed in v1.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {queueLoading ? (
                <p className="text-sm text-muted-foreground py-4">Loading queue…</p>
              ) : queueEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">No queue entries. Use Add / Approve / Reject on allowed candidates above.</p>
              ) : (
                <div className="space-y-4">
                  {(["PENDING", "APPROVED", "REJECTED", "CANCELLED", "EXECUTED", "FAILED"] as const).map((status) => {
                    const byStatus = queueEntries.filter((e) => e.status === status);
                    if (byStatus.length === 0) return null;
                    return (
                      <div key={status}>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                          {status} ({byStatus.length})
                        </h4>
                        <div className="overflow-x-auto -mx-4 sm:mx-0">
                          <table className="w-full text-sm border-collapse">
                            <thead>
                              <tr className="border-b border-border">
                                <th className="text-left py-2 px-2 font-medium">Market</th>
                                <th className="text-left py-2 px-2 font-medium w-16">Side</th>
                                <th className="text-right py-2 px-2 font-medium w-14">Size</th>
                                <th className="text-right py-2 px-2 font-medium w-14">Price</th>
                                <th className="text-left py-2 px-2 font-medium max-w-[160px]">Reason</th>
                                <th className="text-right py-2 px-2 font-medium w-24">Updated</th>
                                {(status === "PENDING" || status === "APPROVED") && <th className="text-left py-2 px-2 font-medium w-32">Actions</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {byStatus.map((entry) => (
                                <tr key={entry.id} className="border-b border-border/50 hover:bg-muted/30">
                                  <td className="py-2 px-2 truncate max-w-[200px]" title={entry.marketTitle ?? undefined}>
                                    {entry.marketTitle ?? entry.idempotencyKey.slice(0, 20)}…
                                  </td>
                                  <td className="py-2 px-2 font-medium">{entry.side}</td>
                                  <td className="py-2 px-2 text-right tabular-nums">{formatPct(entry.size)}</td>
                                  <td className="py-2 px-2 text-right tabular-nums">{formatPrice(entry.limitPrice)}</td>
                                  <td className="py-2 px-2 text-muted-foreground truncate max-w-[160px]" title={entry.reason ?? undefined}>
                                    {entry.reason ?? "—"}
                                  </td>
                                  <td className="py-2 px-2 text-right text-muted-foreground text-xs">
                                    {new Date(entry.updatedAt).toLocaleString()}
                                  </td>
                                  {status === "PENDING" && (
                                    <td className="py-2 px-2">
                                      <div className="flex flex-wrap gap-1">
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-7 text-xs text-emerald-600 dark:text-emerald-400"
                                          disabled={actionKey === entry.id}
                                          onClick={async () => {
                                            setActionKey(entry.id);
                                            try {
                                              await fetch(`/api/bot/approval-queue/${entry.id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
                                              setQueueMessage("Approved (no execution in v1).");
                                              await fetchQueue();
                                            } finally {
                                              setActionKey(null);
                                            }
                                          }}
                                        >
                                          Approve
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-7 text-xs text-amber-600 dark:text-amber-400"
                                          disabled={actionKey === entry.id}
                                          onClick={async () => {
                                            const reason = window.prompt("Rejection reason (optional):");
                                            setActionKey(entry.id);
                                            try {
                                              await fetch(`/api/bot/approval-queue/${entry.id}/reject`, {
                                                method: "POST",
                                                headers: { "Content-Type": "application/json" },
                                                body: JSON.stringify({ reason: reason ?? undefined }),
                                              });
                                              setQueueMessage("Rejected.");
                                              await fetchQueue();
                                            } finally {
                                              setActionKey(null);
                                            }
                                          }}
                                        >
                                          Reject
                                        </Button>
                                      </div>
                                    </td>
                                  )}
                                  {status === "APPROVED" && (
                                    <td className="py-2 px-2">
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 text-xs"
                                        disabled={actionKey === entry.id || !!entry.orderIntentId}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setExecuteEntry(entry);
                                        }}
                                      >
                                        Execute
                                      </Button>
                                    </td>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Execute confirmation modal */}
          {executeEntry && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={() => !executeLoading && setExecuteEntry(null)}>
              <div className="bg-card border border-border rounded-lg shadow-lg max-w-md w-full p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-semibold text-foreground">Confirm execution</h3>
                <p className="text-sm text-muted-foreground">This will place the order. Revalidation runs before placement.</p>
                <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm space-y-1">
                  <p><span className="text-muted-foreground">Market:</span> {executeEntry.marketTitle ?? "—"}</p>
                  <p><span className="text-muted-foreground">Side / outcome:</span> {executeEntry.side} {executeEntry.outcome ?? "—"}</p>
                  <p><span className="text-muted-foreground">Size:</span> {formatPct(executeEntry.size)}</p>
                  <p><span className="text-muted-foreground">Limit price:</span> {formatPrice(executeEntry.limitPrice)}</p>
                  <p><span className="text-muted-foreground">Execution key:</span> <code className="text-xs break-all">{executeEntry.idempotencyKey}</code></p>
                </div>
                {precheckLoading ? (
                  <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Checking guardrails and impact…</p>
                ) : precheck ? (
                  <div className="space-y-2 text-sm">
                    <p>
                      <span className="text-muted-foreground">Guardrails:</span>{" "}
                      {precheck.guardrailAllowed ? (
                        <span className="text-emerald-600 dark:text-emerald-400">OK</span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400">{precheck.guardrailReason ?? precheck.guardrailFailures?.join("; ") ?? "Blocked"}</span>
                      )}
                    </p>
                    {precheck.credentialsOk && precheck.connectionOk ? (
                      <p className="text-muted-foreground">Credentials and connection: OK</p>
                    ) : (
                      <p className="text-amber-600 dark:text-amber-400">Credentials or connection missing.</p>
                    )}
                    {precheck.riskPreview?.concentrationImpact && (
                      <p className="text-muted-foreground">
                        Impact: top {precheck.riskPreview.concentrationImpact.postTopPct?.toFixed(0) ?? "—"}%, theme {precheck.riskPreview.concentrationImpact.postThemePct?.toFixed(0) ?? "—"}%
                      </p>
                    )}
                    {precheck.riskPreview?.blocked && (
                      <p className="text-amber-600 dark:text-amber-400">Order would be blocked by concentration rules.</p>
                    )}
                  </div>
                ) : null}
                {executeError && (
                  <p className="text-sm text-destructive">{executeError}</p>
                )}
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="ghost" size="sm" disabled={executeLoading} onClick={() => setExecuteEntry(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={executeLoading || precheckLoading || (precheck && (!precheck.guardrailAllowed || !precheck.credentialsOk || !precheck.connectionOk || precheck.riskPreview?.blocked))}
                    onClick={async () => {
                      if (!executeEntry) return;
                      setExecuteLoading(true);
                      setExecuteError(null);
                      try {
                        const res = await fetch(`/api/bot/approval-queue/${executeEntry.id}/execute`, { method: "POST" });
                        const data = await res.json();
                        if (res.ok && data.success) {
                          setExecuteEntry(null);
                          setQueueMessage("Executed.");
                          await fetchQueue();
                          await fetchTelemetry();
                        } else {
                          setExecuteError(data.error ?? "Execution failed.");
                        }
                      } catch (e) {
                        setExecuteError(e instanceof Error ? e.message : "Execution failed.");
                      } finally {
                        setExecuteLoading(false);
                      }
                    }}
                  >
                    {executeLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                    Execute
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Execution telemetry (inside result block so it appears with queue) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Execution telemetry</CardTitle>
              <CardDescription>
                Attempts and failure reasons. Tune policy and guardrails from this.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {telemetryLoading ? (
                <p className="text-sm text-muted-foreground py-4">Loading telemetry…</p>
              ) : !telemetry ? (
                <p className="text-sm text-muted-foreground py-4">No telemetry yet. Execute an approved entry to see data.</p>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    <div className="rounded border border-border bg-muted/20 p-2.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Attempts</p>
                      <p className="text-lg font-semibold tabular-nums">{telemetry.totalAttempts}</p>
                    </div>
                    <div className="rounded border border-border bg-muted/20 p-2.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Success</p>
                      <p className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{telemetry.successCount}</p>
                    </div>
                    <div className="rounded border border-border bg-muted/20 p-2.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Failed</p>
                      <p className="text-lg font-semibold tabular-nums text-amber-600 dark:text-amber-400">{telemetry.failedCount}</p>
                    </div>
                    <div className="rounded border border-border bg-muted/20 p-2.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Success rate</p>
                      <p className="text-lg font-semibold tabular-nums">{telemetry.successRatePct != null ? `${telemetry.successRatePct.toFixed(1)}%` : "—"}</p>
                    </div>
                    <div className="rounded border border-border bg-muted/20 p-2.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Last run</p>
                      <p className="text-sm font-medium tabular-nums truncate" title={telemetry.lastExecutionAt ?? undefined}>
                        {telemetry.lastExecutionAt ? new Date(telemetry.lastExecutionAt).toLocaleString() : "—"}
                      </p>
                    </div>
                  </div>
                  {telemetry.topFailureReasons.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Top failure reasons</h4>
                      <ul className="space-y-1 text-sm">
                        {telemetry.topFailureReasons.map(({ reason, count }, i) => (
                          <li key={i} className="flex justify-between gap-2 border-b border-border/50 pb-1 last:border-0">
                            <span className="truncate text-muted-foreground" title={reason}>{reason.length > 60 ? reason.slice(0, 57) + "…" : reason}</span>
                            <span className="shrink-0 tabular-nums font-medium text-amber-600 dark:text-amber-400">{count}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {telemetry.recentAttempts.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Recent attempts</h4>
                      <div className="overflow-x-auto -mx-4 sm:mx-0">
                        <table className="w-full text-sm border-collapse">
                          <thead>
                            <tr className="border-b border-border">
                              <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Time</th>
                              <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Result</th>
                              <th className="text-left py-1.5 px-2 font-medium text-muted-foreground max-w-[200px]">Error</th>
                            </tr>
                          </thead>
                          <tbody>
                            {telemetry.recentAttempts.slice(0, 10).map((a) => (
                              <tr key={a.id} className="border-b border-border/50">
                                <td className="py-1.5 px-2 text-muted-foreground whitespace-nowrap">{new Date(a.createdAt).toLocaleString()}</td>
                                <td className="py-1.5 px-2">
                                  <span className={cn(
                                    "rounded px-1.5 py-0.5 text-xs font-medium",
                                    a.resultStatus === "SUCCESS" && "bg-emerald-600/20 text-emerald-700 dark:text-emerald-400",
                                    a.resultStatus === "FAILED" && "bg-amber-600/20 text-amber-700 dark:text-amber-400"
                                  )}>
                                    {a.resultStatus}
                                  </span>
                                </td>
                                <td className="py-1.5 px-2 text-muted-foreground truncate max-w-[200px]" title={a.errorMessage ?? undefined}>
                                  {a.errorMessage ? (a.errorMessage.length > 50 ? a.errorMessage.slice(0, 47) + "…" : a.errorMessage) : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {loading && !result && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Detail drawer */}
      <Sheet
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) setSelected(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full sm:max-w-lg overflow-y-auto"
        >
          <SheetHeader className="border-b border-border pb-4">
            <SheetTitle className="text-base">
              Candidate detail
            </SheetTitle>
          </SheetHeader>
          {selected && (
            <div className="mt-4 space-y-6">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Order summary
                </h4>
                <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm space-y-1">
                  <p><span className="text-muted-foreground">Market:</span> {selected.candidate.marketTitle ?? "—"}</p>
                  <p><span className="text-muted-foreground">Side / outcome:</span> {selected.candidate.side} {selected.candidate.outcome ?? "—"}</p>
                  <p><span className="text-muted-foreground">Size:</span> {formatPct(selected.candidate.finalSuggestedSize)}</p>
                  <p><span className="text-muted-foreground">Limit price:</span> {formatPrice(selected.candidate.limitPrice)}</p>
                  <p><span className="text-muted-foreground">Execution key:</span> <code className="text-xs break-all">{selected.executionKey}</code></p>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Guardrail evaluation
                </h4>
                <div className="rounded-lg border border-border p-3 text-sm space-y-2">
                  <p>
                    <span className={selected.guardrail.allowed ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                      {selected.guardrail.allowed ? "Allowed" : "Blocked"}
                    </span>
                    {" · "}
                    <span className="text-muted-foreground">{selected.guardrail.reason}</span>
                  </p>
                  {selected.guardrail.failures?.length > 0 && (
                    <ul className="list-disc list-inside text-muted-foreground space-y-1">
                      {selected.guardrail.failures.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {selected.regimeSnapshot && (
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Regime
                  </h4>
                  <div className="rounded-lg border border-border p-3 text-sm space-y-2">
                    <p>
                      <span className="font-medium text-foreground">{selected.regimeSnapshot.regime.regime.replace(/_/g, " ")}</span>
                    </p>
                    <p className="text-muted-foreground text-xs">{selected.regimeSnapshot.regime.explanation}</p>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {selected.regimeSnapshot.signals.meanReversionBuyCandidate && (
                        <span className="rounded bg-emerald-600/20 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">Buy-low</span>
                      )}
                      {selected.regimeSnapshot.signals.meanReversionSellCandidate && (
                        <span className="rounded bg-amber-600/20 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">Sell-high</span>
                      )}
                      {selected.regimeSnapshot.signals.breakoutRisk && (
                        <span className="rounded bg-red-600/20 px-1.5 py-0.5 text-xs text-red-700 dark:text-red-400">Breakout risk</span>
                      )}
                    </div>
                    {selected.regimeSnapshot.signals.explanation?.length > 0 && (
                      <ul className="list-disc list-inside text-muted-foreground text-xs space-y-0.5">
                        {selected.regimeSnapshot.signals.explanation.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}

              {detailLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading recommendation context…
                </div>
              ) : detailData ? (
                <>
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Recommendation context
                    </h4>
                    <div className="rounded-lg border border-border p-3 text-sm space-y-2">
                      {detailData.recommendation.rationale ? (
                        <p><span className="text-muted-foreground">Rationale:</span> {detailData.recommendation.rationale}</p>
                      ) : null}
                      {detailData.recommendation.portfolioImpact ? (
                        <p><span className="text-muted-foreground">Portfolio impact:</span> {detailData.recommendation.portfolioImpact}</p>
                      ) : null}
                      {detailData.recommendation.riskNote ? (
                        <p><span className="text-muted-foreground">Risk note:</span> {detailData.recommendation.riskNote}</p>
                      ) : null}
                      {detailData.recommendation.timingNote ? (
                        <p><span className="text-muted-foreground">Timing:</span> {detailData.recommendation.timingNote}</p>
                      ) : null}
                      {detailData.recommendation.qualityBlocker ? (
                        <p className="text-amber-600 dark:text-amber-400"><span className="text-muted-foreground">Blocker:</span> {detailData.recommendation.qualityBlocker}</p>
                      ) : null}
                      {!detailData.recommendation.rationale && !detailData.recommendation.portfolioImpact && !detailData.recommendation.riskNote && !detailData.recommendation.timingNote && !detailData.recommendation.qualityBlocker && (
                        <p className="text-muted-foreground">No recommendation context available.</p>
                      )}
                    </div>
                  </div>

                  {(detailData.signal.thesis ?? detailData.signal.invalidation) && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                        Thesis
                      </h4>
                      <div className="rounded-lg border border-border p-3 text-sm space-y-2">
                        {detailData.signal.thesis && <p>{detailData.signal.thesis}</p>}
                        {detailData.signal.invalidation && (
                          <p className="text-muted-foreground"><span className="font-medium">Invalidation:</span> {detailData.signal.invalidation}</p>
                        )}
                      </div>
                    </div>
                  )}

                  {detailData.recommendationDiagnostics && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                        Portfolio context
                      </h4>
                      <div className="rounded-lg border border-border p-3 text-sm space-y-1">
                        <p><span className="text-muted-foreground">Held:</span> {detailData.recommendationDiagnostics.isHeld ? "Yes" : "No"}</p>
                        <p><span className="text-muted-foreground">Category exposure:</span> {detailData.recommendationDiagnostics.categoryExposurePct.toFixed(1)}%</p>
                        <p><span className="text-muted-foreground">Theme exposure:</span> {detailData.recommendationDiagnostics.themeExposurePct.toFixed(1)}%</p>
                        {detailData.recommendationDiagnostics.timeToResolutionDays != null && (
                          <p><span className="text-muted-foreground">Days to resolution:</span> {detailData.recommendationDiagnostics.timeToResolutionDays}</p>
                        )}
                        <p><span className="text-muted-foreground">Near resolution:</span> {detailData.recommendationDiagnostics.nearResolutionCount}</p>
                        <p><span className="text-muted-foreground">Stale / unresolved:</span> {detailData.recommendationDiagnostics.staleCount} / {detailData.recommendationDiagnostics.unresolvedCount}</p>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
                  Recommendation context not available. You can open the recommendation from the table link.
                </div>
              )}

              <div className="pt-2">
                <Link
                  href={`/recommendations/${selected.candidate.recommendationId}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Open full recommendation →
                </Link>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
