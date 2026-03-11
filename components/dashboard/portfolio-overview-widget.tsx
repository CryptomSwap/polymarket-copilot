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
import { RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface PortfolioSnapshot {
  id: string;
  totalOpenExposure: string;
  totalCurrentValue?: string;
  totalCostBasis?: string;
  totalMaxPayout?: string;
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

export function PortfolioOverviewWidget() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [flags, setFlags] = useState<BehaviorFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [overviewRes, flagsRes] = await Promise.all([
        fetch("/api/portfolio/overview"),
        fetch("/api/portfolio/behavior-flags"),
      ]);
      if (overviewRes.ok) {
        const data = await overviewRes.json();
        setOverview(data);
      } else setOverview(null);
      if (flagsRes.ok) {
        const data = await flagsRes.json();
        setFlags(data.flags ?? []);
      } else setFlags([]);
    } catch {
      setOverview(null);
      setFlags([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const runRecompute = async () => {
    setRecomputing(true);
    try {
      const res = await fetch("/api/portfolio/recompute", { method: "POST" });
      const data = await res.json();
      if (data.success) await fetchData();
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
            <CardTitle className="text-base">Top concentration</CardTitle>
            <CardDescription>Largest theme % of portfolio</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {snapshot ? formatPct(snapshot.topConcentrationPct) : "—"}
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
            <CardDescription>Risk / behavior signals (read-only)</CardDescription>
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

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={runRecompute}
          disabled={recomputing}
        >
          {recomputing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
          Recompute portfolio
        </Button>
        {!snapshot && overview && (
          <p className="text-sm text-muted-foreground">
            Run &quot;Sync user data&quot; then &quot;Recompute portfolio&quot; to generate overview.
          </p>
        )}
      </div>
    </>
  );
}
