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
import { cn } from "@/lib/utils";
import { Loader2, BarChart3 } from "lucide-react";

interface Snapshot {
  totalOpenExposure: string;
  totalReservedExposure: string;
  realizedPnl: string;
  unrealizedPnl: string;
  openPositionsCount: number;
  openOrdersCount: number;
  topConcentrationPct: string;
  yesExposure: string;
  noExposure: string;
  createdAt: string;
}

interface PositionSummary {
  id: string;
  marketTitle: string;
  outcome: string;
  marketValue: string;
  category: string | null;
  theme: string | null;
}

interface Flag {
  id: string;
  type: string;
  severity: string;
  marketTitle: string | null;
  description: string;
  createdAt: string;
}

interface Fill {
  id: string;
  tradeId: string;
  market: string;
  assetId: string;
  side: string;
  size: string;
  price: string;
  matchTime: string | null;
  outcome: string | null;
  syncedAt: string;
}

interface Order {
  id: string;
  orderId: string;
  market: string;
  assetId: string;
  side: string;
  originalSize: string;
  sizeMatched: string;
  price: string;
  status: string;
  outcome: string | null;
  syncedAt: string;
}

interface AnalyticsData {
  funderAddress: string;
  snapshot: Snapshot | null;
  positions: PositionSummary[];
  flags: Flag[];
  recentFills: Fill[];
  recentOrders: Order[];
}

interface EvalSummary {
  totalEvaluations: number;
  winRateOverall: number;
  winRateByAction: Record<string, { winRate: number; count: number; avgEdge: number }>;
  avgEdgeBySignalType: Record<string, { avgEdge: number; count: number }>;
  countByReviewStatus?: Record<string, number>;
  avgEdgeByReviewStatus?: Record<string, number>;
  approvedVsRejected?: {
    approved: { evalCount: number; winRate: number };
    rejected: { evalCount: number; winRate: number };
  };
  evaluatedByReviewed?: {
    reviewed: { total: number; winRate: number };
    notReviewed: { total: number; winRate: number };
  };
}

interface NewsStats {
  sourcesCount: number;
  totalItems: number;
  totalLinks: number;
  sources: Array<{ id: string; name: string; type: string; credibilityScore: number; itemsCount: number }>;
  linkedByMarket24h: Array<{ marketId: string; title: string; slug: string | null; articleCount24h: number; saturation: number }>;
  recentItems: Array<{ id: string; title: string; publishedAt: string | null; sourceName: string }>;
}

interface ExecutionSummaryData {
  actedOnCount: number;
  ignoredCount: number;
  actedOnWinRate: number | null;
  ignoredWinRate: number | null;
  approvedActedOnWinRate: number | null;
  rejectedSkippedWinRate: number | null;
  averageSlippage: number | null;
  averageSizeOverride: number | null;
  overridePerformance: { overriddenWinRate: number | null; matchedWinRate: number | null };
  heuristicTopActedCount?: number;
  heuristicTopActedWinRate?: number | null;
  heuristicTopIgnoredCount?: number;
  heuristicTopIgnoredWinRate?: number | null;
  mlSupportedActedCount?: number;
  mlSupportedActedWinRate?: number | null;
  mlSupportedIgnoredCount?: number;
  mlSupportedIgnoredWinRate?: number | null;
  strongDisagreementCount?: number;
  strongDisagreementActedCount?: number;
  strongDisagreementActedWinRate?: number | null;
}

interface RecommendationFunnelData {
  shown: number;
  reviewed: number;
  approved: number;
  rejected: number;
  previewed: number;
  intentCreated: number;
  placed: number;
  filled: number;
  skipped: number;
}

interface DecisionSummaryData {
  policyDistribution: Record<string, number>;
  performanceByPolicy: Record<string, { count: number; winCount: number; avgReturn24h: number }>;
  setupProfiles: Array<{
    signalType: string | null;
    category: string | null;
    theme: string | null;
    reviewStatus: string | null;
    sampleCount: number;
    actedWinRate: number | null;
    ignoredWinRate: number | null;
    avgForwardReturn6h: number | null;
    avgForwardReturn24h: number | null;
    overrideWinRate: number | null;
  }>;
  snapshotCount: number;
  avgBlendedScore: number | null;
}

interface ReliabilityData {
  preflightPassRate: number | null;
  preflightTotal: number;
  preflightPassCount: number;
  reconciliationMismatchCount: number;
  reconciliationTotal: number;
  partialFillCount: number;
  avgEffectiveSlippage: number | null;
  recentPostTradeNotes: Array<{ id: string; recommendationId: string | null; executedOrderId: string | null; note: string; tag: string; createdAt: string }>;
}

interface ExitSummaryData {
  decisionDistribution: Record<string, number>;
  exitTimingSummary: Record<string, number>;
  takeProfitCount: number;
  thesisBrokenCount: number;
  totalExits: number;
  recentExitIntents: Array<{ id: string; assetId: string; marketId: string; exitType: string; size: string; limitPrice: string; status: string; createdAt: string }>;
  avgPostExitMove: number | null;
}

interface MlSummary {
  latestRun: {
    id: string;
    modelType: string;
    targetLabel: string;
    featureSetName: string;
    status: string;
    trainCount?: number;
    validationCount?: number;
    trainedFrom?: string | null;
    validatedTo?: string | null;
    leakageCheckPassed?: boolean | null;
    createdAt: string;
  } | null;
  activeModel: { id: string; status: string; targetLabel: string; featureSetName: string } | null;
  datasetSize: number;
  liveScoredCount: number;
  latestScoringTime: string | null;
  metrics: {
    accuracy: number;
    precision: number;
    recall: number;
    f1: number;
    rocAuc: number;
    threshold: number;
    tp: number;
    fp: number;
    tn: number;
    fn: number;
  } | null;
  comparison: {
    topN: Array<{ n: number; heuristicHitRate: number; mlHitRate: number; heuristicAvgReturn: number | null; mlAvgReturn: number | null }>;
    winRateByHeuristicBucket: Array<{ bucket: string; count: number; winRate: number }>;
    winRateByMlBucket: Array<{ bucket: string; count: number; winRate: number }>;
  } | null;
  calibration: { mae: number } | null;
  featureImportance: Array<{ name: string; coefficient: number; absCoefficient: number }> | null;
}

