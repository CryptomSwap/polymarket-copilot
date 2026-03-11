"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { TradePreviewCard } from "@/components/orders/trade-preview-card";

const REVIEW_STATUSES = ["NEW", "REVIEWED", "APPROVED", "REJECTED", "ARCHIVED"] as const;

function PostTradeJournalSection({
  recommendationId,
  marketId,
  assetId,
  orderIntentId,
  executedOrderId,
  entries,
  onSaved,
}: {
  recommendationId: string;
  marketId: string;
  assetId: string;
  orderIntentId?: string;
  executedOrderId?: string;
  entries: Array<{ id: string; note: string; tag: string; executedOrderId: string | null; createdAt: string }>;
  onSaved: () => void;
}) {
  const [note, setNote] = useState("");
  const [tag, setTag] = useState("manual");
  const [saving, setSaving] = useState(false);
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/journal/post-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recommendationId,
          orderIntentId: orderIntentId ?? undefined,
          executedOrderId: executedOrderId ?? undefined,
          marketId,
          assetId,
          note: note.trim(),
          tag,
        }),
      });
      if (res.ok) {
        setNote("");
        onSaved();
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Post-trade journal</CardTitle>
        <CardDescription>Add a note after placing/filling an order. Tags: manual, thesis, catalyst, warning, news.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit} className="space-y-2">
          <textarea
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px]"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What happened? Outcome, lesson, catalyst…"
          />
          <div className="flex items-center gap-2">
            <select
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            >
              <option value="manual">manual</option>
              <option value="thesis">thesis</option>
              <option value="catalyst">catalyst</option>
              <option value="warning">warning</option>
              <option value="news">news</option>
            </select>
            <Button type="submit" size="sm" disabled={saving || !note.trim()}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Add note
            </Button>
          </div>
        </form>
        {entries.length > 0 && (
          <div className="border-t border-border pt-3 space-y-1 text-sm">
            <p className="font-medium text-muted-foreground">Recent notes</p>
            {entries.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{e.tag}</span>
                <span>{e.note.slice(0, 80)}{e.note.length > 80 ? "…" : ""}</span>
                <span className="text-xs">{new Date(e.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const PRIMARY_ACTION_LABELS: Record<string, string> = {
  add: "Add",
  review_existing: "Review existing",
  trim: "Trim",
  hedge: "Hedge",
  avoid: "Avoid",
  monitor: "Monitor",
  sync_first: "Sync first",
};

const LEGACY_ACTION_LABELS: Record<string, string> = {
  STRONG_BUY: "Strong buy",
  BUY_SMALL: "Buy small",
  WATCH: "Watch",
  NO_TRADE: "No trade",
  TRIM: "Trim",
  EXIT: "Exit",
};

/** One-line "why" for primary action (for diagnostics panel). */
function whyActionSummary(
  primaryActionType: string | null,
  rationale: string | null,
  blockedReason: string | null,
  qualityBlocker: string | null
): string {
  if (qualityBlocker) return qualityBlocker;
  if (rationale) return rationale;
  if (blockedReason) return blockedReason;
  switch (primaryActionType) {
    case "add":
      return "Edge and confidence support adding; portfolio allows.";
    case "avoid":
      return "Overlap, timing, or quality block adding.";
    case "hedge":
    case "trim":
      return "You hold this market; signal suggests reducing exposure.";
    case "review_existing":
      return "You hold this market; edge insufficient to add. Review or hold.";
    case "monitor":
      return "Watch for better entry or confirmation.";
    case "sync_first":
      return "Resolve portfolio data before adding exposure.";
    default:
      return "See rationale and portfolio context below.";
  }
}

interface RecommendationDetail {
  recommendation: {
    id: string;
    action: string;
    primaryActionType: string | null;
    rationale: string | null;
    portfolioImpact: string | null;
    riskNote: string | null;
    timingNote: string | null;
    qualityBlocker: string | null;
    suggestedEntryMin: string | null;
    suggestedEntryMax: string | null;
    suggestedSize: string;
    blockedReason: string | null;
    priorityScore: string;
    createdAt: string;
    updatedAt: string;
  };
  review: { status: string; reviewerNote: string | null; createdAt: string | null; updatedAt: string | null };
  signal: {
    marketId: string;
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
    momentumComponent: string | null;
    liquidityComponent: string | null;
    crowdingComponent: string | null;
    portfolioComponent: string | null;
    behaviorComponent: string | null;
    longshotComponent: string | null;
    timeComponent: string | null;
    category: string | null;
    theme: string | null;
  };
  market: { id: string; slug: string | null; title: string; status: string; category: string | null } | null;
  evaluations: Array<{ id: string; evaluatedAt: string; marketPriceAtEval: string; priceChange1h: string | null; priceChange6h: string | null; priceChange24h: string | null; wasPositive: boolean | null }>;
  relatedPosition: { assetId: string; size: string; avgEntry: string; marketValue: string; unrealizedPnl: string } | null;
  assetId: string | null;
  decision?: {
    policyState: string;
    blendedScore: string;
    sizeMultiplier: string;
    finalSuggestedSize: string;
    reasoningJson: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  lifecycleEvents?: Array<{ id: string; eventType: string; metadata: unknown; createdAt: string }>;
  executionOutcomes?: Array<{
    id: string;
    orderIntentId: string | null;
    executedOrderId: string | null;
    actedOn: boolean;
    overridden: boolean;
    matchedSuggestedSide: boolean | null;
    matchedSuggestedSize: boolean | null;
    matchedSuggestedPrice: boolean | null;
    suggestedSize: string | null;
    actualSize: string | null;
    suggestedPrice: string | null;
    actualPrice: string | null;
    slippage: string | null;
    fillStatus: string | null;
    forwardReturn1h: string | null;
    forwardReturn6h: string | null;
    forwardReturn24h: string | null;
    pnlIfActed: string | null;
    pnlIfIgnored: string | null;
    createdAt: string;
  }>;
  latestPreflight?: {
    id: string;
    passed: boolean;
    marketActiveOk: boolean | null;
    tickSizeOk: boolean | null;
    warningsJson: string | null;
    createdAt: string;
  } | null;
  reconciliationSnapshots?: Array<{
    polymarketOrderId: string;
    localStatus: string;
    remoteStatus: string | null;
    filledSize: string | null;
    remainingSize: string | null;
    avgFillPrice: string | null;
    mismatch: boolean;
    updatedAt: string;
  }>;
  postTradeJournalEntries?: Array<{ id: string; note: string; tag: string; executedOrderId: string | null; createdAt: string }>;
  recommendationDiagnostics?: {
    isHeld: boolean;
    categoryExposurePct: number;
    themeExposurePct: number;
    timeToResolutionDays: number | null;
    nearResolutionCount: number;
    staleCount: number;
    unresolvedCount: number;
  };
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

export default function RecommendationDetailPage() {
  const params = useParams();
  const id = typeof params.id === "string" ? params.id : "";
  const [data, setData] = useState<RecommendationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewStatus, setReviewStatus] = useState<string>("");
  const [reviewerNote, setReviewerNote] = useState("");
  const [savingReview, setSavingReview] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const fetchDetail = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/recommendations/${id}`);
      if (res.ok) {
        const json = await res.json();
        setData(json);
        setReviewStatus(json.review?.status ?? "NEW");
        setReviewerNote(json.review?.reviewerNote ?? "");
      } else setData(null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const setReview = async (status: string, note?: string) => {
    setSavingReview(true);
    try {
      const res = await fetch("/api/recommendations/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recommendationId: id, status, reviewerNote: note ?? reviewerNote }),
      });
      if (res.ok) fetchDetail();
    } finally {
      setSavingReview(false);
    }
  };

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <Link href="/recommendations" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" /> Back to recommendations
        </Link>
        <p className="text-muted-foreground">{loading ? "Loading…" : "Recommendation not found."}</p>
      </div>
    );
  }

  const { recommendation, review, signal, market, evaluations, relatedPosition, assetId, decision, lifecycleEvents = [], executionOutcomes = [], latestPreflight, reconciliationSnapshots = [], postTradeJournalEntries = [], recommendationDiagnostics } = data;
  const side = (signal.side?.toUpperCase() === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
  const hasOrderPlaced = executionOutcomes.some((o) => o.actedOn);
  const latestOutcome = executionOutcomes[0];
  interface ReasoningShape {
    blockers?: string[];
    supportive?: string[];
    policyState?: string;
    sizeMultiplier?: number;
    blendedRaw?: number;
    blendedClamped?: number;
  }
  let reasoning: ReasoningShape | null = null;
  if (decision?.reasoningJson) {
    try {
      reasoning = JSON.parse(decision.reasoningJson) as ReasoningShape;
    } catch { /* ignore */ }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/recommendations" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" /> Back to recommendations
        </Link>
      </div>

      <div>
        {recommendation.primaryActionType && (
          <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">
            {PRIMARY_ACTION_LABELS[recommendation.primaryActionType] ?? recommendation.primaryActionType}
          </p>
        )}
        <h2 className="text-2xl font-bold tracking-tight text-foreground">{signal.marketTitle}</h2>
        <p className="text-muted-foreground text-sm mt-1">{signal.outcome} / {signal.side} · {signal.signalType}</p>
      </div>

      <TradePreviewCard
        marketId={signal.marketId}
        marketTitle={signal.marketTitle}
        outcome={signal.outcome}
        side={side}
        initialPrice={signal.marketPrice}
        initialSize={recommendation.suggestedSize}
        recommendationId={recommendation.id}
        assetId={assetId}
        thesis={signal.thesis}
        invalidation={signal.invalidation}
        reviewStatus={review.status}
        blockedReason={recommendation.blockedReason}
      />

      {latestPreflight && (
        <Card>
          <CardHeader>
            <CardTitle>Preflight status</CardTitle>
            <CardDescription>Latest preflight check before placement. Run from trade preview or place flow.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <span className={latestPreflight.passed ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}>
                {latestPreflight.passed ? "Passed" : "Failed"}
              </span>
              <span className="text-xs text-muted-foreground">{new Date(latestPreflight.createdAt).toLocaleString()}</span>
            </div>
            {latestPreflight.warningsJson && (() => {
              try {
                const w = JSON.parse(latestPreflight.warningsJson) as string[];
                if (Array.isArray(w) && w.length > 0) {
                  return <ul className="list-disc list-inside text-sm text-muted-foreground">{w.map((x, i) => <li key={i}>{x}</li>)}</ul>;
                }
              } catch { /* ignore */ }
              return null;
            })()}
          </CardContent>
        </Card>
      )}

      {decision && (
        <Card>
          <CardHeader>
            <CardTitle>Decision</CardTitle>
            <CardDescription>Blended policy state, score, size guidance. Advisory only; risk blocks remain authoritative.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded px-2 py-1 text-sm font-medium",
                  decision.policyState === "BLOCK" && "bg-red-500/20 text-red-700 dark:text-red-400",
                  decision.policyState === "REVIEW_REQUIRED" && "bg-amber-500/20 text-amber-700 dark:text-amber-400",
                  (decision.policyState === "ALLOW_SMALL" || decision.policyState === "ALLOW_NORMAL") && "bg-green-500/20 text-green-700 dark:text-green-400",
                  decision.policyState === "ALLOW_HIGH_CONVICTION" && "bg-green-600/30 text-green-800 dark:text-green-300",
                  (decision.policyState === "TRIM" || decision.policyState === "EXIT") && "bg-orange-500/20 text-orange-700 dark:text-orange-400"
                )}
              >
                {decision.policyState}
              </span>
              <span className="text-sm text-muted-foreground">Blended: {formatPct(decision.blendedScore)}</span>
              <span className="text-sm text-muted-foreground">Size ×{decision.sizeMultiplier} → {formatPct(decision.finalSuggestedSize)}</span>
            </div>
            <div className="text-sm">
              <p className="font-medium text-muted-foreground">Final suggested size: {formatPct(decision.finalSuggestedSize)}</p>
            </div>
            {reasoning != null && (
              <div className="border-t border-border pt-3 space-y-2 text-sm">
                {Array.isArray(reasoning.blockers) && reasoning.blockers.length > 0 && (
                  <div>
                    <p className="font-medium text-red-600 dark:text-red-400">Blockers</p>
                    <ul className="list-disc list-inside text-muted-foreground">{reasoning.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
                  </div>
                )}
                {Array.isArray(reasoning.supportive) && reasoning.supportive.length > 0 && (
                  <div>
                    <p className="font-medium text-green-600 dark:text-green-400">Supportive</p>
                    <ul className="list-disc list-inside text-muted-foreground">{reasoning.supportive.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {(recommendation.rationale ?? recommendation.portfolioImpact ?? recommendation.riskNote ?? recommendation.timingNote ?? recommendation.qualityBlocker) && (
        <Card>
          <CardHeader>
            <CardTitle>Portfolio context</CardTitle>
            <CardDescription>Why this action; impact, risk, timing, and data-quality notes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {recommendation.rationale && (
              <div>
                <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide mb-0.5">Rationale</p>
                <p className="text-foreground">{recommendation.rationale}</p>
              </div>
            )}
            {recommendation.portfolioImpact && (
              <div>
                <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide mb-0.5">Portfolio impact</p>
                <p className="text-foreground">{recommendation.portfolioImpact}</p>
              </div>
            )}
            {recommendation.riskNote && (
              <div>
                <p className="font-medium text-amber-600 dark:text-amber-400 text-xs uppercase tracking-wide mb-0.5">Risk</p>
                <p className="text-foreground">{recommendation.riskNote}</p>
              </div>
            )}
            {recommendation.timingNote && (
              <div>
                <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide mb-0.5">Timing</p>
                <p className="text-foreground">{recommendation.timingNote}</p>
              </div>
            )}
            {recommendation.qualityBlocker && (
              <div>
                <p className="font-medium text-amber-600 dark:text-amber-400 text-xs uppercase tracking-wide mb-0.5">Data / quality</p>
                <p className="text-foreground">{recommendation.qualityBlocker}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recommendation</CardTitle>
          <CardDescription>Action, sizing, block reason. Read-only; manual execution from trade preview below.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {recommendation.primaryActionType && (
              <span
                className={cn(
                  "rounded px-2 py-1 text-sm font-semibold",
                  recommendation.primaryActionType === "add" && "bg-emerald-600/20 text-emerald-800 dark:text-emerald-300",
                  recommendation.primaryActionType === "review_existing" && "bg-blue-500/20 text-blue-700 dark:text-blue-400",
                  (recommendation.primaryActionType === "trim" || recommendation.primaryActionType === "hedge") && "bg-orange-500/20 text-orange-700 dark:text-orange-400",
                  (recommendation.primaryActionType === "avoid" || recommendation.primaryActionType === "monitor") && "bg-muted text-muted-foreground",
                  recommendation.primaryActionType === "sync_first" && "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                )}
              >
                {PRIMARY_ACTION_LABELS[recommendation.primaryActionType] ?? recommendation.primaryActionType}
              </span>
            )}
            <span className={cn("rounded px-2 py-1 text-sm font-medium", recommendation.action === "STRONG_BUY" || recommendation.action === "BUY_SMALL" ? "bg-green-500/20" : recommendation.action === "NO_TRADE" ? "bg-amber-500/20" : "bg-muted")}>
              {recommendation.action}
            </span>
            <span>Size {formatPct(recommendation.suggestedSize)}</span>
            {recommendation.suggestedEntryMin != null && (
              <span>Entry {formatPrice(recommendation.suggestedEntryMin)} – {formatPrice(recommendation.suggestedEntryMax!)}</span>
            )}
          </div>
          {recommendation.blockedReason && (
            <p className="text-sm text-amber-600 dark:text-amber-500">{recommendation.blockedReason}</p>
          )}
        </CardContent>
      </Card>

      {/* Recommendation Diagnostics v1: compact, collapsible panel for why add vs avoid vs hedge vs review_existing */}
      <Card>
        <CardHeader className="py-3">
          <button
            type="button"
            onClick={() => setDiagnosticsOpen((o) => !o)}
            className="flex w-full items-center gap-2 text-left font-medium text-sm text-muted-foreground hover:text-foreground"
            aria-expanded={diagnosticsOpen}
          >
            {diagnosticsOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <span>Recommendation diagnostics</span>
          </button>
          <CardDescription>
            Why this is add vs avoid vs hedge vs review_existing. Portfolio context and explanation fields.
          </CardDescription>
        </CardHeader>
        {diagnosticsOpen && (
          <CardContent className="pt-0 space-y-4">
            {/* Why this action — one line */}
            <div className="rounded-lg bg-muted/50 border border-border px-3 py-2 text-sm">
              <p className="font-medium text-foreground mb-0.5">
                {PRIMARY_ACTION_LABELS[recommendation.primaryActionType ?? ""] ?? recommendation.primaryActionType ?? "—"}
              </p>
              <p className="text-muted-foreground">
                {whyActionSummary(
                  recommendation.primaryActionType,
                  recommendation.rationale,
                  recommendation.blockedReason,
                  recommendation.qualityBlocker
                )}
              </p>
            </div>

            {/* Decision */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Decision</h4>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Primary action</dt>
                <dd className="font-medium">{PRIMARY_ACTION_LABELS[recommendation.primaryActionType ?? ""] ?? recommendation.primaryActionType ?? "—"}</dd>
                <dt className="text-muted-foreground">Legacy action</dt>
                <dd>{LEGACY_ACTION_LABELS[recommendation.action] ?? recommendation.action}</dd>
                <dt className="text-muted-foreground">Priority score</dt>
                <dd className="tabular-nums">{formatPct(recommendation.priorityScore)}</dd>
              </dl>
            </div>

            {/* Portfolio context */}
            {recommendationDiagnostics != null ? (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Portfolio context</h4>
                <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">Held</dt>
                  <dd>{recommendationDiagnostics.isHeld ? "Yes — you have a position" : "No"}</dd>
                  <dt className="text-muted-foreground">Theme overlap</dt>
                  <dd className="tabular-nums">{signal.theme ?? "—"} · {recommendationDiagnostics.themeExposurePct.toFixed(1)}%</dd>
                  <dt className="text-muted-foreground">Category overlap</dt>
                  <dd className="tabular-nums">{signal.category ?? "—"} · {recommendationDiagnostics.categoryExposurePct.toFixed(1)}%</dd>
                  <dt className="text-muted-foreground">Time to resolution</dt>
                  <dd>{recommendationDiagnostics.timeToResolutionDays != null ? `${recommendationDiagnostics.timeToResolutionDays} days` : "—"}</dd>
                  {(recommendationDiagnostics.nearResolutionCount > 0 || recommendationDiagnostics.staleCount > 0 || recommendationDiagnostics.unresolvedCount > 0) && (
                    <>
                      <dt className="text-muted-foreground">Near-resolution</dt>
                      <dd>{recommendationDiagnostics.nearResolutionCount} position(s)</dd>
                      <dt className="text-muted-foreground">Stale / unresolved</dt>
                      <dd>{recommendationDiagnostics.staleCount} stale · {recommendationDiagnostics.unresolvedCount} unresolved</dd>
                    </>
                  )}
                </dl>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Portfolio context not available. Run portfolio sync and recompute.</p>
            )}

            {/* Explanation fields — only when present */}
            {(recommendation.rationale || recommendation.portfolioImpact || recommendation.riskNote || recommendation.timingNote || recommendation.qualityBlocker) && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Explanation</h4>
                <ul className="space-y-2 text-sm">
                  {recommendation.rationale && (
                    <li>
                      <span className="text-muted-foreground">Rationale: </span>
                      <span className="text-foreground">{recommendation.rationale}</span>
                    </li>
                  )}
                  {recommendation.portfolioImpact && (
                    <li>
                      <span className="text-muted-foreground">Portfolio impact: </span>
                      <span className="text-foreground">{recommendation.portfolioImpact}</span>
                    </li>
                  )}
                  {recommendation.riskNote && (
                    <li>
                      <span className="text-muted-foreground">Risk: </span>
                      <span className="text-foreground">{recommendation.riskNote}</span>
                    </li>
                  )}
                  {recommendation.timingNote && (
                    <li>
                      <span className="text-muted-foreground">Timing: </span>
                      <span className="text-foreground">{recommendation.timingNote}</span>
                    </li>
                  )}
                  {recommendation.qualityBlocker && (
                    <li>
                      <span className="text-muted-foreground">Blocker: </span>
                      <span className="text-amber-700 dark:text-amber-400">{recommendation.qualityBlocker}</span>
                    </li>
                  )}
                </ul>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {lifecycleEvents.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Lifecycle history</CardTitle>
            <CardDescription>Events: shown, reviewed, approved/rejected, previewed, intent, placed, cancelled, filled, skipped</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
              {lifecycleEvents.slice(0, 20).map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-muted-foreground">
                  <span className="font-medium text-foreground">{e.eventType}</span>
                  <span>{new Date(e.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {executionOutcomes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Execution outcome</CardTitle>
            <CardDescription>{hasOrderPlaced ? "An order was placed from this recommendation." : "No order placed from this recommendation."}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {latestOutcome && (
              <>
                <p>Acted on: {latestOutcome.actedOn ? "Yes" : "No"} · Overridden: {latestOutcome.overridden ? "Yes" : "No"}</p>
                <p>Matched side: {latestOutcome.matchedSuggestedSide == null ? "—" : latestOutcome.matchedSuggestedSide ? "Yes" : "No"} · Matched size: {latestOutcome.matchedSuggestedSize == null ? "—" : latestOutcome.matchedSuggestedSize ? "Yes" : "No"} · Matched price: {latestOutcome.matchedSuggestedPrice == null ? "—" : latestOutcome.matchedSuggestedPrice ? "Yes" : "No"}</p>
                {latestOutcome.suggestedSize != null && <p>Suggested size: {latestOutcome.suggestedSize} · Actual: {latestOutcome.actualSize ?? "—"}</p>}
                {latestOutcome.slippage != null && <p>Slippage: {formatPct(latestOutcome.slippage)}</p>}
                {latestOutcome.forwardReturn24h != null && <p>Forward return 24h: {formatPct(latestOutcome.forwardReturn24h)}</p>}
                {latestOutcome.fillStatus != null && <p>Fill status: {latestOutcome.fillStatus}</p>}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {reconciliationSnapshots.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Reconciliation</CardTitle>
            <CardDescription>Local vs remote order state. Run Reconcile on Orders page to refresh.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto text-sm">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-2 font-medium">Order ID</th>
                    <th className="text-left py-2 px-2 font-medium">Local / Remote</th>
                    <th className="text-right py-2 px-2 font-medium">Filled</th>
                    <th className="text-right py-2 px-2 font-medium">Remaining</th>
                    <th className="text-right py-2 px-2 font-medium">Avg fill</th>
                    <th className="text-left py-2 px-2 font-medium">Mismatch</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliationSnapshots.map((s) => (
                    <tr key={s.polymarketOrderId} className="border-b border-border/50">
                      <td className="py-2 px-2 font-mono text-xs">{s.polymarketOrderId.slice(0, 12)}…</td>
                      <td className="py-2 px-2">{s.localStatus} / {s.remoteStatus ?? "—"}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{s.filledSize ?? "—"}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{s.remainingSize ?? "—"}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{s.avgFillPrice ?? "—"}</td>
                      <td className="py-2 px-2">{s.mismatch ? <span className="rounded bg-amber-500/20 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 text-xs">Mismatch</span> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {(hasOrderPlaced || postTradeJournalEntries.length > 0) && (
        <PostTradeJournalSection
          recommendationId={recommendation.id}
          marketId={signal.marketId}
          assetId={assetId ?? ""}
          orderIntentId={latestOutcome?.orderIntentId ?? undefined}
          executedOrderId={latestOutcome?.executedOrderId ?? undefined}
          entries={postTradeJournalEntries}
          onSaved={fetchDetail}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Review</CardTitle>
          <CardDescription>Status and reviewer note. Default NEW if no review yet.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded px-2 py-1 text-sm font-medium", reviewStatus === "APPROVED" ? "bg-green-500/20" : reviewStatus === "REJECTED" ? "bg-red-500/20" : reviewStatus === "REVIEWED" ? "bg-blue-500/20" : "bg-muted")}>
              {reviewStatus}
            </span>
            <span className="text-xs text-muted-foreground">Quick:</span>
            {REVIEW_STATUSES.map((s) => (
              <Button key={s} variant="outline" size="sm" disabled={savingReview} onClick={() => setReview(s)}>
                {savingReview ? <Loader2 className="h-3 w-3 animate-spin" /> : s}
              </Button>
            ))}
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Reviewer note</label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px]"
              value={reviewerNote}
              onChange={(e) => setReviewerNote(e.target.value)}
              placeholder="Optional note…"
            />
            <Button size="sm" className="mt-2" disabled={savingReview} onClick={() => setReview(reviewStatus)}>
              {savingReview ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Save note
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Signal &amp; components</CardTitle>
          <CardDescription>Full component breakdown</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Price {formatPrice(signal.marketPrice)} → Fair {formatPrice(signal.fairPrice)} · Edge {formatPct(signal.edge)} · Confidence {formatPct(signal.confidence)}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
            <dt>Momentum</dt><dd>{signal.momentumComponent ?? "—"}</dd>
            <dt>Liquidity</dt><dd>{signal.liquidityComponent ?? "—"}</dd>
            <dt>Crowding</dt><dd>{signal.crowdingComponent ?? "—"}</dd>
            <dt>Portfolio</dt><dd>{signal.portfolioComponent ?? "—"}</dd>
            <dt>Behavior</dt><dd>{signal.behaviorComponent ?? "—"}</dd>
            <dt>Longshot</dt><dd>{signal.longshotComponent ?? "—"}</dd>
            <dt>Time</dt><dd>{signal.timeComponent ?? "—"}</dd>
          </dl>
          {signal.thesis && <p className="pt-2">{signal.thesis}</p>}
          {signal.invalidation && <p className="text-amber-600 dark:text-amber-500">Invalidation: {signal.invalidation}</p>}
        </CardContent>
      </Card>

      {market && (
        <Card>
          <CardHeader>
            <CardTitle>Market</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{market.title}</p>
            <p className="text-xs text-muted-foreground">{market.category} · {market.status}</p>
            {market.slug && (
              <Link href={`/markets/${encodeURIComponent(market.slug)}`}>
                <Button variant="outline" size="sm" className="mt-2">View market</Button>
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      {relatedPosition && (
        <Card>
          <CardHeader>
            <CardTitle>Related exposure</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p>Size {relatedPosition.size} · Avg entry {relatedPosition.avgEntry} · Value {relatedPosition.marketValue} · Unrealized PnL {relatedPosition.unrealizedPnl}</p>
          </CardContent>
        </Card>
      )}

      {evaluations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Evaluation history</CardTitle>
            <CardDescription>Price at eval and forward returns when available</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-1 px-2">Eval at</th>
                    <th className="text-right py-1 px-2">Price</th>
                    <th className="text-right py-1 px-2">1h</th>
                    <th className="text-right py-1 px-2">6h</th>
                    <th className="text-right py-1 px-2">24h</th>
                    <th className="text-left py-1 px-2">Positive</th>
                  </tr>
                </thead>
                <tbody>
                  {evaluations.map((e) => (
                    <tr key={e.id} className="border-b border-border/50">
                      <td className="py-1 px-2">{new Date(e.evaluatedAt).toLocaleString()}</td>
                      <td className="py-1 px-2 text-right tabular-nums">{formatPrice(e.marketPriceAtEval)}</td>
                      <td className="py-1 px-2 text-right tabular-nums">{e.priceChange1h != null ? formatPct(e.priceChange1h) : "—"}</td>
                      <td className="py-1 px-2 text-right tabular-nums">{e.priceChange6h != null ? formatPct(e.priceChange6h) : "—"}</td>
                      <td className="py-1 px-2 text-right tabular-nums">{e.priceChange24h != null ? formatPct(e.priceChange24h) : "—"}</td>
                      <td className="py-1 px-2">{e.wasPositive == null ? "—" : e.wasPositive ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}