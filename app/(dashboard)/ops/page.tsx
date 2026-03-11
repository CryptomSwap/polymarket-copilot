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
import { Loader2, Activity, Radio, AlertTriangle, RefreshCw, Server, Play, CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface WsChannel {
  connected: boolean;
  lastHeartbeatAt: string | null;
  lastMessageAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

interface LiveEventRow {
  id: string;
  source: string;
  eventType: string;
  polymarketOrderId: string | null;
  assetId: string | null;
  marketId: string | null;
  createdAt: string;
}

interface DriftAlertRow {
  id: string;
  alertType: string;
  severity: string;
  message: string;
  polymarketOrderId: string | null;
  assetId: string | null;
  marketId: string | null;
  resolved: boolean;
  createdAt: string;
}

interface PositionRow {
  id: string;
  marketTitle: string;
  outcome: string;
  decision: { decisionState: string } | null;
  unrealizedPnl: string;
}

interface WorkerHeartbeatRow {
  workerName: string;
  status: string;
  lastSeenAt: string;
  metadataJson: string | null;
  updatedAt: string;
}

interface JobRunRow {
  id: string;
  jobName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export default function OpsPage() {
  const [wsStatus, setWsStatus] = useState<{ userFeed: WsChannel; marketFeed: WsChannel } | null>(null);
  const [events, setEvents] = useState<LiveEventRow[]>([]);
  const [alerts, setAlerts] = useState<DriftAlertRow[]>([]);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [openOrders, setOpenOrders] = useState<Array<{ orderId: string; assetId: string; market: string; originalSize: string; sizeMatched: string; status: string }>>([]);
  const [workerHeartbeats, setWorkerHeartbeats] = useState<WorkerHeartbeatRow[]>([]);
  const [jobRuns, setJobRuns] = useState<JobRunRow[]>([]);
  const [lastSuccessByJob, setLastSuccessByJob] = useState<Record<string, { finishedAt: string | null; durationMs: number | null } | null>>({});
  const [lastFailureByJob, setLastFailureByJob] = useState<Record<string, { finishedAt: string | null; errorMessage: string | null } | null>>({});
  const [loading, setLoading] = useState(true);
  const [reconciling, setReconciling] = useState(false);
  const [runningJob, setRunningJob] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [wsRes, eventsRes, alertsRes, positionsRes, ordersRes, workerRes, jobsRes] = await Promise.all([
        fetch("/api/live/ws-status"),
        fetch("/api/live/events?limit=30"),
        fetch("/api/live/alerts?resolved=false&limit=30"),
        fetch("/api/portfolio/positions"),
        fetch("/api/orders/list?limit=50"),
        fetch("/api/ops/worker-status"),
        fetch("/api/ops/job-runs?limit=30"),
      ]);
      if (wsRes.ok) {
        const d = await wsRes.json();
        setWsStatus({ userFeed: d.userFeed ?? d.channels?.["user-feed"], marketFeed: d.marketFeed ?? d.channels?.["market-feed"] });
      } else setWsStatus(null);
      if (eventsRes.ok) {
        const d = await eventsRes.json();
        setEvents(d.events ?? []);
      } else setEvents([]);
      if (alertsRes.ok) {
        const d = await alertsRes.json();
        setAlerts(d.alerts ?? []);
      } else setAlerts([]);
      if (positionsRes.ok) {
        const d = await positionsRes.json();
        setPositions(d.positions ?? []);
      } else setPositions([]);
      if (ordersRes.ok) {
        const d = await ordersRes.json();
        setOpenOrders(d.openOrders ?? []);
      } else setOpenOrders([]);
      if (workerRes.ok) {
        const d = await workerRes.json();
        setWorkerHeartbeats(d.workers ?? d.heartbeats ?? []);
      } else setWorkerHeartbeats([]);
      if (jobsRes.ok) {
        const d = await jobsRes.json();
        setJobRuns(d.runs ?? []);
        setLastSuccessByJob(d.lastSuccessByJob ?? {});
        setLastFailureByJob(d.lastFailureByJob ?? {});
      } else {
        setJobRuns([]);
        setLastSuccessByJob({});
        setLastFailureByJob({});
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 15000);
    return () => clearInterval(t);
  }, [fetchData]);

  const runReconcile = async () => {
    setReconciling(true);
    try {
      await fetch("/api/live/reconcile-affected", { method: "POST" });
      await fetchData();
    } finally {
      setReconciling(false);
    }
  };

  const runJobNow = async (jobName: string) => {
    setRunningJob(jobName);
    try {
      const res = await fetch("/api/ops/run-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Run failed");
      await fetchData();
    } finally {
      setRunningJob(null);
    }
  };

  const urgentPositions = positions.filter(
    (p) => p.decision?.decisionState === "EXIT" || p.decision?.decisionState === "THESIS_BROKEN"
  );
  const activeAlerts = alerts.filter((a) => !a.resolved);

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">Ops</h2>
        <p className="text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Ops</h2>
          <p className="text-muted-foreground">
            Live operator console: WebSocket status, events, drift alerts, urgent positions. Monitoring only; no autonomous trading.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={runReconcile} disabled={reconciling}>
          {reconciling ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
          Reconcile affected
        </Button>
      </div>

      {/* Worker process health (distinct from WebSocket connection status) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Server className="h-5 w-5" /> Worker process health</CardTitle>
          <CardDescription>Background worker heartbeat. Run the worker separately (e.g. npm run worker). Separate from WebSocket connection status below.</CardDescription>
        </CardHeader>
        <CardContent>
          {workerHeartbeats.length === 0 ? (
            <p className="text-sm text-muted-foreground">No worker heartbeats. Start the worker process to see status here.</p>
          ) : (
            <div className="space-y-3">
              {workerHeartbeats.map((w) => (
                <div
                  key={w.workerName}
                  className={cn(
                    "rounded-lg border p-4",
                    w.status === "running" ? "border-green-500/50 bg-green-500/5" : "border-muted bg-muted/30"
                  )}
                >
                  <p className="font-medium flex items-center gap-2">
                    {w.workerName} — {w.status}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Last seen: {new Date(w.lastSeenAt).toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">Updated: {new Date(w.updatedAt).toLocaleString()}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* WebSocket status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Radio className="h-5 w-5" /> WebSocket connection status</CardTitle>
          <CardDescription>User-feed and market-feed connection; heartbeat and last message times.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {wsStatus?.userFeed && (
            <div className={cn(
              "rounded-lg border p-4",
              wsStatus.userFeed.connected ? "border-green-500/50 bg-green-500/5" : "border-muted bg-muted/30"
            )}>
              <p className="font-medium flex items-center gap-2">
                User feed {wsStatus.userFeed.connected ? "connected" : "disconnected"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Last message: {wsStatus.userFeed.lastMessageAt ? new Date(wsStatus.userFeed.lastMessageAt).toLocaleString() : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Heartbeat: {wsStatus.userFeed.lastHeartbeatAt ? new Date(wsStatus.userFeed.lastHeartbeatAt).toLocaleString() : "—"}</p>
              {wsStatus.userFeed.lastError && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{wsStatus.userFeed.lastError}</p>}
            </div>
          )}
          {wsStatus?.marketFeed && (
            <div className={cn(
              "rounded-lg border p-4",
              wsStatus.marketFeed.connected ? "border-green-500/50 bg-green-500/5" : "border-muted bg-muted/30"
            )}>
              <p className="font-medium flex items-center gap-2">
                Market feed {wsStatus.marketFeed.connected ? "connected" : "disconnected"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Last message: {wsStatus.marketFeed.lastMessageAt ? new Date(wsStatus.marketFeed.lastMessageAt).toLocaleString() : "—"}
              </p>
              {wsStatus.marketFeed.lastError && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{wsStatus.marketFeed.lastError}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Scheduled job runs */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5" /> Scheduled job runs</CardTitle>
          <CardDescription>Recent runs and last success/failure per job. Use Run now to trigger manually.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 text-sm">
            {[
              "market_sync", "user_sync", "news_sync", "market_snapshot_capture",
              "recommendation_recompute", "decision_recompute", "order_reconciliation",
              "recommendation_evaluation", "position_decision_recompute",
            ].map((jobName) => (
              <div key={jobName} className="flex flex-wrap items-center gap-2 rounded border border-border px-3 py-2">
                <span className="font-mono text-xs flex-1 min-w-0 truncate">{jobName}</span>
                {lastSuccessByJob[jobName] && (() => {
                  const last = lastSuccessByJob[jobName]!;
                  return (
                    <span className="flex items-center gap-1 text-muted-foreground text-xs">
                      <CheckCircle className="h-3.5 w-3.5 text-green-600" />
                      Last OK: {last.finishedAt ? new Date(last.finishedAt).toLocaleString() : "—"}
                      {last.durationMs != null && ` (${last.durationMs}ms)`}
                    </span>
                  );
                })()}
                {lastFailureByJob[jobName] && (() => {
                  const last = lastFailureByJob[jobName]!;
                  return (
                    <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 text-xs" title={last.errorMessage ?? ""}>
                      <XCircle className="h-3.5 w-3.5" />
                      Last fail: {last.finishedAt ? new Date(last.finishedAt).toLocaleString() : "—"}
                    </span>
                  );
                })()}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={runningJob !== null}
                  onClick={() => runJobNow(jobName)}
                >
                  {runningJob === jobName ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Play className="h-3 w-3 mr-1" />}
                  Run now
                </Button>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto text-sm">
            <p className="font-medium mb-2">Recent runs</p>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-2 font-medium">Job</th>
                  <th className="text-left py-2 px-2 font-medium">Status</th>
                  <th className="text-right py-2 px-2 font-medium">Duration</th>
                  <th className="text-left py-2 px-2 font-medium">Started</th>
                  <th className="text-left py-2 px-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {jobRuns.slice(0, 15).map((r) => (
                  <tr key={r.id} className="border-b border-border/50">
                    <td className="py-2 px-2 font-mono text-xs">{r.jobName}</td>
                    <td className="py-2 px-2">
                      <span className={cn(
                        "rounded px-1.5 py-0.5 text-xs",
                        r.status === "success" && "bg-green-500/20 text-green-700 dark:text-green-400",
                        r.status === "failure" && "bg-red-500/20 text-red-700 dark:text-red-400",
                        r.status === "running" && "bg-blue-500/20 text-blue-700 dark:text-blue-400",
                        r.status === "idle" && "bg-muted text-muted-foreground"
                      )}>{r.status}</span>
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">{r.durationMs != null ? `${r.durationMs}ms` : "—"}</td>
                    <td className="py-2 px-2 text-muted-foreground">{new Date(r.startedAt).toLocaleString()}</td>
                    <td className="py-2 px-2 max-w-[200px] truncate text-amber-600 dark:text-amber-400" title={r.errorMessage ?? ""}>{r.errorMessage ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Active drift alerts */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5" /> Active drift alerts</CardTitle>
          <CardDescription>Unresolved alerts from local vs remote mismatch, stale WS, or stale decision.</CardDescription>
        </CardHeader>
        <CardContent>
          {activeAlerts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active alerts.</p>
          ) : (
            <div className="overflow-x-auto text-sm">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-2 font-medium">Type</th>
                    <th className="text-left py-2 px-2 font-medium">Severity</th>
                    <th className="text-left py-2 px-2 font-medium">Message</th>
                    <th className="text-left py-2 px-2 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {activeAlerts.slice(0, 15).map((a) => (
                    <tr key={a.id} className="border-b border-border/50">
                      <td className="py-2 px-2">{a.alertType}</td>
                      <td className="py-2 px-2">
                        <span className={cn(
                          "rounded px-1.5 py-0.5 text-xs",
                          a.severity === "critical" && "bg-red-500/20 text-red-700 dark:text-red-400",
                          a.severity === "warning" && "bg-amber-500/20 text-amber-700 dark:text-amber-400",
                          a.severity === "info" && "bg-muted text-muted-foreground"
                        )}>{a.severity}</span>
                      </td>
                      <td className="py-2 px-2 max-w-[300px] truncate" title={a.message}>{a.message}</td>
                      <td className="py-2 px-2 text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Urgent positions (EXIT / THESIS_BROKEN) */}
      <Card>
        <CardHeader>
          <CardTitle>Urgent positions</CardTitle>
          <CardDescription>Positions with decision EXIT or THESIS_BROKEN. Review on Portfolio.</CardDescription>
        </CardHeader>
        <CardContent>
          {urgentPositions.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {urgentPositions.map((p) => (
                <li key={p.id} className="flex items-center justify-between rounded border border-border px-3 py-2">
                  <span className="font-medium truncate max-w-[200px]" title={p.marketTitle}>{p.marketTitle}</span>
                  <span className="rounded bg-red-500/20 text-red-700 dark:text-red-400 px-2 py-0.5 text-xs">{p.decision?.decisionState}</span>
                  <Link href="/portfolio" className="text-primary text-xs hover:underline">Review</Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Open live orders with partial fill */}
      <Card>
        <CardHeader>
          <CardTitle>Open orders</CardTitle>
          <CardDescription>Synced open orders; partial fill from sizeMatched vs originalSize.</CardDescription>
        </CardHeader>
        <CardContent>
          {openOrders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open orders.</p>
          ) : (
            <div className="overflow-x-auto text-sm">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-2 font-medium">Order ID</th>
                    <th className="text-right py-2 px-2 font-medium">Original</th>
                    <th className="text-right py-2 px-2 font-medium">Matched</th>
                    <th className="text-left py-2 px-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {openOrders.slice(0, 15).map((o) => {
                    const orig = parseFloat(o.originalSize);
                    const matched = parseFloat(o.sizeMatched);
                    const partial = orig > 0 && matched > 0 && matched < orig;
                    return (
                      <tr key={o.orderId} className="border-b border-border/50">
                        <td className="py-2 px-2 font-mono text-xs">{o.orderId.slice(0, 12)}…</td>
                        <td className="py-2 px-2 text-right tabular-nums">{o.originalSize}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{o.sizeMatched}{partial && " (partial)"}</td>
                        <td className="py-2 px-2">{o.status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent live events */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5" /> Recent live events</CardTitle>
          <CardDescription>Last 30 events from user-feed and market-feed.</CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events yet. WebSocket events will appear here.</p>
          ) : (
            <div className="overflow-x-auto text-sm">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-2 font-medium">Source</th>
                    <th className="text-left py-2 px-2 font-medium">Type</th>
                    <th className="text-left py-2 px-2 font-medium">Order / Asset</th>
                    <th className="text-left py-2 px-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {events.slice(0, 20).map((e) => (
                    <tr key={e.id} className="border-b border-border/50">
                      <td className="py-2 px-2">{e.source}</td>
                      <td className="py-2 px-2">{e.eventType}</td>
                      <td className="py-2 px-2 font-mono text-xs">{e.polymarketOrderId ?? e.assetId ?? "—"}</td>
                      <td className="py-2 px-2 text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
