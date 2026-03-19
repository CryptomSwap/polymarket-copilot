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
import { RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useLivePortfolioPolling } from "@/hooks/use-live-portfolio-polling";
import { PortfolioFreshnessIndicator } from "@/components/portfolio/portfolio-freshness-indicator";

/** Live-computed totals. Use overview.asOf / freshnessMs for "last updated", not persisted row metadata. */
interface PortfolioSnapshot {
  totalOpenExposure: string;
  totalCurrentValue?: string;
  totalCostBasis?: string;
  totalMaxPayout?: string;
  totalReservedExposure: string;
  realizedPnl: string;
  unrealizedPnl: string;
  openPositionsCount: number;
  openOrdersCount: number;
  /** Largest theme % of portfolio. */
  topThemeConcentrationPct: string;
  /** Largest single market % of portfolio. */
  topMarketConcentrationPct?: string;
  yesExposure: string;
  noExposure: string;
  /** @deprecated Prefer overview.asOf for last-updated. Only set when API sends persistedSnapshotMeta. */
  id?: string;
  /** @deprecated Prefer overview.asOf for last-updated. Only set when API sends persistedSnapshotMeta. */
  createdAt?: string;
}

interface BehaviorFlag {
  id: string;
  type: string;
  severity: string;
  marketTitle: string | null;
  description: string;
  createdAt: string;
}

interface OverviewResponse {
  funderAddress: string;
  snapshot: PortfolioSnapshot | null;
  message?: string;
  sourceOfTruth?: string;
  asOf?: string;
  /** 0 = fresh, >0 = cached age ms, null = unknown */
  freshnessMs?: number | null;
  freshnessState?: "fresh" | "cached" | "unknown";
  orderSourceOfTruth?: string;
  ordersAsOf?: string;
  ordersFreshnessMs?: number | null;
  ordersFreshnessState?: "fresh" | "cached" | "unknown";
  /** Persisted DB snapshot row (audit only). Do not use for "last updated" — use asOf. */
  persistedSnapshotMeta?: { id: string; createdAt: string };
}

/** Behavior flags API response; asOf = when this response was built (separate from overview fetch). */
interface BehaviorFlagsResponse {
  flags: BehaviorFlag[];
  asOf?: string;
}

interface OverviewPollingData {
  overview: OverviewResponse;
  flags: BehaviorFlag[];
  /** When flags response was built; do not imply same cycle as overview. */
  flagsAsOf?: string;
}

function formatUsd(val: string): string {
  const n = parseFloat(val);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function formatPct(val: string): string {
  const n = parseFloat(val);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "—";
    const diffMs = Date.now() - d.getTime();
    const sec = Math.floor(diffMs / 1000);
    const min = Math.floor(sec / 60);
    if (sec < 10) return "just now";
    if (sec < 60) return `${sec}s ago`;
    if (min < 60) return `${min}m ago`;
    return `${Math.floor(min / 60)}h ago`;
  } catch {
    return "—";
  }
}

const FLAGS_OVERVIEW_SAME_CYCLE_THRESHOLD_MS = 5000;

function flagsMateriallyDifferentFromOverview(overviewAsOf: string | undefined, flagsAsOf: string | undefined): boolean {
  if (!overviewAsOf || !flagsAsOf) return false;
  try {
    const a = new Date(overviewAsOf).getTime();
    const b = new Date(flagsAsOf).getTime();
    return Math.abs(a - b) > FLAGS_OVERVIEW_SAME_CYCLE_THRESHOLD_MS;
  } catch {
    return true;
  }
}

