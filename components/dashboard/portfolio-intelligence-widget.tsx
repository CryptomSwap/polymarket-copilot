"use client";

import { useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2, RefreshCw, TrendingUp, Clock } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useLivePortfolioPolling } from "@/hooks/use-live-portfolio-polling";
import { PortfolioFreshnessIndicator } from "@/components/portfolio/portfolio-freshness-indicator";

interface ConcentrationBucket {
  key: string;
  exposure: number;
  pct: number;
}

interface IntelligenceFlag {
  code: string;
  severity: "low" | "medium" | "high";
  score: number;
  message: string;
  metadata?: Record<string, unknown>;
}

interface IntelligenceAction {
  type: string;
  label: string;
  priority: number;
  flagCode?: string;
  detail?: string;
}

interface PositionRef {
  id: string;
  assetId: string;
  marketTitle: string | null;
  exposure: number;
}

interface PortfolioIntelligenceResponse {
  ok: boolean;
  funderAddress?: string;
  sourceOfTruth?: string;
  asOf?: string;
  freshnessMs?: number | null;
  freshnessState?: "fresh" | "cached" | "unknown";
  orderSourceOfTruth?: string;
  ordersAsOf?: string;
  ordersFreshnessMs?: number | null;
  ordersFreshnessState?: "fresh" | "cached" | "unknown";
  intelligence?: {
    summary: {
      totalPositions: number;
      resolvedPositions: number;
      unresolvedPositions: number;
      stalePositions: number;
      nearResolutionPositions: number;
      totalOpenExposure: number | null;
      totalUnrealizedPnl: number | null;
      topThemeConcentrationPct: number | null;
      topMarketConcentrationPct: number | null;
      yesExposure: number | null;
      noExposure: number | null;
    };
    buckets: {
      byMarket: ConcentrationBucket[];
      byCategory: ConcentrationBucket[];
      byTheme: ConcentrationBucket[];
      nearResolution: PositionRef[];
      stale: PositionRef[];
      unresolved: PositionRef[];
    };
    flags: IntelligenceFlag[];
    actions: IntelligenceAction[];
    diagnostics: Record<string, number>;
  };
  error?: string;
  detail?: string;
}

