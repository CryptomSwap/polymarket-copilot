"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import Link from "next/link";
import { RefreshCw, Loader2, X, AlertTriangle, Clock, FileQuestion, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { computeCanonicalPositionInsight } from "@/lib/portfolio/canonical-position-insight";
import {
  getPositionDisplayState,
  toPositionViewFromCanonical,
  type PositionView,
} from "@/lib/portfolio/position-display";
import { useLivePortfolioPolling } from "@/hooks/use-live-portfolio-polling";
import { PortfolioFreshnessIndicator } from "@/components/portfolio/portfolio-freshness-indicator";

// Canonical position view (from GET /api/portfolio/positions?canonical=true)
interface CanonicalPositionMarket {
  id: string | null;
  conditionId: string | null;
  slug: string | null;
  title: string;
  category: string | null;
  theme: string | null;
  endDate: string | null;
  status: string | null;
}

interface CanonicalPositionToken {
  assetId: string;
  outcome: string;
  side: string;
}

interface CanonicalPositionEconomics {
  quantity: string;
  avgEntry: string;
  markPrice: string;
  exposure?: string;
  currentValue?: string;
  costBasis: string;
  maxPayout?: string;
  unrealizedPnl: string;
  realizedPnl: string;
}

interface CanonicalPositionTiming {
  firstFillAt: string | null;
  lastFillAt: string | null;
  hoursToResolution: number | null;
  lastSyncedAt: string | null;
}

interface CanonicalPositionQuality {
  /** True when linked to canonical market record. */
  isResolved: boolean;
  matchedBy: "marketId" | "conditionId" | "assetId" | null;
  /** True when all required display metadata present. */
  hasCompleteDisplayMetadata?: boolean;
  /** True when market end date is in the past (for time-to-resolution display). */
  marketEndDatePassed?: boolean;
  hasPriceContext: boolean;
  warnings: string[];
}

interface CanonicalPositionView {
  id: string;
  market: CanonicalPositionMarket;
  token: CanonicalPositionToken;
  economics: CanonicalPositionEconomics;
  timing: CanonicalPositionTiming;
  quality: CanonicalPositionQuality;
}

interface PositionDecision {
  decisionState: string;
  confidence: string;
  suggestedExitSize: string;
  reasoningJson: string | null;
}

interface PositionThesisMeta {
  id: string;
  entryThesis: string | null;
  currentThesisStatus: string;
  exitReason: string | null;
  notes: string | null;
  updatedAt: string;
}

interface CanonicalPositionWithMeta extends CanonicalPositionView {
  syncedMarketId?: string | null;
  rawMarketRef?: string;
  rawMarketId?: string;
  resolutionSource?: string;
  positionView?: PositionView;
  decision: PositionDecision | null;
  newsLinkCount?: number;
  thesis?: PositionThesisMeta | null;
}

/** Shape returned by positions + alerts polling for live portfolio page */
interface PositionsPollingData {
  positions: CanonicalPositionWithMeta[];
  /** False when GET /api/portfolio/positions returned non-OK (e.g. 500). Use to show error instead of "No positions". */
  positionsFetchOk?: boolean;
  sourceOfTruth?: string;
  asOf?: string;
  freshnessMs?: number | null;
  alerts: Array<{
    id: string;
    message: string;
    severity: string;
    assetId: string | null;
    marketId: string | null;
    source?: "drift" | "engine";
    title?: string;
  }>;
}

function formatUsd(val: string): string {
  const n = parseFloat(val);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function formatPct(val: string): string {
  const n = parseFloat(val);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}¢`;
}

function formatTimeToResolution(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours)) return "—";
  if (hours < 1) return "<1h";
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatRelativeDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "—";
    const now = Date.now();
    const diffMs = now - d.getTime();
    const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
  } catch {
    return "—";
  }
}

export default function PortfolioPage() {
  const [recomputing, setRecomputing] = useState(false);
  const [recomputingDecisions, setRecomputingDecisions] = useState(false);
  const [selectedPosition, setSelectedPosition] = useState<CanonicalPositionWithMeta | null>(null);
  const [detailPosition, setDetailPosition] = useState<CanonicalPositionWithMeta | null>(null);
  const detailPositionRef = useRef<CanonicalPositionWithMeta | null>(null);
  detailPositionRef.current = detailPosition;

  const fetchPositionsFn = useCallback(async (): Promise<PositionsPollingData> => {
    const [posRes, alertsRes] = await Promise.all([
      fetch("/api/portfolio/positions?canonical=true"),
      fetch("/api/alerts/feed?resolved=false&limit=50&source=all"),
    ]);
    const posData = posRes.ok ? await posRes.json() : { positions: [] };
    const posList = posData.positions ?? [];
    const positionsFetchOk = posRes.ok;
    let alerts: PositionsPollingData["alerts"] = [];
    if (alertsRes.ok) {
      const { alerts: raw } = await alertsRes.json();
      const assetIds = new Set(posList.map((p: CanonicalPositionWithMeta) => p.token?.assetId));
      const marketIds = new Set(
        posList.map((p: CanonicalPositionWithMeta) =>
          p.positionView?.syncedMarketId ?? p.market?.id ?? p.rawMarketRef ?? p.rawMarketId ?? p.id
        )
      );
      const feedItems = raw ?? [];
      const affecting = feedItems.filter(
        (a: { entityRefs?: { assetId?: string | null; marketId?: string | null } }) => {
          const refs = a.entityRefs ?? {};
          const aid = refs.assetId ?? (a as { assetId?: string | null }).assetId;
          const mid = refs.marketId ?? (a as { marketId?: string | null }).marketId;
          return (aid && assetIds.has(aid)) || (mid && marketIds.has(mid));
        }
      );
      // Include all engine alerts (no entityRefs) so we show concentration, near-resolution, etc.
      const engineOnly = feedItems.filter(
        (a: { source?: string; entityRefs?: unknown }) => a.source === "engine"
      );
      const combined = [...new Map([...affecting, ...engineOnly].map((a: { id: string }) => [a.id, a])).values()];
      alerts = combined.map(
        (a: {
          id: string;
          message: string;
          severity: string;
          title?: string;
          source?: "drift" | "engine";
          entityRefs?: { assetId?: string | null; marketId?: string | null };
        }) => ({
          id: a.id,
          message: a.message,
          severity: a.severity,
          title: a.title,
          source: a.source,
          assetId: a.entityRefs?.assetId ?? null,
          marketId: a.entityRefs?.marketId ?? null,
        })
      );
    }
    return {
      positions: posList,
      positionsFetchOk,
      sourceOfTruth: posData.sourceOfTruth,
      asOf: posData.asOf,
      freshnessMs: posData.freshnessMs ?? null,
      alerts,
    };
  }, []);

  const {
    data: pollingData,
    loading,
    refresh: fetchPositions,
    isRefreshing,
  } = useLivePortfolioPolling<PositionsPollingData>(fetchPositionsFn, {
    intervalMs: 10_000,
    refetchOnFocus: true,
    preventOverlap: true,
  });

  const positions = pollingData?.positions ?? [];
  const positionAlerts = pollingData?.alerts ?? [];

  // Keep detail drawer and exit modal in sync with current list: update when position still present, clear when removed (e.g. stale row excluded)
  const detailAssetId = detailPosition?.token?.assetId;
  const selectedAssetId = selectedPosition?.token?.assetId;
  useEffect(() => {
    if (!detailAssetId) return;
    if (positions.length === 0) {
      setDetailPosition(null);
      return;
    }
    const updated = positions.find((p) => p.token?.assetId === detailAssetId);
    if (updated) setDetailPosition(updated);
    else setDetailPosition(null);
  }, [positions, detailAssetId]);
  useEffect(() => {
    if (!selectedAssetId) return;
    const stillInList = positions.some((p) => p.token?.assetId === selectedAssetId);
    if (!stillInList) setSelectedPosition(null);
  }, [positions, selectedAssetId]);

  const runRecompute = async () => {
    setRecomputing(true);
    try {
      const res = await fetch("/api/portfolio/recompute", { method: "POST" });
      const data = await res.json();
      if (data.success) await fetchPositions();
    } finally {
      setRecomputing(false);
    }
  };

  const runRecomputeDecisions = async () => {
    setRecomputingDecisions(true);
    try {
      await fetch("/api/positions/recompute-decisions", { method: "POST" });
      await fetchPositions();
    } finally {
      setRecomputingDecisions(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">
            Portfolio
          </h2>
          <p className="text-muted-foreground text-sm">
            Derived positions from synced fills. Data quality and resolution status shown per position.
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <Link href="/portfolio/timeline" className="text-sm text-primary hover:underline">
              View portfolio timeline →
            </Link>
            {pollingData && (
              <>
                <span className="text-muted-foreground text-xs">·</span>
                <PortfolioFreshnessIndicator
                  sourceOfTruth={pollingData.sourceOfTruth}
                  asOf={pollingData.asOf}
                  freshnessMs={pollingData.freshnessMs}
                  compact
                />
                {isRefreshing && (
                  <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Updating…
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={runRecomputeDecisions}
            disabled={recomputingDecisions}
          >
            {recomputingDecisions ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Recompute decisions
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={runRecompute}
            disabled={recomputing}
          >
            {recomputing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
            Recompute
          </Button>
        </div>
      </div>

      {pollingData && pollingData.positionsFetchOk === false && (
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardContent className="py-3">
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Positions could not be loaded. Retry or check connection.
            </p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => fetchPositions()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {positionAlerts.length > 0 && (
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-400 text-base">
              <AlertTriangle className="h-4 w-4" /> Alerts
            </CardTitle>
            <CardDescription>Sync (drift) and portfolio (engine) alerts. Resolve drift on Ops.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {positionAlerts.slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span className="truncate flex-1" title={a.message}>
                    {a.title ? `${a.title}: ${a.message}` : a.message}
                  </span>
                  <span className={cn(
                    "rounded px-1.5 py-0.5 text-xs shrink-0",
                    a.source === "engine" && "bg-sky-500/20 text-sky-700 dark:text-sky-400",
                    a.source === "drift" && "bg-amber-500/20 text-amber-700 dark:text-amber-400",
                    a.severity === "critical" && "bg-red-500/20",
                    a.severity === "warning" && !a.source && "bg-amber-500/20"
                  )}>
                    {a.source === "engine" ? "Portfolio" : a.source === "drift" ? "Sync" : a.severity}
                  </span>
                </li>
              ))}
            </ul>
            <Link href="/ops" className="text-primary text-sm mt-2 inline-block hover:underline">View all on Ops →</Link>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Positions</CardTitle>
          <CardDescription>
            Current value, cost basis, max payout, and unrealized P&L. Aligned with Polymarket wallet (Value, Traded, To win).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              <div className="h-10 bg-muted/50 rounded animate-pulse" />
              <div className="h-10 bg-muted/50 rounded animate-pulse" />
              <div className="h-10 bg-muted/50 rounded animate-pulse" />
              <div className="h-10 bg-muted/50 rounded animate-pulse" />
              <p className="text-xs text-muted-foreground">Loading positions…</p>
            </div>
          ) : pollingData?.positionsFetchOk === false ? (
            <div className="py-8 text-center">
              <AlertTriangle className="mx-auto h-10 w-10 text-amber-500/80" />
              <p className="mt-2 text-sm font-medium text-foreground">Could not load positions</p>
              <p className="text-sm text-muted-foreground mt-1">The positions API returned an error.</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => fetchPositions()}>
                Retry
              </Button>
            </div>
          ) : positions.length === 0 ? (
            <div className="py-12 text-center">
              <FileQuestion className="mx-auto h-10 w-10 text-muted-foreground/60" />
              <p className="mt-2 text-sm font-medium text-foreground">No positions</p>
              <p className="text-sm text-muted-foreground mt-1">
                Run &quot;Sync user data&quot; on the dashboard, then &quot;Recompute portfolio&quot; to derive positions from fills.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2.5 px-2 font-medium text-muted-foreground">Market</th>
                    <th className="text-left py-2.5 px-2 font-medium text-muted-foreground">Outcome</th>
                    <th className="text-left py-2.5 px-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-right py-2.5 px-2 font-medium text-muted-foreground">Current value</th>
                    <th className="text-right py-2.5 px-2 font-medium text-muted-foreground">Avg entry</th>
                    <th className="text-right py-2.5 px-2 font-medium text-muted-foreground">Mark</th>
                    <th className="text-right py-2.5 px-2 font-medium text-muted-foreground">P&L</th>
                    <th className="text-right py-2.5 px-2 font-medium text-muted-foreground">Resolution</th>
                    <th className="text-left py-2.5 px-2 font-medium text-muted-foreground">Freshness</th>
                    <th className="text-left py-2.5 px-2 font-medium text-muted-foreground w-24">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <PositionRow
                      key={p.id}
                      position={p}
                      onReviewExit={() => setSelectedPosition(p)}
                      onViewDetails={() => setDetailPosition(p)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Temporary debug: compare per-position metrics with Polymarket wallet (Traded / To win / Value / PnL) */}
      {positions.length > 0 && (
        <Card className="border-dashed border-amber-500/50 bg-amber-500/5">
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-medium">Portfolio metric debug (compare with Polymarket wallet)</CardTitle>
            <CardDescription>First 2 positions: shares, avgEntry, currentPrice, costBasis, currentValue, maxPayout, unrealizedPnl</CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Market</th>
                    <th className="text-right py-1.5 px-2 font-medium text-muted-foreground">Shares</th>
                    <th className="text-right py-1.5 px-2 font-medium text-muted-foreground">Avg entry</th>
                    <th className="text-right py-1.5 px-2 font-medium text-muted-foreground">Current price</th>
                    <th className="text-right py-1.5 px-2 font-medium text-muted-foreground">Cost basis (Traded)</th>
                    <th className="text-right py-1.5 px-2 font-medium text-muted-foreground">Current value (Value)</th>
                    <th className="text-right py-1.5 px-2 font-medium text-muted-foreground">Max payout (To win)</th>
                    <th className="text-right py-1.5 px-2 font-medium text-muted-foreground">Unrealized P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.slice(0, 2).map((p) => {
                    const ec = p.economics;
                    const shares = ec.quantity ?? "—";
                    const avgEntry = ec.avgEntry ?? "—";
                    const currentPrice = ec.markPrice ?? "—";
                    const costBasis = ec.costBasis ?? "—";
                    const currentValue = ec.currentValue ?? ec.exposure ?? "—";
                    const maxPayout = ec.maxPayout ?? "—";
                    const unrealizedPnl = ec.unrealizedPnl ?? "—";
                    return (
                      <tr key={p.id} className="border-b border-border/50">
                        <td className="py-1.5 px-2 text-muted-foreground max-w-[120px] truncate" title={p.market?.title}>{p.market?.title ?? "—"}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{shares}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{typeof avgEntry === "string" && avgEntry !== "—" ? `${(parseFloat(avgEntry) * 100).toFixed(1)}¢` : avgEntry}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{typeof currentPrice === "string" && currentPrice !== "—" ? `${(parseFloat(currentPrice) * 100).toFixed(1)}¢` : currentPrice}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{formatUsd(costBasis)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{formatUsd(currentValue)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{formatUsd(maxPayout)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{formatUsd(unrealizedPnl)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {selectedPosition && (
        <ExitReviewModal
          position={selectedPosition}
          onClose={() => setSelectedPosition(null)}
          onPlaced={async () => {
            setSelectedPosition(null);
            await fetchPositions();
          }}
        />
      )}

      <PositionDetailDrawer
        position={detailPosition}
        onClose={() => setDetailPosition(null)}
        onThesisSaved={fetchPositions}
      />
    </div>
  );
}

const THESIS_STATUS_LABELS: Record<string, string> = {
  intact: "Intact",
  weakened: "Weakened",
  invalidated: "Invalidated",
  unknown: "Unknown",
};

function PositionDetailDrawer({
  position,
  onClose,
  onThesisSaved,
}: {
  position: CanonicalPositionWithMeta | null;
  onClose: () => void;
  onThesisSaved?: () => void;
}) {
  const { market, token, economics, timing, quality, thesis } = position ?? ({} as CanonicalPositionWithMeta);
  const hasPosition = !!position;
  const positionView = position ? (position.positionView ?? toPositionViewFromCanonical(position)) : null;
  const display = positionView ? getPositionDisplayState(positionView) : null;
  const insight = computeCanonicalPositionInsight(timing, quality);
  const [thesisEditOpen, setThesisEditOpen] = useState(false);
  const [thesisSaving, setThesisSaving] = useState(false);
  const [entryThesis, setEntryThesis] = useState(thesis?.entryThesis ?? "");
  const [currentThesisStatus, setCurrentThesisStatus] = useState(thesis?.currentThesisStatus ?? "unknown");
  const [exitReason, setExitReason] = useState(thesis?.exitReason ?? "");
  const [notes, setNotes] = useState(thesis?.notes ?? "");

  useEffect(() => {
    if (position?.thesis) {
      setEntryThesis(position.thesis.entryThesis ?? "");
      setCurrentThesisStatus(position.thesis.currentThesisStatus);
      setExitReason(position.thesis.exitReason ?? "");
      setNotes(position.thesis.notes ?? "");
    } else {
      setEntryThesis("");
      setCurrentThesisStatus("unknown");
      setExitReason("");
      setNotes("");
    }
  }, [position?.thesis]);

  const handleSaveThesis = async () => {
    if (!position?.token?.assetId) return;
    setThesisSaving(true);
    try {
      const res = await fetch(`/api/portfolio/positions/${encodeURIComponent(position.token.assetId)}/thesis`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryThesis: entryThesis.trim() || null,
          currentThesisStatus,
          exitReason: exitReason.trim() || null,
          notes: notes.trim() || null,
        }),
      });
      if (res.ok) {
        setThesisEditOpen(false);
        onThesisSaved?.();
      } else {
        const data = await res.json().catch(() => ({}));
        console.error("Thesis save failed:", data.error ?? res.statusText);
      }
    } finally {
      setThesisSaving(false);
    }
  };

  const DetailRow = ({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) => (
    <div className="flex justify-between gap-4 py-1.5 text-sm border-b border-border/50 last:border-0">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={cn("text-right tabular-nums", muted && "text-muted-foreground")}>{value}</span>
    </div>
  );

  return (
    <Sheet open={hasPosition} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        {hasPosition && (
          <>
        <SheetHeader className="pb-4 border-b border-border">
          <SheetTitle className="text-base font-semibold pr-8 truncate" title={display?.displayTitle ?? market?.title}>
            {display?.displayTitle ?? market?.title ?? "—"}
          </SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-5">
          <div>
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Market</h4>
            <div className="space-y-0">
              <DetailRow label="Outcome / side" value={<span className={cn("font-medium", token.side === "YES" && "text-emerald-600 dark:text-emerald-400", token.side === "NO" && "text-sky-600 dark:text-sky-400")}>{token.outcome} / {token.side}</span>} />
              <DetailRow label="Category" value={market.category ?? "—"} muted />
              <DetailRow label="Theme" value={market.theme ?? "—"} muted />
              <DetailRow label="End date" value={market.endDate ? formatRelativeDate(market.endDate) : "—"} muted />
              {display?.canLinkToMarket && display?.href && (
                <div className="pt-1.5">
                  <Link href={display.href} className="text-xs text-primary hover:underline inline-flex items-center gap-1">
                    View market <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              )}
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Economics</h4>
            <div className="space-y-0">
              <DetailRow label="Current value" value={formatUsd(economics.currentValue ?? economics.exposure ?? "0")} />
              <DetailRow label="Cost basis" value={formatUsd(economics.costBasis)} />
              <DetailRow label="Max payout" value={formatUsd(economics.maxPayout ?? "0")} />
              <DetailRow label="Avg entry" value={quality.hasPriceContext ? formatPct(economics.avgEntry) : "—"} muted={!quality.hasPriceContext} />
              <DetailRow label="Current mark" value={quality.hasPriceContext ? formatPct(economics.markPrice) : "—"} muted={!quality.hasPriceContext} />
              <DetailRow label="Unrealized P&L" value={<span className={parseFloat(economics.unrealizedPnl) >= 0 ? "text-emerald-600 dark:text-emerald-500" : "text-red-600 dark:text-red-500"}>{formatUsd(economics.unrealizedPnl)}</span>} />
              <DetailRow label="Realized P&L" value={formatUsd(economics.realizedPnl)} muted />
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Timing</h4>
            <div className="space-y-0">
              <DetailRow label="First fill" value={formatRelativeDate(timing.firstFillAt)} muted />
              <DetailRow label="Last fill" value={formatRelativeDate(timing.lastFillAt)} muted />
              <DetailRow label="Fill count" value="—" muted />
              <DetailRow label="Time to resolution" value={quality.marketEndDatePassed ? "Resolved" : formatTimeToResolution(timing.hoursToResolution)} muted />
              <DetailRow label="Last synced" value={timing.lastSyncedAt ? formatRelativeDate(timing.lastSyncedAt) : "—"} muted />
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Data quality</h4>
            <div className="space-y-0">
              <DetailRow label="Resolution" value={quality.hasCompleteDisplayMetadata ? (position.resolutionSource ?? quality.matchedBy ?? "—") : "Unresolved"} muted={!quality.hasCompleteDisplayMetadata} />
              {!quality.hasCompleteDisplayMetadata && (
                <p className="text-xs text-muted-foreground pt-1.5">Market not yet resolved in catalog.</p>
              )}
              {quality.warnings.length > 0 && (
                <div className="pt-1.5 space-y-1">
                  {quality.warnings.map((w, i) => (
                    <p key={i} className="text-xs text-amber-600 dark:text-amber-400">{w}</p>
                  ))}
                </div>
              )}
              {(insight.nearResolution || insight.staleSync) && (
                <div className="flex flex-wrap gap-1.5 pt-1.5">
                  {insight.nearResolution && <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/15 text-blue-700 dark:text-blue-400">Near resolution</span>}
                  {insight.staleSync && <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">Stale sync</span>}
                </div>
              )}
            </div>
          </div>

          {/* Position thesis v1 */}
          <div>
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Thesis</h4>
            {!thesisEditOpen ? (
              <>
                {thesis ? (
                  <div className="space-y-2 text-sm">
                    {thesis.entryThesis && (
                      <p className="text-foreground"><span className="text-muted-foreground">Entry: </span>{thesis.entryThesis}</p>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Status: </span>
                      <span className={cn(
                        "rounded px-1.5 py-0.5 text-xs font-medium",
                        thesis.currentThesisStatus === "intact" && "bg-green-500/15 text-green-700 dark:text-green-400",
                        thesis.currentThesisStatus === "weakened" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                        thesis.currentThesisStatus === "invalidated" && "bg-red-500/15 text-red-700 dark:text-red-400",
                        thesis.currentThesisStatus === "unknown" && "bg-muted text-muted-foreground"
                      )}>
                        {THESIS_STATUS_LABELS[thesis.currentThesisStatus] ?? thesis.currentThesisStatus}
                      </span>
                    </div>
                    {thesis.exitReason && <p className="text-foreground"><span className="text-muted-foreground">Exit reason: </span>{thesis.exitReason}</p>}
                    {thesis.notes && <p className="text-muted-foreground">{thesis.notes}</p>}
                    <p className="text-xs text-muted-foreground">Updated {position?.thesis?.updatedAt ? formatRelativeDate(position.thesis.updatedAt) : "—"}</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No thesis recorded. Add one to track why you hold this position.</p>
                )}
                <Button variant="outline" size="sm" className="mt-2" onClick={() => setThesisEditOpen(true)}>
                  {thesis ? "Edit thesis" : "Add thesis"}
                </Button>
              </>
            ) : (
              <div className="space-y-3 text-sm">
                <div>
                  <label className="text-muted-foreground block mb-1">Entry thesis</label>
                  <textarea
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[60px]"
                    value={entryThesis}
                    onChange={(e) => setEntryThesis(e.target.value)}
                    placeholder="Why you opened this position…"
                  />
                </div>
                <div>
                  <label className="text-muted-foreground block mb-1">Status</label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={currentThesisStatus}
                    onChange={(e) => setCurrentThesisStatus(e.target.value)}
                  >
                    {(["unknown", "intact", "weakened", "invalidated"] as const).map((s) => (
                      <option key={s} value={s}>{THESIS_STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-muted-foreground block mb-1">Exit reason (if closed or changed)</label>
                  <input
                    type="text"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={exitReason}
                    onChange={(e) => setExitReason(e.target.value)}
                    placeholder="Optional"
                  />
                </div>
                <div>
                  <label className="text-muted-foreground block mb-1">Notes</label>
                  <textarea
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[50px]"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Optional notes…"
                  />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveThesis} disabled={thesisSaving}>
                    {thesisSaving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                    Save
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setThesisEditOpen(false)} disabled={thesisSaving}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function PositionRow({
  position,
  onReviewExit,
  onViewDetails,
}: {
  position: CanonicalPositionWithMeta;
  onReviewExit: () => void;
  onViewDetails: () => void;
}) {
  const { market, token, economics, timing, quality, decision, newsLinkCount = 0 } = position;
  const positionView = position.positionView ?? toPositionViewFromCanonical(position);
  const display = getPositionDisplayState(positionView);

  const marketCell = (
    <td className="py-2.5 px-2 align-top">
      <div className="max-w-[220px]">
        {display.canLinkToMarket && display.href ? (
          <Link href={display.href} className="font-medium text-foreground hover:underline truncate block">
            {display.displayTitle}
          </Link>
        ) : (
          <span className="font-medium text-foreground truncate block" title={display.displayTitle}>{display.displayTitle}</span>
        )}
        <p className="text-xs text-muted-foreground mt-0.5 truncate">
          {display.displaySubtitle}
        </p>
      </div>
    </td>
  );

  return (
    <tr className="border-b border-border/50 hover:bg-muted/30 transition-colors">
      {marketCell}
      <td className="py-2.5 px-2 align-top">
        <span className={cn(
          "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
          token.side === "YES" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
          token.side === "NO" && "bg-sky-500/15 text-sky-700 dark:text-sky-400",
          token.side !== "YES" && token.side !== "NO" && "bg-muted text-muted-foreground"
        )}>
          {token.outcome} / {token.side}
        </span>
      </td>
      <td className="py-2.5 px-2 align-top">
        <div className="flex flex-wrap gap-1">
          {quality.matchedBy === "conditionId" && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground" title="Resolved via conditionId">ID</span>
          )}
          {display.badges.unresolved && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground" title="Market not yet resolved in catalog">Unresolved</span>
          )}
          {!quality.hasPriceContext && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground" title="No mark/entry">No price</span>
          )}
          {display.badges.soon && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/15 text-blue-700 dark:text-blue-400" title="Resolves within 72h">
              <Clock className="inline h-2.5 w-2.5 mr-0.5" /> Soon
            </span>
          )}
          {display.badges.stale && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground" title="Last sync &gt; 24h ago">Stale</span>
          )}
          {newsLinkCount > 0 && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-500/15 text-slate-600 dark:text-slate-400" title="Linked news">News</span>
          )}
          {decision && (
            <span className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-medium",
              decision.decisionState === "HOLD" && "bg-muted text-muted-foreground",
              decision.decisionState === "TRIM" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
              decision.decisionState === "REDUCE" && "bg-orange-500/15 text-orange-700 dark:text-orange-400",
              (decision.decisionState === "EXIT" || decision.decisionState === "THESIS_BROKEN") && "bg-red-500/15 text-red-700 dark:text-red-400",
              decision.decisionState === "TAKE_PROFIT" && "bg-green-500/15 text-green-700 dark:text-green-400"
            )}>
              {decision.decisionState}
            </span>
          )}
        </div>
        {quality.warnings.length > 0 && !quality.hasCompleteDisplayMetadata && (
          <p className="text-[10px] text-muted-foreground mt-1 max-w-[160px]" title={quality.warnings.join(". ")}>
            Catalog link unavailable until market is resolved.
          </p>
        )}
        {quality.warnings.length > 0 && quality.hasCompleteDisplayMetadata && quality.warnings[0] && (
          <p className="text-[10px] text-muted-foreground mt-1 max-w-[160px]" title={quality.warnings.join(". ")}>
            {quality.warnings[0]}
          </p>
        )}
      </td>
      <td className="py-2.5 px-2 text-right tabular-nums align-top font-medium">
        {formatUsd(economics.currentValue ?? economics.exposure ?? "0")}
      </td>
      <td className="py-2.5 px-2 text-right tabular-nums align-top text-muted-foreground">
        {quality.hasPriceContext ? formatPct(economics.avgEntry) : "—"}
      </td>
      <td className="py-2.5 px-2 text-right tabular-nums align-top text-muted-foreground">
        {quality.hasPriceContext ? formatPct(economics.markPrice) : "—"}
      </td>
      <td className={cn(
        "py-2.5 px-2 text-right tabular-nums align-top font-medium",
        parseFloat(economics.unrealizedPnl) >= 0 ? "text-emerald-600 dark:text-emerald-500" : "text-red-600 dark:text-red-500"
      )}>
        {formatUsd(economics.unrealizedPnl)}
      </td>
      <td className="py-2.5 px-2 text-right tabular-nums align-top text-muted-foreground">
        {quality.marketEndDatePassed ? "Resolved" : formatTimeToResolution(timing.hoursToResolution)}
      </td>
      <td className="py-2.5 px-2 text-muted-foreground align-top text-xs">
        {timing.firstFillAt ? formatRelativeDate(timing.firstFillAt) : "—"}
        {timing.lastSyncedAt ? ` · Synced ${formatRelativeDate(timing.lastSyncedAt)}` : null}
      </td>
      <td className="py-2.5 px-2 align-top">
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={onViewDetails}>
            Details
          </Button>
          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={onReviewExit}>
            Review exit
          </Button>
        </div>
      </td>
    </tr>
  );
}

function ExitReviewModal({
  position,
  onClose,
  onPlaced,
}: {
  position: CanonicalPositionWithMeta;
  onClose: () => void;
  onPlaced: () => void;
}) {
  const [exitType, setExitType] = useState("TRIM");
  const [size, setSize] = useState("");
  const [limitPrice, setLimitPrice] = useState(position.economics.markPrice);
  const [preview, setPreview] = useState<{
    valid: boolean;
    validationErrors?: string[];
    estimatedRealizedPnl?: number;
    concentrationPctAfter?: number;
    warnings?: string[];
  } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [placing, setPlacing] = useState(false);

  const positionView = position.positionView ?? toPositionViewFromCanonical(position);
  const marketId = positionView.syncedMarketId ?? positionView.rawMarketRef ?? position.market?.id ?? position.rawMarketRef ?? position.rawMarketId ?? "";
  const assetId = position.token.assetId;

  useEffect(() => {
    setLimitPrice(position.economics.markPrice);
    if (position.decision?.suggestedExitSize) setSize(position.decision.suggestedExitSize);
    else setSize(position.economics.quantity);
  }, [position]);

  const runPreview = async () => {
    setPreview(null);
    setLoadingPreview(true);
    try {
      const res = await fetch("/api/positions/exit-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId,
          marketId,
          exitType,
          size: size || position.economics.quantity,
          limitPrice: limitPrice || position.economics.markPrice,
        }),
      });
      const data = await res.json();
      setPreview(data);
    } finally {
      setLoadingPreview(false);
    }
  };

  const placeExit = async () => {
    if (!preview?.valid) return;
    setPlacing(true);
    try {
      const res = await fetch("/api/positions/place-exit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId,
          marketId,
          exitType,
          size: size || position.economics.quantity,
          limitPrice: limitPrice || position.economics.markPrice,
        }),
      });
      const data = await res.json();
      if (data.success) onPlaced();
    } finally {
      setPlacing(false);
    }
  };

  let reasoning: string[] = [];
  if (position.decision?.reasoningJson) {
    try {
      const parsed = JSON.parse(position.decision.reasoningJson) as string[] | { explanation?: string[] };
      reasoning = Array.isArray(parsed) ? parsed : (parsed.explanation ?? []);
    } catch { /* ignore */ }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <Card className="z-10 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Review exit</CardTitle>
            <CardDescription>{position.market.title} · {position.token.outcome}</CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm">
            <p className="text-muted-foreground">
              Size: {position.economics.quantity} · Avg entry: {position.quality.hasPriceContext ? formatPct(position.economics.avgEntry) : "—"} · Mark: {position.quality.hasPriceContext ? formatPct(position.economics.markPrice) : "—"}
            </p>
            <p className={cn("mt-1", parseFloat(position.economics.unrealizedPnl) >= 0 ? "text-emerald-600 dark:text-emerald-500" : "text-red-600 dark:text-red-500")}>
              Unrealized P&L: {formatUsd(position.economics.unrealizedPnl)}
            </p>
          </div>
          {position.decision && (
            <div>
              <p className="font-medium text-muted-foreground text-sm">Decision: {position.decision.decisionState}</p>
              {reasoning.length > 0 && (
                <ul className="list-disc list-inside text-sm text-muted-foreground mt-1">{reasoning.map((r, i) => <li key={i}>{r}</li>)}</ul>
              )}
            </div>
          )}
          <div className="grid gap-2">
            <label className="text-xs text-muted-foreground">Exit type</label>
            <select className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" value={exitType} onChange={(e) => setExitType(e.target.value)}>
              <option value="TRIM">TRIM</option>
              <option value="REDUCE">REDUCE</option>
              <option value="EXIT">EXIT</option>
              <option value="TAKE_PROFIT">TAKE_PROFIT</option>
              <option value="THESIS_BROKEN">THESIS_BROKEN</option>
            </select>
            <label className="text-xs text-muted-foreground">Size</label>
            <input type="text" className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" value={size} onChange={(e) => setSize(e.target.value)} placeholder={position.economics.quantity} />
            <label className="text-xs text-muted-foreground">Limit price</label>
            <input type="text" className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} placeholder="0.50" />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={runPreview} disabled={loadingPreview}>
              {loadingPreview ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Preview exit
            </Button>
            {preview?.valid && (
              <Button size="sm" onClick={placeExit} disabled={placing}>
                {placing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                Place exit order
              </Button>
            )}
          </div>
          {preview && (
            <div className="rounded-md border border-border p-3 text-sm">
              {preview.valid ? (
                <>
                  {preview.estimatedRealizedPnl != null && <p>Est. realized P&L: {formatUsd(String(preview.estimatedRealizedPnl))}</p>}
                  {preview.concentrationPctAfter != null && <p>Concentration after: {preview.concentrationPctAfter.toFixed(1)}%</p>}
                  {preview.warnings && preview.warnings.length > 0 && <ul className="list-disc list-inside text-amber-600 dark:text-amber-400 mt-1">{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                </>
              ) : (
                <p className="text-red-600 dark:text-red-400">{preview.validationErrors?.join("; ") ?? "Invalid"}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