export function PortfolioOverviewWidget() {
  const [recomputing, setRecomputing] = useState(false);

  const fetchData = useCallback(async (): Promise<OverviewPollingData> => {
    const [overviewRes, flagsRes] = await Promise.all([
      fetch("/api/portfolio/overview"),
      fetch("/api/portfolio/behavior-flags"),
    ]);
    const overview = overviewRes.ok ? await overviewRes.json() : { snapshot: null, funderAddress: "" };
    const flagsPayload: BehaviorFlagsResponse = flagsRes.ok ? await flagsRes.json() : { flags: [] };
    const flags = flagsPayload.flags ?? [];
    return { overview, flags, flagsAsOf: flagsPayload.asOf };
  }, []);

  const {
    data: pollingData,
    loading,
    refresh: fetchDataRefresh,
    isRefreshing,
  } = useLivePortfolioPolling<OverviewPollingData>(fetchData, {
    intervalMs: 10_000,
    refetchOnFocus: true,
    preventOverlap: true,
  });

  const overview = pollingData?.overview ?? null;
  const flags = pollingData?.flags ?? [];
  const flagsAsOf = pollingData?.flagsAsOf;

  const runRecompute = async () => {
    setRecomputing(true);
    try {
      const res = await fetch("/api/portfolio/recompute", { method: "POST" });
      const data = await res.json();
      if (data.success) await fetchDataRefresh();
    } finally {
      setRecomputing(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Portfolio overview</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading portfolio data…</p>
        </CardContent>
      </Card>
    );
  }

  const snapshot = overview?.snapshot ?? null;

  return (
    <>
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Current value</CardTitle>
            <CardDescription>Mark-to-market (shares × current price). Polymarket wallet &quot;Value&quot;</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {snapshot ? formatUsd(snapshot.totalCurrentValue ?? snapshot.totalOpenExposure) : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost basis</CardTitle>
            <CardDescription>Total cost (Polymarket &quot;Traded&quot;)</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {snapshot?.totalCostBasis != null ? formatUsd(snapshot.totalCostBasis) : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Max payout</CardTitle>
            <CardDescription>If all positions win (Polymarket &quot;To win&quot;)</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {snapshot?.totalMaxPayout != null ? formatUsd(snapshot.totalMaxPayout) : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reserved exposure</CardTitle>
            <CardDescription>Open orders notional</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {snapshot ? formatUsd(snapshot.totalReservedExposure) : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Realized P&L</CardTitle>
            <CardDescription>Closed / settled</CardDescription>
          </CardHeader>
          <CardContent>
            <p className={cn(
              "text-2xl font-semibold tabular-nums",
              snapshot && parseFloat(snapshot.realizedPnl) >= 0 ? "text-green-600 dark:text-green-500" : "text-red-600 dark:text-red-500"
            )}>
              {snapshot ? formatUsd(snapshot.realizedPnl) : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Unrealized P&L</CardTitle>
            <CardDescription>Open positions</CardDescription>
          </CardHeader>
          <CardContent>
            <p className={cn(
              "text-2xl font-semibold tabular-nums",
              snapshot && parseFloat(snapshot.unrealizedPnl) >= 0 ? "text-green-600 dark:text-green-500" : "text-red-600 dark:text-red-500"
            )}>
              {snapshot ? formatUsd(snapshot.unrealizedPnl) : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Open positions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {snapshot ? snapshot.openPositionsCount : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Open orders</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {snapshot ? snapshot.openOrdersCount : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top theme concentration</CardTitle>
            <CardDescription>Largest theme % of portfolio</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {snapshot ? formatPct(snapshot.topThemeConcentrationPct) : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Yes vs No exposure</CardTitle>
            <CardDescription>Yes / No market value</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm tabular-nums">
              Yes: {snapshot ? formatUsd(snapshot.yesExposure) : "—"} · No: {snapshot ? formatUsd(snapshot.noExposure) : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      {flags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Behavior flags
            </CardTitle>
            <CardDescription>
              Risk / behavior signals (read-only).
              {flagsAsOf && (
                <>
                  {" "}
                  Flags as of {formatRelative(flagsAsOf)}.
                  {flagsMateriallyDifferentFromOverview(overview?.asOf, flagsAsOf) && (
                    <span className="block mt-1 text-muted-foreground/90">
                      Separate refresh — may not match overview snapshot.
                    </span>
                  )}
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {flags.slice(0, 5).map((f) => (
                <li key={f.id} className="text-sm flex items-start gap-2">
                  <span className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-xs font-medium",
                    f.severity === "high" ? "bg-red-500/20 text-red-700 dark:text-red-400" :
                    f.severity === "medium" ? "bg-amber-500/20 text-amber-700 dark:text-amber-400" :
                    "bg-muted text-muted-foreground"
                  )}>
                    {f.severity}
                  </span>
                  <span className="text-muted-foreground">{f.type}</span>
                  <span className="truncate">{f.description}</span>
                </li>
              ))}
            </ul>
            <Link href="/analytics" className="text-sm text-primary hover:underline mt-2 inline-block">
              View all on Analytics →
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={runRecompute}
          disabled={recomputing}
        >
          {recomputing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
          Recompute portfolio
        </Button>
        {(overview?.asOf != null || overview?.ordersAsOf != null) && (
          <PortfolioFreshnessIndicator
            sourceOfTruth={overview.sourceOfTruth}
            asOf={overview.asOf}
            freshnessMs={overview.freshnessMs}
            freshnessState={overview.freshnessState}
            orderSourceOfTruth={overview.orderSourceOfTruth}
            ordersAsOf={overview.ordersAsOf}
            ordersFreshnessMs={overview.ordersFreshnessMs}
            ordersFreshnessState={overview.ordersFreshnessState}
            compact
          />
        )}
        {isRefreshing && (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Updating…
          </span>
        )}
        {!snapshot && overview && (
          <p className="text-sm text-muted-foreground">
            Run &quot;Sync user data&quot; then &quot;Recompute portfolio&quot; to generate overview.
          </p>
        )}
      </div>
    </>
  );
}