function formatUsd(val: number): string {
  if (!Number.isFinite(val)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

function formatPct(val: number): string {
  if (!Number.isFinite(val)) return "—";
  return `${val.toFixed(1)}%`;
}

export function PortfolioIntelligenceWidget() {
  const [error, setError] = useState<string | null>(null);

  const fetchIntelligenceFn = useCallback(async (): Promise<PortfolioIntelligenceResponse> => {
    const res = await fetch("/api/portfolio/intelligence");
    const json: PortfolioIntelligenceResponse = await res.json();
    if (!res.ok) {
      setError(json.error ?? "Failed to load portfolio intelligence.");
      return json;
    }
    if (!json.ok || !json.intelligence) {
      setError(json.error ?? "No intelligence data returned.");
      return json;
    }
    setError(null);
    return json;
  }, []);

  const {
    data,
    loading,
    error: hookError,
    refresh: fetchIntelligence,
    isRefreshing,
  } = useLivePortfolioPolling<PortfolioIntelligenceResponse>(fetchIntelligenceFn, {
    intervalMs: 10_000,
    refetchOnFocus: true,
    preventOverlap: true,
  });

  const displayError = hookError ?? error;

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Portfolio Intelligence</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <span>Analyzing positions and concentration.</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (displayError && !data?.intelligence) {
    const isNoFunder = data?.error?.toLowerCase().includes("funder") ?? false;
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
            Portfolio Intelligence
          </CardTitle>
          <CardDescription>
            {isNoFunder
              ? "Connect your wallet and save the connection to view portfolio intelligence."
              : "Unable to load intelligence for your portfolio."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">{displayError}</p>
          {!isNoFunder && (
            <Button variant="outline" size="sm" onClick={fetchIntelligence}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const intel = data?.intelligence;
  if (!intel) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Portfolio Intelligence</CardTitle>
          <CardDescription>No data available.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Run portfolio sync and recompute to generate intelligence.
          </p>
          <Link href="/portfolio" className="text-sm text-primary hover:underline mt-2 inline-block">
            Go to Portfolio →
          </Link>
        </CardContent>
      </Card>
    );
  }

  const { summary, buckets, flags, actions } = intel;
  const nearResolution = buckets?.nearResolution ?? [];
  const hasPositions = (summary?.totalPositions ?? 0) > 0;
  const topFlags = (flags ?? []).slice(0, 5);
  const topActions = (actions ?? []).slice(0, 4);
  const topThemes = (buckets?.byTheme ?? []).slice(0, 5);
  const topCategories = (buckets?.byCategory ?? []).slice(0, 4);

  return (
    <div className="space-y-3">
      {/* Needs Attention: flags + actions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
            Needs attention
          </CardTitle>
          <CardDescription>
            {hasPositions
              ? "Flags and suggested actions from your portfolio."
              : "No open positions to analyze."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          {!hasPositions ? (
            <p className="text-sm text-muted-foreground">
              Connect and sync positions to see attention flags and actions.
            </p>
          ) : topFlags.length === 0 && topActions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No attention items. Concentration and timeline are within normal ranges.
            </p>
          ) : (
            <>
              {topFlags.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                    Flags
                  </h4>
                  <ul className="space-y-2">
                    {topFlags.map((f, i) => (
                      <li
                        key={`${f.code}-${i}`}
                        className="flex items-start gap-2 text-sm"
                      >
                        <span
                          className={cn(
                            "shrink-0 rounded px-1.5 py-0.5 text-xs font-medium",
                            f.severity === "high" &&
                              "bg-red-500/15 text-red-700 dark:text-red-400",
                            f.severity === "medium" &&
                              "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                            f.severity === "low" &&
                              "bg-muted text-muted-foreground"
                          )}
                        >
                          {f.severity}
                        </span>
                        <span className="text-foreground">{f.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {topActions.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                    Suggested actions
                  </h4>
                  <ol className="list-decimal list-inside space-y-1.5 text-sm text-muted-foreground">
                    {topActions.map((a) => (
                      <li key={a.priority}>
                        <span className="text-foreground">{a.label}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Exposure overview: concentration + near-resolution */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <TrendingUp className="h-4 w-4 shrink-0 text-muted-foreground" />
            Exposure overview
          </CardTitle>
          <CardDescription>
            Concentration by theme and category, and positions nearing resolution.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          {!hasPositions ? (
            <p className="text-sm text-muted-foreground">
              No open exposure to display.
            </p>
          ) : (
            <>
              {/* Concise summary lines */}
              <div className="space-y-1 text-sm text-muted-foreground border-b border-border/50 pb-3">
                {summary.topThemeConcentrationPct != null && (
                  <p>Top theme concentration is {formatPct(summary.topThemeConcentrationPct)}.</p>
                )}
                {summary.topMarketConcentrationPct != null && (
                  <p>Top market concentration is {formatPct(summary.topMarketConcentrationPct)}.</p>
                )}
                {(summary.nearResolutionPositions ?? 0) > 0 && (
                  <p>{summary.nearResolutionPositions} position{summary.nearResolutionPositions !== 1 ? "s" : ""} resolve within 72 hours.</p>
                )}
                {(summary.stalePositions ?? 0) > 0 && (
                  <p>{summary.stalePositions} position{summary.stalePositions !== 1 ? "s" : ""} have stale sync data.</p>
                )}
              </div>
              {/* Metrics grid */}
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Current value
                  </p>
                  <p className="font-semibold tabular-nums">
                    {formatUsd(summary.totalOpenExposure ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Unrealized P&L
                  </p>
                  <p
                    className={cn(
                      "font-semibold tabular-nums",
                      (summary.totalUnrealizedPnl ?? 0) >= 0
                        ? "text-green-600 dark:text-green-500"
                        : "text-red-600 dark:text-red-500"
                    )}
                  >
                    {formatUsd(summary.totalUnrealizedPnl ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Top theme concentration
                  </p>
                  <p className="font-semibold tabular-nums">
                    {formatPct(summary.topThemeConcentrationPct ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Top market concentration
                  </p>
                  <p className="font-semibold tabular-nums">
                    {formatPct(summary.topMarketConcentrationPct ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Positions
                  </p>
                  <p className="font-semibold tabular-nums">{summary.totalPositions}</p>
                </div>
              </div>

              {/* Concentration by theme */}
              {topThemes.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                    By theme
                  </h4>
                  <ul className="space-y-1.5">
                    {topThemes.map((t) => (
                      <li
                        key={t.key}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="text-foreground">{t.key}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatPct(t.pct)} · {formatUsd(t.exposure)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {topThemes[0].key} represents {formatPct(topThemes[0].pct)} of total exposure.
                  </p>
                </div>
              )}

              {/* Concentration by category */}
              {topCategories.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                    By category
                  </h4>
                  <ul className="space-y-1.5">
                    {topCategories.map((c) => (
                      <li
                        key={c.key}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="text-foreground capitalize">{c.key}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatPct(c.pct)} · {formatUsd(c.exposure)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Near resolution summary */}
              <div>
                <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  Near resolution
                </h4>
                {nearResolution.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No positions resolving within 72 hours.
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-foreground mb-2">
                      {nearResolution.length} position{nearResolution.length !== 1 ? "s" : ""} resolve within 72 hours.
                    </p>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {nearResolution.slice(0, 5).map((p, i) => (
                        <li key={p.id ?? i} className="flex justify-between gap-2">
                          <span className="truncate">
                            {p.marketTitle ?? "Unknown market"}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {formatUsd(p.exposure)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={fetchIntelligence}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
        {(data?.asOf != null || data?.ordersAsOf != null) && (
          <PortfolioFreshnessIndicator
            sourceOfTruth={data.sourceOfTruth}
            asOf={data.asOf}
            freshnessMs={data.freshnessMs}
            freshnessState={data.freshnessState}
            orderSourceOfTruth={data.orderSourceOfTruth}
            ordersAsOf={data.ordersAsOf}
            ordersFreshnessMs={data.ordersFreshnessMs}
            ordersFreshnessState={data.ordersFreshnessState}
            compact
          />
        )}
        {isRefreshing && (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Updating…
          </span>
        )}
        <Link
          href="/portfolio"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Full portfolio →
        </Link>
      </div>
    </div>
  );
}
