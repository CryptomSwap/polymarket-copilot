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
import { ArrowLeft, Loader2, RefreshCw, Bell, FileText, Lightbulb, Package, ClipboardCheck, BookOpen, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/** Normalized timeline item from GET /api/portfolio/timeline */
interface TimelineItem {
  id: string;
  eventType: string;
  source: string;
  title: string;
  message: string;
  severity: string | null;
  entityRefs: {
    recommendationId?: string | null;
    marketId?: string | null;
    assetId?: string | null;
    orderId?: string | null;
    journalEntryId?: string | null;
  };
  createdAt: string;
  metadata?: Record<string, unknown>;
}

const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "drift", label: "Drift" },
  { value: "behavior", label: "Behavior" },
  { value: "recommendation", label: "Recommendation" },
  { value: "execution", label: "Execution" },
  { value: "reconciliation", label: "Reconciliation" },
  { value: "journal", label: "Journal" },
  { value: "copilot", label: "Copilot" },
] as const;

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

function SourceIcon({ source }: { source: string }) {
  const cls = "h-4 w-4 shrink-0";
  switch (source) {
    case "drift":
      return <AlertTriangle className={cn(cls, "text-amber-600 dark:text-amber-500")} />;
    case "behavior":
      return <Bell className={cn(cls, "text-muted-foreground")} />;
    case "recommendation":
      return <Lightbulb className={cn(cls, "text-muted-foreground")} />;
    case "execution":
      return <Package className={cn(cls, "text-green-600 dark:text-green-500")} />;
    case "reconciliation":
      return <ClipboardCheck className={cn(cls, "text-muted-foreground")} />;
    case "journal":
      return <BookOpen className={cn(cls, "text-muted-foreground")} />;
    case "copilot":
      return <Bell className={cn(cls, "text-amber-600 dark:text-amber-500")} />;
    default:
      return <FileText className={cn(cls, "text-muted-foreground")} />;
  }
}

export default function PortfolioTimelinePage() {
  const [events, setEvents] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const fetchTimeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      const res = await fetch(`/api/portfolio/timeline?${params.toString()}`);
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
  }, [sourceFilter]);

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
            Chronological feed of drift alerts, behavior flags, recommendations, execution outcomes, reconciliation, journal entries, and copilot alerts.
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
            Newest first. Filter by source to narrow the feed.
          </CardDescription>
          <div className="pt-2">
            <select
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              aria-label="Filter by source"
            >
              {SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
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
              No timeline events for this filter. Try &quot;All sources&quot; or run sync and recompute to populate data.
            </p>
          ) : (
            <ul className="space-y-0 divide-y divide-border">
              {events.map((ev) => (
                <li key={ev.id} className="py-3 first:pt-0">
                  <div className="flex gap-3">
                    <div className="mt-0.5">
                      <SourceIcon source={ev.source} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-medium text-foreground">{ev.title}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {formatDate(ev.createdAt)}
                        </span>
                        <span
                          className={cn(
                            "text-xs rounded px-1.5 py-0.5 bg-muted text-muted-foreground",
                            ev.severity === "high" && "bg-red-500/10 text-red-700 dark:text-red-400",
                            ev.severity === "warning" && "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                          )}
                        >
                          {ev.source}
                        </span>
                        {ev.severity && (
                          <span className="text-xs text-muted-foreground">{ev.severity}</span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mt-0.5 truncate" title={ev.message}>
                        {ev.message}
                      </p>
                      <div className="flex flex-wrap gap-2 mt-1.5">
                        {ev.entityRefs.recommendationId && (
                          <Link
                            href={`/recommendations/${ev.entityRefs.recommendationId}`}
                            className="text-xs text-primary hover:underline"
                          >
                            View recommendation →
                          </Link>
                        )}
                        {ev.entityRefs.marketId && !ev.entityRefs.recommendationId && (
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
