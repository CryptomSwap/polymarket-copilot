"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, AlertTriangle, Package, ShoppingCart, PieChart, Bell } from "lucide-react";
import { cn } from "@/lib/utils";

interface SummaryStripPayload {
  openPositionsCount: number;
  openOrdersCount: number;
  topThemeConcentrationPct: number | null;
  topMarketConcentrationPct: number | null;
  unresolvedPositionsCount: number;
  activeAlertsCount: number;
  hasHighSeverityAlert: boolean;
  portfolioAsOf: string | null;
  portfolioFreshnessMs: number | null;
  portfolioFreshnessState: string | null;
  ordersAsOf: string | null;
  ordersFreshnessMs: number | null;
  ordersFreshnessState: string | null;
  portfolioSourceOfTruth: string | null;
  orderSourceOfTruth: string | null;
}

function formatPct(val: number | null): string {
  if (val == null || !Number.isFinite(val)) return "—";
  return `${val.toFixed(1)}%`;
}

function formatFreshness(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return `${h}h ago`;
}

export function SummaryStrip() {
  const [data, setData] = useState<SummaryStripPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStrip = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/dashboard/summary-strip");
      if (res.ok) {
        const json = await res.json();
        setData(json);
      } else {
        setData(null);
      }
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStrip();
  }, [fetchStrip]);

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        <span>Loading summary…</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        Summary unavailable. Connect wallet and ensure portfolio sync has run.
      </div>
    );
  }

  const hasMixedTime =
    (data.portfolioAsOf != null && data.ordersAsOf != null) &&
    data.portfolioAsOf !== data.ordersAsOf;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3 text-sm"
      aria-label="Portfolio summary"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="tabular-nums">{data.openPositionsCount}</span>
          <span className="text-muted-foreground font-normal">positions</span>
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ShoppingCart className="h-4 w-4 shrink-0" />
          <span className="tabular-nums">{data.openOrdersCount}</span>
          <span>orders</span>
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <PieChart className="h-4 w-4 shrink-0" />
          <span>Theme {formatPct(data.topThemeConcentrationPct)}</span>
          <span className="text-muted-foreground/70">·</span>
          <span>Market {formatPct(data.topMarketConcentrationPct)}</span>
        </span>
        {data.unresolvedPositionsCount > 0 && (
          <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="tabular-nums">{data.unresolvedPositionsCount}</span>
            <span>unresolved</span>
          </span>
        )}
        <Link
          href="#alerts"
          className={cn(
            "flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors",
            data.activeAlertsCount > 0
              ? "text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
              : "text-muted-foreground hover:bg-muted"
          )}
        >
          <Bell className="h-4 w-4 shrink-0" />
          <span className="tabular-nums">{data.activeAlertsCount}</span>
          <span>alerts</span>
          {data.hasHighSeverityAlert && (
            <span className="rounded bg-red-500/20 px-1 text-xs font-medium text-red-700 dark:text-red-400">
              Critical
            </span>
          )}
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={fetchStrip}
          disabled={loading}
          aria-label="Refresh summary"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span title={data.portfolioAsOf ?? undefined}>
          Portfolio {formatFreshness(data.portfolioFreshnessMs ?? null)}
          {data.portfolioSourceOfTruth && (
            <span className="ml-0.5 opacity-75">({data.portfolioSourceOfTruth})</span>
          )}
        </span>
        {data.ordersAsOf != null && (
          <span title={data.ordersAsOf}>
            Orders {formatFreshness(data.ordersFreshnessMs ?? null)}
            {data.orderSourceOfTruth && (
              <span className="ml-0.5 opacity-75">({data.orderSourceOfTruth})</span>
            )}
          </span>
        )}
        {hasMixedTime && (
          <span className="italic opacity-80">Different timestamps for positions vs orders</span>
        )}
        </div>
      </div>
    </div>
  );
}
