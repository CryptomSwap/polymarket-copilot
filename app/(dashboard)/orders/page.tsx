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
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface OrderIntentRow {
  id: string;
  recommendationId: string | null;
  linkedRecommendation?: boolean;
  matchedSuggestedSide: boolean | null;
  matchedSuggestedSize: boolean | null;
  matchedSuggestedPrice: boolean | null;
  orderMatchedRecommendation?: boolean;
  marketId: string;
  assetId: string;
  outcome: string;
  side: string;
  orderType: string;
  limitPrice: string;
  size: string;
  status: string;
  riskPreviewJson: string | null;
  createdAt: string;
  updatedAt: string;
  executedOrders: Array<{ id: string; polymarketOrderId: string; status: string; createdAt: string }>;
}

interface ReconciliationRow {
  localStatus: string;
  remoteStatus: string | null;
  filledSize: string | null;
  remainingSize: string | null;
  avgFillPrice: string | null;
  mismatch: boolean;
}

interface ExecutedRow {
  id: string;
  orderIntentId: string | null;
  polymarketOrderId: string;
  marketId: string;
  assetId: string;
  side: string;
  price: string;
  size: string;
  status: string;
  createdAt: string;
  reconciliation: ReconciliationRow | null;
}

interface OpenOrderRow {
  id: string;
  orderId: string;
  market: string;
  assetId: string;
  side: string;
  originalSize: string;
  sizeMatched: string;
  price: string;
  status: string;
  outcome: string | null;
  syncedAt: string;
}

