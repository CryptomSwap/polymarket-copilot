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
import { ArrowLeft, Loader2, RefreshCw, TrendingUp, TrendingDown, Minus, Lightbulb, Bell, Camera } from "lucide-react";
import { cn } from "@/lib/utils";

type TimelineEventType =
  | "position_opened"
  | "position_increased"
  | "position_reduced"
  | "recommendation_created"
  | "recommendation_lifecycle"
  | "alert_triggered"
  | "portfolio_snapshot";

interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  occurredAt: string;
  title: string;
  message: string;
  marketId?: string | null;
  assetId?: string | null;
  recommendationId?: string | null;
  alertId?: string | null;
  metadata?: Record<string, unknown>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const eventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((today.getTime() - eventDay.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (diffDays === 1) return `Yesterday ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  if (diffDays < 7) return `${diffDays}d ago · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function EventIcon({ type }: { type: TimelineEventType }) {
  const cls = "h-4 w-4 shrink-0";
  switch (type) {
    case "position_opened":
      return <Minus className={cn(cls, "text-primary")} />;
    case "position_increased":
      return <TrendingUp className={cn(cls, "text-green-600 dark:text-green-500")} />;
    case "position_reduced":
      return <TrendingDown className={cn(cls, "text-amber-600 dark:text-amber-500")} />;
    case "recommendation_created":
    case "recommendation_lifecycle":
      return <Lightbulb className={cn(cls, "text-muted-foreground")} />;
    case "alert_triggered":
      return <Bell className={cn(cls, "text-amber-600 dark:text-amber-500")} />;
    case "portfolio_snapshot":
      return <Camera className={cn(cls, "text-muted-foreground")} />;
    default:
      return <Minus className={cn(cls, "text-muted-foreground")} />;
  }
}

export default function PortfolioTimelinePage() {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTimeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/portfolio/timeline?limit=80");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load timeline.");
        setEvents([]);
        return;
      }
      setEvents(data.events ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTimeline();
  }, [fetchTimeline]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            href="/portfolio"
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-2"
          >
            <ArrowLeft className="h-4 w-4" /> Back to portfolio
          </Link>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">
            Portfolio timeline
          </h2>
          <p className="text-muted-foreground text-sm mt-1">
            How your portfolio evolved: position opens and changes, recommendations, alerts, and snapshots. Reverse chronological.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchTimeline} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Timeline</CardTitle>
          <CardDescription>
            Position opened / increased / reduced (from fills), new recommendations and lifecycle events, alerts, and portfolio snapshots.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && events.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
              <Loader2 className="h-5 w-5 animate-spin shrink-0" />
              <span>Loading timeline…</span>
            </div>
          ) : error ? (
            <p className="text-sm text-destructive py-4">{error}</p>
          ) : events.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8">
              No timeline events yet. Sync orders and run recompute to populate fills and snapshots.
            </p>
          ) : (
            <ul className="space-y-0 divide-y divide-border">
              {events.map((ev) => (
                <li key={ev.id} className="py-3 first:pt-0">
                  <div className="flex gap-3">
                    <div className="mt-0.5">
                      <EventIcon type={ev.type} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-medium text-foreground">{ev.title}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {formatDate(ev.occurredAt)}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-0.5 truncate" title={ev.message}>
                        {ev.message}
                      </p>
                      <div className="flex flex-wrap gap-2 mt-1.5">
                        {ev.recommendationId && (
                          <Link
                            href={`/recommendations/${ev.recommendationId}`}
                            className="text-xs text-primary hover:underline"
                          >
                            View recommendation →
                          </Link>
                        )}
                        {ev.marketId && !ev.recommendationId && (
                          <Link href="/portfolio" className="text-xs text-primary hover:underline">
                            Portfolio →
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