function EvaluateButton({ onDone }: { onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  const run = async () => {
    setLoading(true);
    try {
      await fetch("/api/recommendations/evaluate", { method: "POST" });
      onDone();
    } finally {
      setLoading(false);
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={run} disabled={loading}>
      {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <BarChart3 className="mr-1 h-3 w-3" />}
      Run Evaluate
    </Button>
  );
}

function formatUsd(val: string): string {
  const n = parseFloat(val);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function aggregateByField(
  positions: PositionSummary[],
  field: "category" | "theme"
): Array<{ key: string; value: number }> {
  const map = new Map<string, number>();
  for (const p of positions) {
    const k = p[field] ?? "Other";
    map.set(k, (map.get(k) ?? 0) + parseFloat(p.marketValue));
  }
  const total = positions.reduce((s, p) => s + parseFloat(p.marketValue), 0);
  if (total <= 0) return [];
  return Array.from(map.entries())
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value);
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);
  const [newsStats, setNewsStats] = useState<NewsStats | null>(null);
  const [mlSummary, setMlSummary] = useState<MlSummary | null>(null);
  const [executionSummary, setExecutionSummary] = useState<ExecutionSummaryData | null>(null);
  const [funnel, setFunnel] = useState<RecommendationFunnelData | null>(null);
  const [decisionSummary, setDecisionSummary] = useState<DecisionSummaryData | null>(null);
  const [reliabilityData, setReliabilityData] = useState<ReliabilityData | null>(null);
  const [exitSummary, setExitSummary] = useState<ExitSummaryData | null>(null);
  const [narratives, setNarratives] = useState<{
    windowHours: number;
    computed: Array<{ theme: string; eventType: string; articleCount24h: number; sentimentTrend: string | null; momentumScore: number }>;
    persisted: Array<{ id: string; theme: string; eventType: string; articleCount24h: number; sentimentTrend: string | null; momentumScore: number; updatedAt: string }>;
  } | null>(null);
  const [calibrationData, setCalibrationData] = useState<{
    links: Array<{
      id: string;
      marketSlug: string | null;
      marketTitle: string | null;
      eventType: string;
      entityPrimary: string | null;
      impactEstimate: number;
      instantImpact: number | null;
      persistentImpact: number | null;
      impactObserved5m: number | null;
      impactObserved30m: number | null;
      impactObserved2h: number | null;
      impactObserved24h: number | null;
      calibrationError5m: number | null;
      calibrationError30m: number | null;
      calibrationError2h: number | null;
      calibrationError24h: number | null;
      calibrationConfidence?: number | null;
      createdAt: string;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [newsSyncing, setNewsSyncing] = useState(false);
  const [mlBuilding, setMlBuilding] = useState(false);
  const [mlTraining, setMlTraining] = useState(false);
  const [rebuildingOutcomes, setRebuildingOutcomes] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [dataRes, evalRes, newsRes, mlRes, execSummaryRes, funnelRes, decisionSummaryRes, reliabilityRes, exitSummaryRes, narrativesRes, calibrationRes] = await Promise.all([
        fetch("/api/analytics/data?limit=15"),
        fetch("/api/recommendations/evaluation-summary"),
        fetch("/api/news/stats"),
        fetch("/api/ml/evaluation-summary"),
        fetch("/api/analytics/execution-summary"),
        fetch("/api/analytics/recommendation-funnel"),
        fetch("/api/decision/summary"),
        fetch("/api/analytics/reliability"),
        fetch("/api/positions/exit-summary"),
        fetch("/api/news/narratives?windowHours=24"),
        fetch("/api/news/calibration?limit=30&sinceHours=72"),
      ]);
      if (dataRes.ok) {
        const json = await dataRes.json();
        setData(json);
      } else setData(null);
      if (evalRes.ok) {
        const json = await evalRes.json();
        setEvalSummary(json);
      } else setEvalSummary(null);
      if (newsRes.ok) {
        const json = await newsRes.json();
        setNewsStats({
          sourcesCount: json.sourcesCount ?? 0,
          totalItems: json.totalItems ?? 0,
          totalLinks: json.totalLinks ?? 0,
          sources: json.sources ?? [],
          linkedByMarket24h: json.linkedByMarket24h ?? [],
          recentItems: json.recentItems ?? [],
        });
      } else setNewsStats(null);
      if (mlRes.ok) {
        const json = await mlRes.json();
        setMlSummary({
          latestRun: json.latestRun ?? null,
          activeModel: json.activeModel ?? null,
          datasetSize: json.datasetSize ?? 0,
          liveScoredCount: json.liveScoredCount ?? 0,
          latestScoringTime: json.latestScoringTime ?? null,
          metrics: json.metrics ?? null,
          comparison: json.comparison ?? null,
          calibration: json.calibration ?? null,
          featureImportance: json.featureImportance ?? null,
        });
      } else setMlSummary(null);
      if (execSummaryRes.ok) {
        const json = await execSummaryRes.json();
        setExecutionSummary(json);
      } else setExecutionSummary(null);
      if (funnelRes.ok) {
        const json = await funnelRes.json();
        setFunnel(json);
      } else setFunnel(null);
      if (decisionSummaryRes.ok) {
        const json = await decisionSummaryRes.json();
        setDecisionSummary(json);
      } else setDecisionSummary(null);
      if (reliabilityRes.ok) {
        const json = await reliabilityRes.json();
        setReliabilityData(json);
      } else setReliabilityData(null);
      if (exitSummaryRes.ok) {
        const json = await exitSummaryRes.json();
        setExitSummary(json);
      } else setExitSummary(null);
      if (narrativesRes.ok) {
        const json = await narrativesRes.json();
        setNarratives({ windowHours: json.windowHours ?? 24, computed: json.computed ?? [], persisted: json.persisted ?? [] });
      } else setNarratives(null);
      if (calibrationRes.ok) {
        const json = await calibrationRes.json();
        setCalibrationData({ links: json.links ?? [] });
      } else setCalibrationData(null);
    } catch {
      setData(null);
      setEvalSummary(null);
      setNewsStats(null);
      setMlSummary(null);
      setExecutionSummary(null);
      setFunnel(null);
      setDecisionSummary(null);
      setReliabilityData(null);
      setExitSummary(null);
      setNarratives(null);
      setCalibrationData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">Analytics</h2>
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">Analytics</h2>
        <p className="text-muted-foreground">No data. Connect wallet and run sync + recompute.</p>
      </div>
    );
  }

  const { snapshot, positions, flags, recentFills, recentOrders } = data;
  const evalData = evalSummary;
  const byCategory = aggregateByField(positions, "category");
  const byTheme = aggregateByField(positions, "theme");
  const totalExposure = positions.reduce((s, p) => s + parseFloat(p.marketValue), 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Analytics
        </h2>
        <p className="text-muted-foreground">
          Exposure breakdown, P&L, top positions, recent activity, and behavior flags. Read-only.
        </p>
      </div>

      {/* Realized vs Unrealized */}
      {snapshot && (
        <Card>
          <CardHeader>
            <CardTitle>Realized vs Unrealized P&L</CardTitle>
            <CardDescription>Closed vs open position P&L</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-4 flex-wrap">
              <div>
                <p className="text-xs text-muted-foreground">Realized</p>
                <p className={cn(
                  "text-lg font-semibold tabular-nums",
                  parseFloat(snapshot.realizedPnl) >= 0 ? "text-green-600 dark:text-green-500" : "text-red-600 dark:text-red-500"
                )}>
                  {formatUsd(snapshot.realizedPnl)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Unrealized</p>
                <p className={cn(
                  "text-lg font-semibold tabular-nums",
                  parseFloat(snapshot.unrealizedPnl) >= 0 ? "text-green-600 dark:text-green-500" : "text-red-600 dark:text-red-500"
                )}>
                  {formatUsd(snapshot.unrealizedPnl)}
                </p>
              </div>
            </div>
            <div className="h-3 w-full max-w-xs rounded-full bg-muted overflow-hidden flex">
              <div
                className="h-full bg-green-500/80"
                title="Unrealized"
                style={{
                  width: `${(() => {
                    const r = Math.abs(parseFloat(snapshot.realizedPnl));
                    const u = Math.abs(parseFloat(snapshot.unrealizedPnl));
                    const total = r + u || 1;
                    return (u / total) * 100;
                  })()}%`,
                }}
              />
              <div
                className="h-full bg-blue-500/80"
                title="Realized"
                style={{
                  width: `${(() => {
                    const r = Math.abs(parseFloat(snapshot.realizedPnl));
                    const u = Math.abs(parseFloat(snapshot.unrealizedPnl));
                    const total = r + u || 1;
                    return (r / total) * 100;
                  })()}%`,
                }}
              />
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {/* Exposure by category */}
        <Card>
          <CardHeader>
            <CardTitle>Exposure by category</CardTitle>
            <CardDescription>Market value by category</CardDescription>
          </CardHeader>
          <CardContent>
            {byCategory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No positions</p>
            ) : (
              <div className="space-y-3">
                {byCategory.map(({ key, value }) => (
                  <div key={key} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span>{key}</span>
                      <span className="tabular-nums">{formatUsd(String(value))}</span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary/80 rounded-full"
                        style={{
                          width: `${totalExposure > 0 ? (value / totalExposure) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Exposure by theme */}
        <Card>
          <CardHeader>
            <CardTitle>Exposure by theme</CardTitle>
            <CardDescription>Market value by theme</CardDescription>
          </CardHeader>
          <CardContent>
            {byTheme.length === 0 ? (
              <p className="text-sm text-muted-foreground">No positions</p>
            ) : (
              <div className="space-y-3">
                {byTheme.slice(0, 10).map(({ key, value }) => (
                  <div key={key} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="truncate">{key}</span>
                      <span className="tabular-nums shrink-0 ml-2">{formatUsd(String(value))}</span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary/80 rounded-full"
                        style={{
                          width: `${totalExposure > 0 ? (value / totalExposure) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top positions by exposure */}
      <Card>
        <CardHeader>
          <CardTitle>Top positions by exposure</CardTitle>
          <CardDescription>Largest positions by market value</CardDescription>
        </CardHeader>
        <CardContent>
          {positions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No positions</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-2 font-medium">Market</th>
                    <th className="text-left py-2 px-2 font-medium">Outcome</th>
                    <th className="text-right py-2 px-2 font-medium">Market value</th>
                    <th className="text-left py-2 px-2 font-medium">Category</th>
                    <th className="text-left py-2 px-2 font-medium">Theme</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.slice(0, 10).map((p) => (
                    <tr key={p.id} className="border-b border-border/50">
                      <td className="py-2 px-2 max-w-[220px] truncate" title={p.marketTitle}>
                        {p.marketTitle}
                      </td>
                      <td className="py-2 px-2">{p.outcome}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{formatUsd(p.marketValue)}</td>
                      <td className="py-2 px-2">{p.category ?? "—"}</td>
                      <td className="py-2 px-2">{p.theme ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Recent fills */}
        <Card>
          <CardHeader>
            <CardTitle>Recent fills</CardTitle>
            <CardDescription>Latest synced trades</CardDescription>
          </CardHeader>
          <CardContent>
            {recentFills.length === 0 ? (
              <p className="text-sm text-muted-foreground">No fills</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 px-2 font-medium">Side</th>
                      <th className="text-right py-2 px-2 font-medium">Size</th>
                      <th className="text-right py-2 px-2 font-medium">Price</th>
                      <th className="text-left py-2 px-2 font-medium">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentFills.map((f) => (
                      <tr key={f.id} className="border-b border-border/50">
                        <td className="py-2 px-2">{f.side}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{f.size}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{f.price}</td>
                        <td className="py-2 px-2">{f.outcome ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent open orders */}
        <Card>
          <CardHeader>
            <CardTitle>Recent open orders</CardTitle>
            <CardDescription>Latest synced open orders</CardDescription>
          </CardHeader>
          <CardContent>
            {recentOrders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open orders</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 px-2 font-medium">Side</th>
                      <th className="text-right py-2 px-2 font-medium">Size</th>
                      <th className="text-right py-2 px-2 font-medium">Price</th>
                      <th className="text-left py-2 px-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentOrders.map((o) => (
                      <tr key={o.id} className="border-b border-border/50">
                        <td className="py-2 px-2">{o.side}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{o.originalSize}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{o.price}</td>
                        <td className="py-2 px-2">{o.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recommendation Funnel */}
      {funnel && (
        <Card>
          <CardHeader>
            <CardTitle>Recommendation funnel</CardTitle>
            <CardDescription>Lifecycle events: shown → reviewed → approved/rejected → previewed → intent → placed → filled / skipped</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 text-sm">
              <div className="rounded border border-border p-2">
                <p className="text-muted-foreground text-xs">Shown</p>
                <p className="font-semibold tabular-nums">{funnel.shown}</p>
              </div>
              <div className="rounded border border-border p-2">
                <p className="text-muted-foreground text-xs">Reviewed</p>
                <p className="font-semibold tabular-nums">{funnel.reviewed}</p>
              </div>
              <div className="rounded border border-border p-2">
                <p className="text-muted-foreground text-xs">Approved</p>
                <p className="font-semibold tabular-nums text-green-600 dark:text-green-500">{funnel.approved}</p>
              </div>
              <div className="rounded border border-border p-2">
                <p className="text-muted-foreground text-xs">Rejected</p>
                <p className="font-semibold tabular-nums text-red-600 dark:text-red-500">{funnel.rejected}</p>
              </div>
              <div className="rounded border border-border p-2">
                <p className="text-muted-foreground text-xs">Previewed</p>
                <p className="font-semibold tabular-nums">{funnel.previewed}</p>
              </div>
              <div className="rounded border border-border p-2">
                <p className="text-muted-foreground text-xs">Intent created</p>
                <p className="font-semibold tabular-nums">{funnel.intentCreated}</p>
              </div>
              <div className="rounded border border-border p-2">
                <p className="text-muted-foreground text-xs">Placed</p>
                <p className="font-semibold tabular-nums">{funnel.placed}</p>
              </div>
              <div className="rounded border border-border p-2">
                <p className="text-muted-foreground text-xs">Filled</p>
                <p className="font-semibold tabular-nums">{funnel.filled}</p>
              </div>
              <div className="rounded border border-border p-2">
                <p className="text-muted-foreground text-xs">Skipped</p>
                <p className="font-semibold tabular-nums">{funnel.skipped}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Execution Outcomes */}
      {executionSummary && (
        <Card>
          <CardHeader>
            <CardTitle>Execution outcomes</CardTitle>
            <CardDescription>Acted-on vs ignored recommendations, win rates, slippage, override performance. Rebuild outcomes after placing orders.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-4">
              <Button
                variant="outline"
                size="sm"
                disabled={rebuildingOutcomes}
                onClick={async () => {
                  setRebuildingOutcomes(true);
                  try {
                    await fetch("/api/analytics/rebuild-execution-outcomes", { method: "POST" });
                    await fetchData();
                  } finally {
                    setRebuildingOutcomes(false);
                  }
                }}
              >
                {rebuildingOutcomes ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                Rebuild execution outcomes
              </Button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground text-xs">Acted on</p>
                <p className="font-semibold tabular-nums">{executionSummary.actedOnCount}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Ignored</p>
                <p className="font-semibold tabular-nums">{executionSummary.ignoredCount}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Acted-on win rate (24h)</p>
                <p className="font-semibold tabular-nums">
                  {executionSummary.actedOnWinRate != null ? `${(executionSummary.actedOnWinRate * 100).toFixed(1)}%` : "—"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Ignored win rate (24h)</p>
                <p className="font-semibold tabular-nums">
                  {executionSummary.ignoredWinRate != null ? `${(executionSummary.ignoredWinRate * 100).toFixed(1)}%` : "—"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Approved acted-on win rate</p>
                <p className="font-semibold tabular-nums">
                  {executionSummary.approvedActedOnWinRate != null ? `${(executionSummary.approvedActedOnWinRate * 100).toFixed(1)}%` : "—"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Rejected skipped win rate</p>
                <p className="font-semibold tabular-nums">
                  {executionSummary.rejectedSkippedWinRate != null ? `${(executionSummary.rejectedSkippedWinRate * 100).toFixed(1)}%` : "—"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Avg slippage</p>
                <p className="font-semibold tabular-nums">
                  {executionSummary.averageSlippage != null ? `${(executionSummary.averageSlippage * 100).toFixed(2)}%` : "—"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Avg size override</p>
                <p className="font-semibold tabular-nums">
                  {executionSummary.averageSizeOverride != null ? `${(executionSummary.averageSizeOverride * 100).toFixed(1)}%` : "—"}
                </p>
              </div>
            </div>
            <div className="border-t border-border pt-3">
              <p className="text-xs text-muted-foreground mb-2">Override performance (24h win rate)</p>
              <div className="flex gap-4">
                <span>Overridden: {executionSummary.overridePerformance.overriddenWinRate != null ? `${(executionSummary.overridePerformance.overriddenWinRate * 100).toFixed(1)}%` : "—"}</span>
                <span>Matched: {executionSummary.overridePerformance.matchedWinRate != null ? `${(executionSummary.overridePerformance.matchedWinRate * 100).toFixed(1)}%` : "—"}</span>
              </div>
            </div>
            {(executionSummary.heuristicTopActedCount != null || executionSummary.mlSupportedActedCount != null || executionSummary.strongDisagreementCount != null) && (
              <div className="border-t border-border pt-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Execution-aware (heuristic vs ML)</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                  {executionSummary.heuristicTopActedCount != null && (
                    <div className="rounded border border-border p-2">
                      <p className="text-muted-foreground text-xs">Heuristic top (priority &gt; 0.5)</p>
                      <p>Acted: {executionSummary.heuristicTopActedCount} · Win rate: {executionSummary.heuristicTopActedWinRate != null ? `${(executionSummary.heuristicTopActedWinRate * 100).toFixed(1)}%` : "—"}</p>
                      <p>Ignored: {executionSummary.heuristicTopIgnoredCount ?? 0} · Win rate: {executionSummary.heuristicTopIgnoredWinRate != null ? `${(executionSummary.heuristicTopIgnoredWinRate * 100).toFixed(1)}%` : "—"}</p>
                    </div>
                  )}
                  {executionSummary.mlSupportedActedCount != null && (
                    <div className="rounded border border-border p-2">
                      <p className="text-muted-foreground text-xs">ML-supported (has ML score)</p>
                      <p>Acted: {executionSummary.mlSupportedActedCount} · Win rate: {executionSummary.mlSupportedActedWinRate != null ? `${(executionSummary.mlSupportedActedWinRate * 100).toFixed(1)}%` : "—"}</p>
                      <p>Ignored: {executionSummary.mlSupportedIgnoredCount ?? 0} · Win rate: {executionSummary.mlSupportedIgnoredWinRate != null ? `${(executionSummary.mlSupportedIgnoredWinRate * 100).toFixed(1)}%` : "—"}</p>
                    </div>
                  )}
                  {executionSummary.strongDisagreementCount != null && executionSummary.strongDisagreementCount > 0 && (
                    <div className="rounded border border-border p-2">
                      <p className="text-muted-foreground text-xs">Strong H/ML disagreement (|Δ| &gt; 0.25)</p>
                      <p>Count: {executionSummary.strongDisagreementCount} · Acted: {executionSummary.strongDisagreementActedCount ?? 0}</p>
                      <p>Acted win rate: {executionSummary.strongDisagreementActedWinRate != null ? `${(executionSummary.strongDisagreementActedWinRate * 100).toFixed(1)}%` : "—"}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Decision / policy summary */}
      {decisionSummary && (
        <Card>
          <CardHeader>
            <CardTitle>Decision engine</CardTitle>
            <CardDescription>Policy-state distribution, performance by policy state, setup performance profiles. Run Recompute decisions to refresh.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-4 text-sm">
              <span>Snapshots: {decisionSummary.snapshotCount}</span>
              {decisionSummary.avgBlendedScore != null && (
                <span>Avg blended score: {(decisionSummary.avgBlendedScore * 100).toFixed(1)}%</span>
              )}
            </div>
            {Object.keys(decisionSummary.policyDistribution).length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Policy-state distribution</p>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(decisionSummary.policyDistribution).map(([state, count]) => (
                    <span key={state} className="rounded border border-border px-2 py-1 text-sm">
                      {state}: {count}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {Object.keys(decisionSummary.performanceByPolicy).length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Performance by policy state (acted outcomes)</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-1 px-2">State</th>
                        <th className="text-right py-1 px-2">Count</th>
                        <th className="text-right py-1 px-2">Win rate</th>
                        <th className="text-right py-1 px-2">Avg return 24h</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(decisionSummary.performanceByPolicy).map(([state, p]) => (
                        <tr key={state} className="border-b border-border/50">
                          <td className="py-1 px-2">{state}</td>
                          <td className="py-1 px-2 text-right tabular-nums">{p.count}</td>
                          <td className="py-1 px-2 text-right tabular-nums">{p.count > 0 ? ((p.winCount / p.count) * 100).toFixed(1) : "—"}%</td>
                          <td className="py-1 px-2 text-right tabular-nums">{Number.isFinite(p.avgReturn24h) ? (p.avgReturn24h * 100).toFixed(2) : "—"}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {decisionSummary.setupProfiles.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Setup performance profiles (top by sample count)</p>
                <div className="overflow-x-auto max-h-48 overflow-y-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-1 px-2">Type / Category / Theme / Review</th>
                        <th className="text-right py-1 px-2">N</th>
                        <th className="text-right py-1 px-2">Acted WR</th>
                        <th className="text-right py-1 px-2">Ignored WR</th>
                        <th className="text-right py-1 px-2">Avg 24h</th>
                        <th className="text-right py-1 px-2">Override WR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {decisionSummary.setupProfiles.slice(0, 15).map((p, i) => (
                        <tr key={i} className="border-b border-border/50">
                          <td className="py-1 px-2 truncate max-w-[180px]" title={[p.signalType, p.category, p.theme, p.reviewStatus].filter(Boolean).join(" · ") || "—"}>
                            {p.signalType ?? p.category ?? p.theme ?? p.reviewStatus ?? "—"}
                          </td>
                          <td className="py-1 px-2 text-right tabular-nums">{p.sampleCount}</td>
                          <td className="py-1 px-2 text-right tabular-nums">{p.actedWinRate != null ? (p.actedWinRate * 100).toFixed(0) : "—"}%</td>
                          <td className="py-1 px-2 text-right tabular-nums">{p.ignoredWinRate != null ? (p.ignoredWinRate * 100).toFixed(0) : "—"}%</td>
                          <td className="py-1 px-2 text-right tabular-nums">{p.avgForwardReturn24h != null ? (p.avgForwardReturn24h * 100).toFixed(2) : "—"}%</td>
                          <td className="py-1 px-2 text-right tabular-nums">{p.overrideWinRate != null ? (p.overrideWinRate * 100).toFixed(0) : "—"}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Exit management: decision distribution, exit timing, take-profit vs thesis-broken */}
      {exitSummary && (
        <Card>
          <CardHeader>
            <CardTitle>Exit management</CardTitle>
            <CardDescription>Position exit decision distribution, exit timing, take-profit vs thesis-broken. Run Recompute decisions on Portfolio.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-4 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Decision distribution</p>
                <ul className="mt-1 space-y-0.5">
                  {Object.entries(exitSummary.decisionDistribution ?? {}).map(([state, count]) => (
                    <li key={state} className="flex justify-between gap-4"><span>{state}</span><span className="tabular-nums">{count}</span></li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Exit timing (by type)</p>
                <ul className="mt-1 space-y-0.5">
                  {Object.entries(exitSummary.exitTimingSummary ?? {}).map(([type, count]) => (
                    <li key={type} className="flex justify-between gap-4"><span>{type}</span><span className="tabular-nums">{count}</span></li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Take-profit</p>
                <p className="font-semibold tabular-nums">{exitSummary.takeProfitCount}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Thesis broken</p>
                <p className="font-semibold tabular-nums">{exitSummary.thesisBrokenCount}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total exits</p>
                <p className="font-semibold tabular-nums">{exitSummary.totalExits}</p>
              </div>
            </div>
            {exitSummary.recentExitIntents && exitSummary.recentExitIntents.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Recent exit intents</p>
                <div className="overflow-x-auto text-sm">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-1 px-2 font-medium">Type</th>
                        <th className="text-right py-1 px-2 font-medium">Size</th>
                        <th className="text-left py-1 px-2 font-medium">Status</th>
                        <th className="text-left py-1 px-2 font-medium">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {exitSummary.recentExitIntents.slice(0, 10).map((e) => (
                        <tr key={e.id} className="border-b border-border/50">
                          <td className="py-1 px-2">{e.exitType}</td>
                          <td className="py-1 px-2 text-right tabular-nums">{e.size}</td>
                          <td className="py-1 px-2">{e.status}</td>
                          <td className="py-1 px-2 text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {exitSummary.avgPostExitMove != null && (
              <p className="text-sm text-muted-foreground">Avg post-exit move: {(exitSummary.avgPostExitMove * 100).toFixed(2)}%</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Reliability: preflight, reconciliation, post-trade journal */}
      {reliabilityData && (
        <Card>
          <CardHeader>
            <CardTitle>Reliability</CardTitle>
            <CardDescription>Preflight pass rate, reconciliation mismatches, partial fills, avg effective slippage, recent post-trade notes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-4 text-sm">
              {reliabilityData.preflightPassRate != null && (
                <div>
                  <p className="text-xs text-muted-foreground">Preflight pass rate</p>
                  <p className="font-semibold tabular-nums">{(reliabilityData.preflightPassRate * 100).toFixed(0)}%</p>
                  <p className="text-xs text-muted-foreground">({reliabilityData.preflightPassCount} / {reliabilityData.preflightTotal})</p>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground">Reconciliation mismatches</p>
                <p className={cn("font-semibold tabular-nums", reliabilityData.reconciliationMismatchCount > 0 && "text-amber-600 dark:text-amber-400")}>
                  {reliabilityData.reconciliationMismatchCount}
                </p>
                <p className="text-xs text-muted-foreground">of {reliabilityData.reconciliationTotal} snapshots</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Partial fills</p>
                <p className="font-semibold tabular-nums">{reliabilityData.partialFillCount}</p>
              </div>
              {reliabilityData.avgEffectiveSlippage != null && (
                <div>
                  <p className="text-xs text-muted-foreground">Avg effective slippage</p>
                  <p className="font-semibold tabular-nums">{(reliabilityData.avgEffectiveSlippage * 100).toFixed(2)}%</p>
                </div>
              )}
            </div>
            {reliabilityData.recentPostTradeNotes.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Recent post-trade notes</p>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {reliabilityData.recentPostTradeNotes.slice(0, 10).map((n) => (
                    <li key={n.id} className="flex items-center gap-2">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{n.tag}</span>
                      <span className="truncate max-w-[280px]" title={n.note}>{n.note.slice(0, 60)}{n.note.length > 60 ? "…" : ""}</span>
                      <span className="text-xs shrink-0">{new Date(n.createdAt).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Recommendation performance */}
      <Card>
        <CardHeader>
          <CardTitle>Recommendation performance</CardTitle>
          <CardDescription>Win rate by action, avg edge by signal type. Run Evaluate to refresh. TODO: manual-trade review flow.</CardDescription>
        </CardHeader>
        {evalData ? (
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Total evaluations</p>
                <p className="text-lg font-semibold tabular-nums">{evalData.totalEvaluations}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Win rate (overall)</p>
                <p className="text-lg font-semibold tabular-nums">
                  {(evalData.winRateOverall * 100).toFixed(1)}%
                </p>
              </div>
            </div>
            {Object.keys(evalData.winRateByAction).length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Win rate by action</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-1 px-2 font-medium">Action</th>
                        <th className="text-right py-1 px-2 font-medium">Win rate</th>
                        <th className="text-right py-1 px-2 font-medium">Count</th>
                        <th className="text-right py-1 px-2 font-medium">Avg edge</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(evalData.winRateByAction).map(([action, v]) => (
                        <tr key={action} className="border-b border-border/50">
                          <td className="py-1 px-2">{action}</td>
                          <td className="py-1 px-2 text-right tabular-nums">{(v.winRate * 100).toFixed(1)}%</td>
                          <td className="py-1 px-2 text-right tabular-nums">{v.count}</td>
                          <td className="py-1 px-2 text-right tabular-nums">{(v.avgEdge * 100).toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {Object.keys(evalData.avgEdgeBySignalType).length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Avg edge by signal type</p>
                <ul className="space-y-1 text-sm">
                  {Object.entries(evalData.avgEdgeBySignalType).map(([st, v]) => (
                    <li key={st} className="flex justify-between">
                      <span>{st}</span>
                      <span className="tabular-nums">{(v.avgEdge * 100).toFixed(1)}% (n={v.count})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {evalData.countByReviewStatus && Object.keys(evalData.countByReviewStatus).length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Count by review status</p>
                <ul className="space-y-1 text-sm">
                  {Object.entries(evalData.countByReviewStatus).map(([status, count]) => (
                    <li key={status} className="flex justify-between">
                      <span>{status}</span>
                      <span className="tabular-nums">{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {evalData.avgEdgeByReviewStatus && Object.keys(evalData.avgEdgeByReviewStatus).length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Avg edge by review status</p>
                <ul className="space-y-1 text-sm">
                  {Object.entries(evalData.avgEdgeByReviewStatus).map(([status, avgEdge]) => (
                    <li key={status} className="flex justify-between">
                      <span>{status}</span>
                      <span className="tabular-nums">{(avgEdge * 100).toFixed(1)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {evalData.approvedVsRejected && (
              <div>
                <p className="text-sm font-medium mb-2">Approved vs rejected (forward performance)</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded border p-2">
                    <p className="text-xs text-muted-foreground">Approved</p>
                    <p className="tabular-nums">n={evalData.approvedVsRejected.approved.evalCount} · Win rate {(evalData.approvedVsRejected.approved.winRate * 100).toFixed(1)}%</p>
                  </div>
                  <div className="rounded border p-2">
                    <p className="text-xs text-muted-foreground">Rejected</p>
                    <p className="tabular-nums">n={evalData.approvedVsRejected.rejected.evalCount} · Win rate {(evalData.approvedVsRejected.rejected.winRate * 100).toFixed(1)}%</p>
                  </div>
                </div>
              </div>
            )}
            {evalData.evaluatedByReviewed && (
              <div>
                <p className="text-sm font-medium mb-2">Evaluation summary: reviewed vs not reviewed</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded border p-2">
                    <p className="text-xs text-muted-foreground">Reviewed (REVIEWED/APPROVED/REJECTED/ARCHIVED)</p>
                    <p className="tabular-nums">n={evalData.evaluatedByReviewed.reviewed.total} · Win rate {(evalData.evaluatedByReviewed.reviewed.winRate * 100).toFixed(1)}%</p>
                  </div>
                  <div className="rounded border p-2">
                    <p className="text-xs text-muted-foreground">Not reviewed (NEW)</p>
                    <p className="tabular-nums">n={evalData.evaluatedByReviewed.notReviewed.total} · Win rate {(evalData.evaluatedByReviewed.notReviewed.winRate * 100).toFixed(1)}%</p>
                  </div>
                </div>
              </div>
            )}
            {evalData && (
              <div className="pt-2 border-t">
                <EvaluateButton onDone={fetchData} />
              </div>
            )}
          </CardContent>
        ) : (
          <CardContent>
            <p className="text-sm text-muted-foreground mb-2">No evaluation data yet. Run Evaluate to compare recommendation prices over time.</p>
            <EvaluateButton onDone={fetchData} />
          </CardContent>
        )}
      </Card>

      {/* ML baseline */}
      <Card>
        <CardHeader>
          <CardTitle>ML baseline</CardTitle>
          <CardDescription>Training dataset from recommendations + evaluations. Logistic regression baseline; heuristic vs ML comparison. Advisory only; no autonomous trading.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={mlBuilding}
              onClick={async () => {
                setMlBuilding(true);
                try {
                  await fetch("/api/ml/build-dataset", { method: "POST" });
                  await fetchData();
                } finally {
                  setMlBuilding(false);
                }
              }}
            >
              {mlBuilding ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              Build dataset
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={mlTraining}
              onClick={async () => {
                setMlTraining(true);
                try {
                  await fetch("/api/ml/train-baseline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetLabel: "labelPositive24h" }) });
                  await fetchData();
                } finally {
                  setMlTraining(false);
                }
              }}
            >
              {mlTraining ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              Train baseline
            </Button>
          </div>
          {mlSummary && (
            <>
              <p className="text-sm">Dataset: <span className="font-mono">{mlSummary.datasetSize}</span> · Live-scored: <span className="font-mono">{mlSummary.liveScoredCount}</span> · Last scoring: {mlSummary.latestScoringTime ? new Date(mlSummary.latestScoringTime).toLocaleString() : "—"}</p>
              {mlSummary.activeModel && <p className="text-sm text-muted-foreground">Active model: {mlSummary.activeModel.targetLabel} · {mlSummary.activeModel.status}</p>}
              <p className="text-sm text-muted-foreground">Latest run: {mlSummary.latestRun ? `${mlSummary.latestRun.modelType} / ${mlSummary.latestRun.targetLabel} · ${mlSummary.latestRun.status} · Train ${mlSummary.latestRun.trainCount ?? "—"} / Val ${mlSummary.latestRun.validationCount ?? "—"} · Leakage ${mlSummary.latestRun.leakageCheckPassed === true ? "OK" : "—"}` : "—"}</p>
              {mlSummary.metrics && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                  <div className="rounded border p-2">
                    <p className="text-xs text-muted-foreground">Accuracy</p>
                    <p className="tabular-nums font-medium">{(mlSummary.metrics.accuracy * 100).toFixed(1)}%</p>
                  </div>
                  <div className="rounded border p-2">
                    <p className="text-xs text-muted-foreground">F1</p>
                    <p className="tabular-nums font-medium">{(mlSummary.metrics.f1 * 100).toFixed(1)}%</p>
                  </div>
                  <div className="rounded border p-2">
                    <p className="text-xs text-muted-foreground">ROC-AUC</p>
                    <p className="tabular-nums font-medium">{(mlSummary.metrics.rocAuc * 100).toFixed(1)}%</p>
                  </div>
                  <div className="rounded border p-2">
                    <p className="text-xs text-muted-foreground">Calibration MAE</p>
                    <p className="tabular-nums font-medium">{mlSummary.calibration ? mlSummary.calibration.mae.toFixed(3) : "—"}</p>
                  </div>
                </div>
              )}
              {mlSummary.comparison && mlSummary.comparison.topN.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">Heuristic vs ML (validation window only)</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-1 px-2 font-medium">Top N</th>
                          <th className="text-right py-1 px-2 font-medium">Heuristic hit %</th>
                          <th className="text-right py-1 px-2 font-medium">ML hit %</th>
                          <th className="text-right py-1 px-2 font-medium">H avg return</th>
                          <th className="text-right py-1 px-2 font-medium">ML avg return</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mlSummary.comparison.topN.map((t) => (
                          <tr key={t.n} className="border-b border-border/50">
                            <td className="py-1 px-2">{t.n}</td>
                            <td className="py-1 px-2 text-right tabular-nums">{(t.heuristicHitRate * 100).toFixed(0)}%</td>
                            <td className="py-1 px-2 text-right tabular-nums">{(t.mlHitRate * 100).toFixed(0)}%</td>
                            <td className="py-1 px-2 text-right tabular-nums">{t.heuristicAvgReturn != null ? (t.heuristicAvgReturn * 100).toFixed(1) + "%" : "—"}</td>
                            <td className="py-1 px-2 text-right tabular-nums">{t.mlAvgReturn != null ? (t.mlAvgReturn * 100).toFixed(1) + "%" : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {mlSummary.featureImportance && mlSummary.featureImportance.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">Feature importance (top coefficients)</p>
                  <ul className="text-sm space-y-1 max-h-32 overflow-y-auto">
                    {mlSummary.featureImportance.slice(0, 10).map((f) => (
                      <li key={f.name} className="flex justify-between gap-2">
                        <span className="truncate">{f.name}</span>
                        <span className="tabular-nums shrink-0">{f.coefficient.toFixed(3)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          {(!mlSummary || mlSummary.datasetSize === 0) && (
            <p className="text-sm text-muted-foreground">Build dataset from recommendations with evaluations, then train baseline. Run Evaluate first to get forward labels.</p>
          )}
        </CardContent>
      </Card>

      {/* News ingestion */}
      <Card>
        <CardHeader>
          <CardTitle>News ingestion</CardTitle>
          <CardDescription>RSS sources, linked to markets. Catalyst summaries and saturation.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={newsSyncing}
              onClick={async () => {
                setNewsSyncing(true);
                try {
                  await fetch("/api/news/sync", { method: "POST" });
                  await fetchData();
                } finally {
                  setNewsSyncing(false);
                }
              }}
            >
              {newsSyncing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              Sync news
            </Button>
          </div>
          {newsStats ? (
            <>
              <p className="text-sm">Sources: {newsStats.sourcesCount} · Items: {newsStats.totalItems} · Links: {newsStats.totalLinks}</p>
              {newsStats.linkedByMarket24h.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">Linked by market (24h)</p>
                  <ul className="text-sm space-y-1 max-h-40 overflow-y-auto">
                    {newsStats.linkedByMarket24h.slice(0, 15).map((m) => (
                      <li key={m.marketId} className="flex justify-between gap-2">
                        <span className="truncate">{m.title}</span>
                        <span className="tabular-nums shrink-0">{m.articleCount24h} · sat {(m.saturation * 100).toFixed(0)}%</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {newsStats.recentItems.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">Recent catalysts</p>
                  <ul className="text-sm space-y-1 max-h-32 overflow-y-auto">
                    {newsStats.recentItems.slice(0, 5).map((i) => (
                      <li key={i.id} className="truncate text-muted-foreground">{i.title} — {i.sourceName}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No news stats. Run Sync news.</p>
          )}
        </CardContent>
      </Card>

      {/* Narrative momentum dashboard */}
      <Card>
        <CardHeader>
          <CardTitle>Narrative momentum</CardTitle>
          <CardDescription>Article count per theme/event (24h), sentiment trend, momentum score. From event extraction pipeline.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {narratives ? (
            <>
              <p className="text-sm text-muted-foreground">Window: {narratives.windowHours}h · Persisted trends: {narratives.persisted.length}</p>
              {narratives.persisted.length > 0 ? (
                <div className="overflow-x-auto text-sm">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 px-2 font-medium">Theme</th>
                        <th className="text-left py-2 px-2 font-medium">Event type</th>
                        <th className="text-right py-2 px-2 font-medium">Articles 24h</th>
                        <th className="text-left py-2 px-2 font-medium">Sentiment</th>
                        <th className="text-right py-2 px-2 font-medium">Momentum</th>
                        <th className="text-left py-2 px-2 font-medium">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {narratives.persisted.slice(0, 20).map((p) => (
                        <tr key={p.id} className="border-b border-border/50">
                          <td className="py-2 px-2">{p.theme}</td>
                          <td className="py-2 px-2 font-mono text-xs">{p.eventType}</td>
                          <td className="py-2 px-2 text-right tabular-nums">{p.articleCount24h}</td>
                          <td className="py-2 px-2 text-muted-foreground">{p.sentimentTrend ?? "—"}</td>
                          <td className="py-2 px-2 text-right tabular-nums">{(p.momentumScore * 100).toFixed(0)}%</td>
                          <td className="py-2 px-2 text-muted-foreground text-xs">{new Date(p.updatedAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No narrative trends yet. Run Sync news to run event extraction and narrative tracking.</p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No narrative data.</p>
          )}
        </CardContent>
      </Card>

      {/* Catalyst calibration */}
      <Card>
        <CardHeader>
          <CardTitle>Catalyst calibration</CardTitle>
          <CardDescription>Predicted vs observed impact (instant vs 5m/30m, persistent vs 2h/24h). From MarketEventLink + MarketPriceSnapshot.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {calibrationData && calibrationData.links.length > 0 ? (
            <div className="overflow-x-auto text-sm">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-2 font-medium">Market</th>
                    <th className="text-left py-2 px-2 font-medium">Event</th>
                    <th className="text-right py-2 px-2 font-medium">Instant</th>
                    <th className="text-right py-2 px-2 font-medium">Obs 5m</th>
                    <th className="text-right py-2 px-2 font-medium">Obs 30m</th>
                    <th className="text-right py-2 px-2 font-medium">Persist</th>
                    <th className="text-right py-2 px-2 font-medium">Obs 2h</th>
                    <th className="text-right py-2 px-2 font-medium">Obs 24h</th>
                    <th className="text-right py-2 px-2 font-medium">Err 5m</th>
                    <th className="text-right py-2 px-2 font-medium">Err 24h</th>
                  </tr>
                </thead>
                <tbody>
                  {calibrationData.links.slice(0, 25).map((l) => {
                    const err24 = l.calibrationError24h != null ? Math.abs(l.calibrationError24h) : null;
                    const rowClass =
                      err24 != null
                        ? err24 < 0.05
                          ? "border-b border-border/50 bg-green-500/10"
                          : err24 < 0.15
                            ? "border-b border-border/50 bg-yellow-500/10"
                            : "border-b border-border/50 bg-red-500/10"
                        : "border-b border-border/50";
                    return (
                      <tr key={l.id} className={rowClass}>
                      <td className="py-2 px-2 truncate max-w-[120px]" title={l.marketTitle ?? undefined}>{l.marketSlug ?? l.marketTitle ?? "—"}</td>
                      <td className="py-2 px-2 font-mono text-xs">{l.eventType}{l.entityPrimary ? ` / ${l.entityPrimary}` : ""}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{(l.instantImpact != null ? (l.instantImpact * 100).toFixed(1) : "—")}%</td>
                      <td className="py-2 px-2 text-right tabular-nums">{(l.impactObserved5m != null ? (l.impactObserved5m * 100).toFixed(1) : "—")}%</td>
                      <td className="py-2 px-2 text-right tabular-nums">{(l.impactObserved30m != null ? (l.impactObserved30m * 100).toFixed(1) : "—")}%</td>
                      <td className="py-2 px-2 text-right tabular-nums">{(l.persistentImpact != null ? (l.persistentImpact * 100).toFixed(1) : "—")}%</td>
                      <td className="py-2 px-2 text-right tabular-nums">{(l.impactObserved2h != null ? (l.impactObserved2h * 100).toFixed(1) : "—")}%</td>
                      <td className="py-2 px-2 text-right tabular-nums">{(l.impactObserved24h != null ? (l.impactObserved24h * 100).toFixed(1) : "—")}%</td>
                      <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">{(l.calibrationError5m != null ? (l.calibrationError5m * 100).toFixed(1) : "—")}%</td>
                      <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">{(l.calibrationError24h != null ? (l.calibrationError24h * 100).toFixed(1) : "—")}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No calibrated links. Run news sync (event extraction + impact V2 + calibration) to populate.</p>
          )}
        </CardContent>
      </Card>

      {/* Behavior flags summary */}
      <Card>
        <CardHeader>
          <CardTitle>Behavior flags summary</CardTitle>
          <CardDescription>Risk and behavior signals (read-only).</CardDescription>
        </CardHeader>
        <CardContent>
          {flags.length === 0 ? (
            <p className="text-sm text-muted-foreground">No flags</p>
          ) : (
            <ul className="space-y-2">
              {flags.map((f) => (
                <li key={f.id} className="flex items-start gap-2 text-sm">
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-xs font-medium",
                      f.severity === "high"
                        ? "bg-red-500/20 text-red-700 dark:text-red-400"
                        : f.severity === "medium"
                        ? "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {f.severity}
                  </span>
                  <span className="text-muted-foreground font-medium">{f.type}</span>
                  <span className="truncate">{f.description}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