export default function OrdersPage() {
  const [intents, setIntents] = useState<OrderIntentRow[]>([]);
  const [executed, setExecuted] = useState<ExecutedRow[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconSummary, setReconSummary] = useState<{ total: number; mismatchCount: number; partialFillCount: number; avgEffectiveSlippage: number | null } | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean | null>(null);
  const [driftAlertOrderIds, setDriftAlertOrderIds] = useState<Set<string>>(new Set());

  const fetchOrders = useCallback(async () => {
    try {
      const [listRes, summaryRes] = await Promise.all([
        fetch("/api/orders/list?limit=50"),
        fetch("/api/orders/reconciliation-summary"),
      ]);
      if (listRes.ok) {
        const data = await listRes.json();
        setIntents(data.orderIntents ?? []);
        setExecuted(data.executedOrders ?? []);
        setOpenOrders(data.openOrders ?? []);
      }
      if (summaryRes.ok) {
        const sum = await summaryRes.json();
        setReconSummary(sum.summary ?? null);
      }
      try {
        const [wsRes, alertsRes] = await Promise.all([
          fetch("/api/live/ws-status"),
          fetch("/api/live/alerts?resolved=false&limit=100"),
        ]);
        if (wsRes.ok) {
          const ws = await wsRes.json();
          setWsConnected(!!ws?.userFeed?.connected);
        }
        if (alertsRes.ok) {
          const { alerts: list } = await alertsRes.json();
          const ids = new Set<string>();
          (list ?? []).forEach((a: { polymarketOrderId?: string | null }) => {
            if (a.polymarketOrderId) ids.add(a.polymarketOrderId);
          });
          setDriftAlertOrderIds(ids);
        }
      } catch {
        setWsConnected(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const cancelOrder = async (polymarketOrderId: string) => {
    setCancellingId(polymarketOrderId);
    try {
      const res = await fetch("/api/orders/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ polymarketOrderId }),
      });
      if (res.ok) await fetchOrders();
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Orders</h2>
          <p className="text-muted-foreground">
            Recent order intents, executed orders, and open orders. Manual placement only; cancel where allowed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {wsConnected !== null && (
            <span className={cn(
              "text-xs rounded px-2 py-1",
              wsConnected ? "bg-green-500/20 text-green-700 dark:text-green-400" : "bg-muted text-muted-foreground"
            )}>
              Live: {wsConnected ? "connected" : "not connected"}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={reconciling}
            onClick={async () => {
              setReconciling(true);
              try {
                await fetch("/api/orders/reconcile", { method: "POST" });
                await fetchOrders();
              } finally {
                setReconciling(false);
              }
            }}
          >
            {reconciling ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            Reconcile orders
          </Button>
        </div>
      </div>
      {reconSummary && (
        <Card>
          <CardHeader>
            <CardTitle>Reconciliation summary</CardTitle>
            <CardDescription>Local vs remote order state. Run user sync then Reconcile to refresh.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4 text-sm">
            <span>Total: {reconSummary.total}</span>
            <span className={reconSummary.mismatchCount > 0 ? "text-amber-600 dark:text-amber-400" : ""}>Mismatches: {reconSummary.mismatchCount}</span>
            <span>Partial fills: {reconSummary.partialFillCount}</span>
            {reconSummary.avgEffectiveSlippage != null && (
              <span>Avg effective slippage: {(reconSummary.avgEffectiveSlippage * 100).toFixed(2)}%</span>
            )}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Order intents</CardTitle>
              <CardDescription>Intents created when you place an order (pending → placed → executed/failed).</CardDescription>
            </CardHeader>
            <CardContent>
              {intents.length === 0 ? (
                <p className="text-sm text-muted-foreground">No order intents yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 px-2 font-medium">Created</th>
                        <th className="text-left py-2 px-2 font-medium">Asset / outcome</th>
                        <th className="text-left py-2 px-2 font-medium">Side</th>
                        <th className="text-right py-2 px-2 font-medium">Price</th>
                        <th className="text-right py-2 px-2 font-medium">Size</th>
                        <th className="text-left py-2 px-2 font-medium">Status</th>
                        <th className="text-left py-2 px-2 font-medium">Recommendation</th>
                        <th className="text-left py-2 px-2 font-medium">Matched</th>
                      </tr>
                    </thead>
                    <tbody>
                      {intents.map((i) => (
                        <tr key={i.id} className="border-b border-border/50">
                          <td className="py-2 px-2">{new Date(i.createdAt).toLocaleString()}</td>
                          <td className="py-2 px-2">{i.assetId.slice(0, 8)}… / {i.outcome}</td>
                          <td className="py-2 px-2">{i.side}</td>
                          <td className="py-2 px-2 text-right tabular-nums">{i.limitPrice}</td>
                          <td className="py-2 px-2 text-right tabular-nums">{i.size}</td>
                          <td className="py-2 px-2">
                            <span className={cn(
                              i.status === "placed" && "text-green-600 dark:text-green-400",
                              i.status === "failed" && "text-red-600 dark:text-red-400",
                              i.status === "cancelled" && "text-muted-foreground"
                            )}>
                              {i.status}
                            </span>
                          </td>
                          <td className="py-2 px-2">
                            {i.recommendationId ? (
                              <Link href={`/recommendations/${i.recommendationId}`} className="text-primary hover:underline text-xs">
                                View
                              </Link>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="py-2 px-2">
                            {i.orderMatchedRecommendation === true ? (
                              <span className="text-green-600 dark:text-green-500">Yes</span>
                            ) : i.orderMatchedRecommendation === false ? (
                              <span className="text-amber-600 dark:text-amber-500">No</span>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Executed orders</CardTitle>
              <CardDescription>Orders successfully submitted to Polymarket CLOB. Reconcile to refresh filled/remaining and mismatch.</CardDescription>
            </CardHeader>
            <CardContent>
              {executed.length === 0 ? (
                <p className="text-sm text-muted-foreground">No executed orders yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 px-2 font-medium">Created</th>
                        <th className="text-left py-2 px-2 font-medium">Order ID</th>
                        <th className="text-left py-2 px-2 font-medium">Side</th>
                        <th className="text-right py-2 px-2 font-medium">Price</th>
                        <th className="text-right py-2 px-2 font-medium">Size</th>
                        <th className="text-right py-2 px-2 font-medium">Filled</th>
                        <th className="text-right py-2 px-2 font-medium">Remaining</th>
                        <th className="text-right py-2 px-2 font-medium">Avg fill</th>
                        <th className="text-left py-2 px-2 font-medium">Status</th>
                        <th className="text-left py-2 px-2 font-medium">Mismatch</th>
                        <th className="text-left py-2 px-2 font-medium">Live</th>
                      </tr>
                    </thead>
                    <tbody>
                      {executed.map((e) => {
                        const r = e.reconciliation;
                        const hasDrift = driftAlertOrderIds.has(e.polymarketOrderId);
                        const partialFill = r && parseFloat(r.filledSize ?? "0") > 0 && parseFloat(r.remainingSize ?? "0") > 0;
                        return (
                          <tr key={e.id} className="border-b border-border/50">
                            <td className="py-2 px-2">{new Date(e.createdAt).toLocaleString()}</td>
                            <td className="py-2 px-2 font-mono text-xs">{e.polymarketOrderId}</td>
                            <td className="py-2 px-2">{e.side}</td>
                            <td className="py-2 px-2 text-right tabular-nums">{e.price}</td>
                            <td className="py-2 px-2 text-right tabular-nums">{e.size}</td>
                            <td className="py-2 px-2 text-right tabular-nums">{r?.filledSize ?? "—"}</td>
                            <td className="py-2 px-2 text-right tabular-nums">{r?.remainingSize ?? "—"}</td>
                            <td className="py-2 px-2 text-right tabular-nums">{r?.avgFillPrice ?? "—"}</td>
                            <td className="py-2 px-2">{e.status}{partialFill ? " (partial)" : ""}</td>
                            <td className="py-2 px-2">
                              {r?.mismatch ? (
                                <span className="rounded bg-amber-500/20 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 text-xs">Mismatch</span>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="py-2 px-2 flex gap-1 flex-wrap">
                              {wsConnected && <span className="rounded bg-green-500/20 text-green-700 dark:text-green-400 px-1.5 py-0.5 text-xs" title="WebSocket connected">WS</span>}
                              {hasDrift && <span className="rounded bg-red-500/20 text-red-700 dark:text-red-400 px-1.5 py-0.5 text-xs" title="Active drift alert">Drift</span>}
                              {!wsConnected && !hasDrift && "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Open orders</CardTitle>
              <CardDescription>Synced from Polymarket. Cancel action when trading is configured.</CardDescription>
            </CardHeader>
            <CardContent>
              {openOrders.length === 0 ? (
                <p className="text-sm text-muted-foreground">No open orders.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 px-2 font-medium">Order ID</th>
                        <th className="text-left py-2 px-2 font-medium">Side</th>
                        <th className="text-right py-2 px-2 font-medium">Size</th>
                        <th className="text-right py-2 px-2 font-medium">Price</th>
                        <th className="text-left py-2 px-2 font-medium">Status</th>
                        <th className="text-left py-2 px-2 font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openOrders.map((o) => (
                        <tr key={o.id} className="border-b border-border/50">
                          <td className="py-2 px-2 font-mono text-xs">{o.orderId}</td>
                          <td className="py-2 px-2">{o.side}</td>
                          <td className="py-2 px-2 text-right tabular-nums">{o.originalSize}</td>
                          <td className="py-2 px-2 text-right tabular-nums">{o.price}</td>
                          <td className="py-2 px-2">{o.status}</td>
                          <td className="py-2 px-2">
                            {o.status?.toLowerCase() === "live" || o.status?.toLowerCase() === "open" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={cancellingId === o.orderId}
                                onClick={() => cancelOrder(o.orderId)}
                              >
                                {cancellingId === o.orderId ? <Loader2 className="h-3 w-3 animate-spin" /> : "Cancel"}
                              </Button>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
