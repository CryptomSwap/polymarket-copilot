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
import Link from "next/link";
import { Bell, Loader2, RefreshCw, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";

interface CopilotAlertItem {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  marketId: string | null;
  recommendationId: string | null;
  assetId: string | null;
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AlertsResponse {
  alerts: CopilotAlertItem[];
  unreadCount: number;
}

const ALERT_TYPE_LABELS: Record<string, string> = {
  CONCENTRATION_BREACH: "Concentration",
  NEW_ADD_OPPORTUNITY: "Add opportunity",
  NEAR_RESOLUTION_REVIEW: "Near resolution",
  HELD_MARKET_SIGNAL_FLIP: "Trim/exit signal",
  DATA_HEALTH: "Data health",
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  info: "bg-muted text-muted-foreground border-border",
};

export function AlertsWidget() {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [marking, setMarking] = useState<string | "all" | null>(null);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts?limit=10");
      if (res.ok) {
        const json = await res.json();
        setData({ alerts: json.alerts ?? [], unreadCount: json.unreadCount ?? 0 });
      } else {
        setData({ alerts: [], unreadCount: 0 });
      }
    } catch {
      setData({ alerts: [], unreadCount: 0 });
    } finally {
      setLoading(false);
    }
  }, []);

  const runGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      await fetch("/api/alerts/generate", { method: "POST" });
      await fetchAlerts();
    } finally {
      setGenerating(false);
    }
  }, [fetchAlerts]);

  const markRead = useCallback(
    async (ids: string[] | "all") => {
      setMarking(ids === "all" ? "all" : ids[0] ?? null);
      try {
        await fetch("/api/alerts/mark-read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            ids === "all" ? { markAll: true } : { ids }
          ),
        });
        await fetchAlerts();
      } finally {
        setMarking(null);
      }
    },
    [fetchAlerts]
  );

  useEffect(() => {
    runGenerate();
  }, []);

  if (loading && !data) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Bell className="h-4 w-4 shrink-0 text-muted-foreground" />
            Alerts
          </CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <span>Checking for alerts.</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const alerts = data?.alerts ?? [];
  const unreadCount = data?.unreadCount ?? 0;
  const unread = alerts.filter((a) => !a.isRead);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Bell className="h-4 w-4 shrink-0 text-muted-foreground" />
              Alerts
            </CardTitle>
            {unreadCount > 0 && (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
                  "bg-primary/15 text-primary"
                )}
              >
                {unreadCount} unread
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => runGenerate()}
              disabled={generating}
              aria-label="Refresh alerts"
            >
              {generating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => markRead("all")}
                disabled={marking === "all"}
                aria-label="Mark all as read"
              >
                {marking === "all" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCheck className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>
        </div>
        <CardDescription>
          Proactive portfolio and recommendation alerts. Run sync and recompute for fresh data.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No alerts. Concentration, data health, and opportunities are within normal ranges.
          </p>
        ) : (
          <ul className="space-y-2">
            {alerts.slice(0, 5).map((a) => (
              <li
                key={a.id}
                className={cn(
                  "rounded-lg border px-3 py-2 text-sm",
                  !a.isRead && "bg-muted/50",
                  SEVERITY_STYLES[a.severity] ?? SEVERITY_STYLES.info
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{a.title}</p>
                    <p className="text-muted-foreground line-clamp-2 mt-0.5">
                      {a.message}
                    </p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-xs text-muted-foreground">
                        {ALERT_TYPE_LABELS[a.type] ?? a.type}
                      </span>
                      {a.recommendationId && (
                        <Link
                          href={`/recommendations/${a.recommendationId}`}
                          className="text-xs text-primary hover:underline"
                        >
                          View recommendation →
                        </Link>
                      )}
                      {a.marketId && !a.recommendationId && (
                        <Link
                          href="/portfolio"
                          className="text-xs text-primary hover:underline"
                        >
                          Portfolio →
                        </Link>
                      )}
                    </div>
                  </div>
                  {!a.isRead && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 h-7 px-2"
                      onClick={() => markRead([a.id])}
                      disabled={marking === a.id}
                    >
                      {marking === a.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCheck className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {alerts.length > 5 && (
          <Link
            href="/portfolio"
            className="text-sm text-primary hover:underline inline-block"
          >
            View all alerts on Portfolio →
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
