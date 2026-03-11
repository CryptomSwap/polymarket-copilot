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
import { Loader2, RefreshCw, Newspaper } from "lucide-react";

interface NewsStats {
  sourcesCount: number;
  totalItems: number;
  totalLinks: number;
  recentItems: Array<{ id: string; title: string; publishedAt: string | null; sourceName: string }>;
}

export function NewsSyncWidget() {
  const [stats, setStats] = useState<NewsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<{ itemsCreated: number; linksCreated: number; errors: string[] } | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/news/stats");
      if (res.ok) {
        const data = await res.json();
        setStats({
          sourcesCount: data.sourcesCount ?? 0,
          totalItems: data.totalItems ?? 0,
          totalLinks: data.totalLinks ?? 0,
          recentItems: data.recentItems ?? [],
        });
      } else setStats(null);
    } catch {
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const runSync = async () => {
    setSyncing(true);
    setLastResult(null);
    try {
      const res = await fetch("/api/news/sync", { method: "POST" });
      const data = await res.json();
      setLastResult({
        itemsCreated: data.itemsCreated ?? 0,
        linksCreated: data.linksCreated ?? 0,
        errors: data.errors ?? [],
      });
      await fetchStats();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Newspaper className="h-5 w-5" />
          News ingestion
        </CardTitle>
        <CardDescription>
          RSS sources, linked to markets. Sync to fetch, dedupe, link, and compute catalyst features.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button variant="outline" size="sm" onClick={runSync} disabled={syncing}>
          {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Sync news
        </Button>
        {lastResult && (
          <p className="text-sm text-muted-foreground">
            Last sync: {lastResult.itemsCreated} new items, {lastResult.linksCreated} links.
            {lastResult.errors.length > 0 && ` Errors: ${lastResult.errors.join("; ")}`}
          </p>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading stats…</p>
        ) : stats ? (
          <div className="text-sm space-y-1">
            <p>Sources: {stats.sourcesCount} · Items: {stats.totalItems} · Market links: {stats.totalLinks}</p>
            {stats.recentItems.length > 0 && (
              <p className="text-muted-foreground truncate">Latest: {stats.recentItems[0]?.title?.slice(0, 60)}…</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No news data. Run Sync news.</p>
        )}
      </CardContent>
    </Card>
  );
}
