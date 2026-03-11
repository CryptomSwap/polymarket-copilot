"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import Link from "next/link";
import { Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  MOMENTUM_CONTINUATION: "Momentum",
  MISPRICED_BREAKOUT: "Mispriced",
  CHEAP_LONGSHOT: "Longshot",
  OVERCROWDED_THEME: "Overcrowded",
  LATE_CHASE: "Late chase",
  WATCHLIST: "Watchlist",
  EXIT_CANDIDATE: "Exit",
  TRIM_CANDIDATE: "Trim",
};

interface Signal {
  id: string;
  marketTitle: string;
  outcome: string;
  side: string;
  marketPrice: string;
  fairPrice: string;
  edge: string;
  confidence: string;
  signalType: string;
  thesis: string | null;
  invalidation: string | null;
  category: string | null;
  theme: string | null;
}

const PRIMARY_ACTION_LABELS: Record<string, string> = {
  add: "Add",
  review_existing: "Review",
  trim: "Trim",
  hedge: "Hedge",
  avoid: "Avoid",
  monitor: "Monitor",
  sync_first: "Sync first",
};

interface RecommendationItem {
  id: string;
  action: string;
  primaryActionType: string | null;
  rationale: string | null;
  suggestedEntryMin: string | null;
  suggestedEntryMax: string | null;
  suggestedSize: string;
  blockedReason: string | null;
  priorityScore: string;
  signal: Signal;
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

export function RecommendationsWidget() {
  const [items, setItems] = useState<RecommendationItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTop = useCallback(async () => {
    try {
      const res = await fetch("/api/recommendations/top?limit=5");
      if (res.ok) {
        const data = await res.json();
        setItems(data.recommendations ?? []);
      } else setItems([]);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTop();
  }, [fetchTop]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Lightbulb className="h-4 w-4" />
            Top recommendations
          </CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading recommendations…</p>
        </CardContent>
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Lightbulb className="h-4 w-4" />
            Top recommendations
          </CardTitle>
          <CardDescription>Scored markets and suggested actions (read-only)</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No recommendations yet. Run &quot;Recompute recommendations&quot; from the Recommendations page.
          </p>
          <Link href="/recommendations" className="text-sm text-primary hover:underline mt-2 inline-block">
            Recommendations →
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Lightbulb className="h-4 w-4" />
          Top recommendations
        </CardTitle>
        <CardDescription>Portfolio-aware actions. Primary action, market, edge, size. Read-only.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-4">
          {items.map((r) => {
            const primaryLabel = r.primaryActionType ? (PRIMARY_ACTION_LABELS[r.primaryActionType] ?? r.primaryActionType) : r.action;
            return (
              <li key={r.id} className="border-b border-border/50 pb-3 last:border-0 last:pb-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span
                    className={cn(
                      "text-xs font-semibold uppercase tracking-wide shrink-0",
                      r.primaryActionType === "add" && "text-emerald-600 dark:text-emerald-400",
                      r.primaryActionType === "review_existing" && "text-blue-600 dark:text-blue-400",
                      (r.primaryActionType === "trim" || r.primaryActionType === "hedge") && "text-orange-600 dark:text-orange-400",
                      (r.primaryActionType === "avoid" || r.primaryActionType === "monitor") && "text-muted-foreground",
                      r.primaryActionType === "sync_first" && "text-amber-600 dark:text-amber-400",
                      !r.primaryActionType && "text-muted-foreground"
                    )}
                  >
                    {primaryLabel}
                  </span>
                  <Link href={`/recommendations/${r.id}`} className="font-medium text-sm truncate hover:underline min-w-0" title={r.signal.marketTitle}>
                    {r.signal.marketTitle}
                  </Link>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mt-1">
                  <span>{SIGNAL_TYPE_LABELS[r.signal.signalType] ?? r.signal.signalType}</span>
                  <span>{r.signal.outcome}/{r.signal.side}</span>
                  <span>Edge {formatPct(r.signal.edge)}</span>
                  {parseFloat(r.suggestedSize) > 0 && (
                    <span>Size {formatPct(r.suggestedSize)}</span>
                  )}
                </div>
                {(r.rationale ?? r.signal.thesis) && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2" title={r.rationale ?? r.signal.thesis ?? undefined}>
                    {r.rationale ?? r.signal.thesis}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <Link href="/recommendations" className="text-sm text-primary hover:underline mt-3 inline-block">
          View all →
        </Link>
      </CardContent>
    </Card>
  );
}
