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
import { CheckCircle2, AlertCircle, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";

interface SyncStats {
  walletConnectionExists: boolean;
  credentialsInitialized: boolean;
  signatureType: number | null;
  funderAddressSaved: boolean;
  syncedMarketsCount: number;
  syncedOrdersCount: number;
  syncedFillsCount: number;
  syncedPositionsCount: number;
}

interface SyncHealthJob {
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  metadata?: Record<string, unknown>;
}

interface SyncHealth {
  lastMarketSync: SyncHealthJob | null;
  lastUserSync: SyncHealthJob | null;
}

export function PolymarketSyncWidgets() {
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [syncHealth, setSyncHealth] = useState<SyncHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [marketsSyncing, setMarketsSyncing] = useState(false);
  const [userSyncing, setUserSyncing] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      const [statsRes, healthRes] = await Promise.all([
        fetch("/api/polymarket/sync-stats"),
        fetch("/api/polymarket/sync-health"),
      ]);
      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data);
      }
      if (healthRes.ok) {
        const data = await healthRes.json();
        setSyncHealth({ lastMarketSync: data.lastMarketSync ?? null, lastUserSync: data.lastUserSync ?? null });
      }
    } catch {
      setStats(null);
      setSyncHealth(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const runMarketsSync = async () => {
    setMarketsSyncing(true);
    try {
      const res = await fetch("/api/polymarket/markets/sync", { method: "POST" });
      const data = await res.json();
      await fetchStats();
      if (!res.ok) console.error(data.error ?? data.details);
    } finally {
      setMarketsSyncing(false);
    }
  };

  const runUserSync = async () => {
    setUserSyncing(true);
    try {
      const res = await fetch("/api/polymarket/user/sync", { method: "POST" });
      const data = await res.json();
      await fetchStats();
      if (!res.ok) console.error(data.error ?? data.details);
    } finally {
      setUserSyncing(false);
    }
  };

  function formatTime(iso: string | null): string {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleString();
    } catch {
      return "—";
    }
  }

  if (loading || !stats) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Polymarket status</CardTitle>
            <CardDescription>Loading…</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Loading sync stats…</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connection status</CardTitle>
            <CardDescription>Wallet and funder</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {stats.walletConnectionExists ? (
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-500">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>Wallet connection saved</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-500">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>No connection</span>
              </div>
            )}
            {stats.funderAddressSaved && (
              <p className="text-xs text-muted-foreground">Funder address saved</p>
            )}
            <Link href="/settings/polymarket">
              <Button variant="outline" size="sm" className="mt-2">
                Settings
              </Button>
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Credentials</CardTitle>
            <CardDescription>API credentials initialized</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {stats.credentialsInitialized ? (
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-500">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>Initialized</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>Not initialized</span>
              </div>
            )}
            {stats.signatureType != null && (
              <p className="text-xs text-muted-foreground">Signature type: {stats.signatureType}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Synced markets</CardTitle>
            <CardDescription>Markets in database (read-only)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-2xl font-semibold tabular-nums text-foreground">
              {stats.syncedMarketsCount}
            </p>
            {syncHealth?.lastMarketSync && (
              <p className="text-xs text-muted-foreground">
                Last sync: {formatTime(syncHealth.lastMarketSync.finishedAt ?? syncHealth.lastMarketSync.startedAt)} — {syncHealth.lastMarketSync.status}
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={runMarketsSync}
              disabled={marketsSyncing}
            >
              {marketsSyncing ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3 w-3" />
              )}
              Sync markets
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Synced orders</CardTitle>
            <CardDescription>Open orders (read-only)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-2xl font-semibold tabular-nums text-foreground">
              {stats.syncedOrdersCount}
            </p>
            <p className="text-xs text-muted-foreground">Requires credentials</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Synced fills</CardTitle>
            <CardDescription>Recent trades (read-only, L2 creds only)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-2xl font-semibold tabular-nums text-foreground">
              {stats.syncedFillsCount}
            </p>
            {syncHealth?.lastUserSync && (
              <>
                <p className="text-xs text-muted-foreground">
                  Last sync: {formatTime(syncHealth.lastUserSync.finishedAt ?? syncHealth.lastUserSync.startedAt)} — {syncHealth.lastUserSync.status}
                </p>
                {syncHealth.lastUserSync.errorMessage && (
                  <p className="text-xs text-amber-600 dark:text-amber-500 truncate" title={syncHealth.lastUserSync.errorMessage}>
                    Last error: {syncHealth.lastUserSync.errorMessage}
                  </p>
                )}
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={runUserSync}
              disabled={userSyncing || !stats.credentialsInitialized}
            >
              {userSyncing ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3 w-3" />
              )}
              Sync user data
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Synced positions</CardTitle>
            <CardDescription>Position snapshots (from fills)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-2xl font-semibold tabular-nums text-foreground">
              {stats.syncedPositionsCount}
            </p>
            <p className="text-xs text-muted-foreground">Best-effort from trade history</p>
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">
        Sync is read-only (L2 credentials only; no signer key required). Trading and order placement are disabled.
      </p>
    </>
  );
}
