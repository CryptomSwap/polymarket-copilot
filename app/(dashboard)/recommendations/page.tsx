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
import { RefreshCw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

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
  momentumComponent?: string | null;
  liquidityComponent?: string | null;
  crowdingComponent?: string | null;
  portfolioComponent?: string | null;
  behaviorComponent?: string | null;
  longshotComponent?: string | null;
  timeComponent?: string | null;
  eventImpactBoost?: string | null;
  narrativeMomentumBoost?: string | null;
  catalystConfidence?: string | null;
}

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  MOMENTUM_CONTINUATION: "Momentum",
  MISPRICED_BREAKOUT: "Mispriced / Breakout",
  CHEAP_LONGSHOT: "Cheap longshot",
  OVERCROWDED_THEME: "Overcrowded theme",
  LATE_CHASE: "Late chase",
  WATCHLIST: "Watchlist",
  EXIT_CANDIDATE: "Exit candidate",
  TRIM_CANDIDATE: "Trim candidate",
};

interface DecisionSnapshot {
  policyState: string;
  blendedScore: string;
  sizeMultiplier: string;
  finalSuggestedSize: string;
  reasoningJson: string | null;
}

interface RecommendationItem {
  id: string;
  action: string;
  primaryActionType: string | null;
  rationale: string | null;
  portfolioImpact: string | null;
  riskNote: string | null;
  timingNote: string | null;
  qualityBlocker: string | null;
  reviewStatus: string;
  reviewerNote: string | null;
  suggestedEntryMin: string | null;
  suggestedEntryMax: string | null;
  suggestedSize: string;
  blockedReason: string | null;
  priorityScore: string;
  mlScore: string | null;
  mlModelRunId: string | null;
  mlModelRunStatus: string | null;
  signal: Signal & { marketId?: string };
  linkedNewsCount?: number;
  linkedNewsCount24h?: number;
  saturation?: number;
  decision: DecisionSnapshot | null;
}

const ACTIONS = ["STRONG_BUY", "BUY_SMALL", "WATCH", "NO_TRADE", "TRIM", "EXIT"];

const PRIMARY_ACTION_LABELS: Record<string, string> = {
  add: "Add",
  review_existing: "Review existing",
  trim: "Trim",
  hedge: "Hedge",
  avoid: "Avoid",
  monitor: "Monitor",
  sync_first: "Sync first",
};

const PRIMARY_ACTION_GROUPS: Record<string, string> = {
  add: "Add / Diversify",
  review_existing: "Review existing",
  trim: "Trim / Hedge",
  hedge: "Trim / Hedge",
  avoid: "Monitor / Avoid",
  monitor: "Monitor / Avoid",
  sync_first: "Sync first",
};

const SORT_OPTIONS = [
  { value: "priorityScore", label: "Priority" },
  { value: "edge", label: "Edge" },
  { value: "confidence", label: "Confidence" },
];

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

const SUMMARY_ACTION_ORDER: (keyof typeof PRIMARY_ACTION_LABELS)[] = [
  "add",
  "review_existing",
  "trim",
  "hedge",
  "avoid",
  "monitor",
  "sync_first",
];

export default function RecommendationsPage() {
  const [items, setItems] = useState<RecommendationItem[]>([]);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [actionFilter, setActionFilter] = useState<string>("");
  const [primaryActionFilter, setPrimaryActionFilter] = useState<string>("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [themeFilter, setThemeFilter] = useState<string>("");
  const [sort, setSort] = useState<string>("priorityScore");
  const [captureSnapshots, setCaptureSnapshots] = useState(false);
  const [updatingReviewId, setUpdatingReviewId] = useState<string | null>(null);
  const [recomputingDecisions, setRecomputingDecisions] = useState(false);

  const setReview = async (recId: string, status: string) => {
    setUpdatingReviewId(recId);
    try {
      await fetch("/api/recommendations/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recommendationId: recId, status }),
      });
      await fetchList();
    } finally {
      setUpdatingReviewId(null);
    }
  };

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, summaryRes] = await Promise.all([
        (() => {
          const params = new URLSearchParams();
          if (actionFilter) params.set("action", actionFilter);
          if (primaryActionFilter) params.set("primaryActionType", primaryActionFilter);
          if (categoryFilter) params.set("category", categoryFilter);
          if (themeFilter) params.set("theme", themeFilter);
          params.set("sort", sort);
          params.set("includeNews", "1");
          return fetch(`/api/recommendations/list?${params}`);
        })(),
        fetch("/api/recommendations/summary"),
      ]);
      if (listRes.ok) {
        const data = await listRes.json();
        setItems(data.recommendations ?? []);
      } else setItems([]);
      if (summaryRes.ok) {
        const data = await summaryRes.json();
        setSummary(data.byPrimaryAction ?? null);
      } else setSummary(null);
    } catch {
      setItems([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [actionFilter, primaryActionFilter, categoryFilter, themeFilter, sort]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const runRecompute = async () => {
    setRecomputing(true);
    try {
      const res = await fetch("/api/recommendations/recompute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captureSnapshotsFirst: captureSnapshots }),
      });
      const data = await res.json();
      if (data.success) await fetchList();
    } finally {
      setRecomputing(false);
    }
  };

  const categories = Array.from(new Set(items.map((r) => r.signal.category).filter(Boolean))) as string[];
  const themes = Array.from(new Set(items.map((r) => r.signal.theme).filter(Boolean))) as string[];

  const summaryEntries = summary
    ? SUMMARY_ACTION_ORDER.filter((key) => (summary[key] ?? 0) > 0).map((key) => ({
        key,
        label: PRIMARY_ACTION_LABELS[key],
        count: summary[key] ?? 0,
      }))
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">
            Recommendations
          </h2>
          <p className="text-muted-foreground">
            Scored markets and suggested actions. Manual order placement from recommendation detail.
          </p>
          {summaryEntries.length > 0 && (
            <p className="text-sm text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
              {summaryEntries.map(({ key, label, count }, i) => (
                <span key={key}>
                  {i > 0 && <span className="text-muted-foreground/60 mr-1.5">·</span>}
                  <span className="tabular-nums font-medium text-foreground">{count}</span> {label}
                </span>
              ))}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={captureSnapshots}
              onChange={(e) => setCaptureSnapshots(e.target.checked)}
              className="rounded border-input"
            />
            Capture snapshots first
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={runRecompute}
            disabled={recomputing}
          >
            {recomputing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
            Recompute
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              setRecomputingDecisions(true);
              try {
                await fetch("/api/decision/recompute", { method: "POST" });
                await fetchList();
              } finally {
                setRecomputingDecisions(false);
              }
            }}
            disabled={recomputingDecisions}
          >
            {recomputingDecisions ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Recompute decisions
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters &amp; sort</CardTitle>
          <CardDescription>Filter by primary action, legacy action, category, theme; sort by priority, edge, or confidence.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Primary action</label>
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={primaryActionFilter}
              onChange={(e) => setPrimaryActionFilter(e.target.value)}
            >
              <option value="">All</option>
              {Object.entries(PRIMARY_ACTION_LABELS).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Action (legacy)</label>
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
            >
              <option value="">All</option>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Category</label>
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="">All</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Theme</label>
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={themeFilter}
              onChange={(e) => setThemeFilter(e.target.value)}
            >
              <option value="">All</option>
              {themes.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Sort</label>
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All recommendations</CardTitle>
          <CardDescription>Portfolio-aware actions and context. Sorted by action group then priority.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recommendations. Run recompute after syncing markets and user data.
            </p>
          ) : (
            (() => {
              const actionGroupOrder: Record<string, number> = { add: 0, review_existing: 1, trim: 2, hedge: 3, monitor: 4, avoid: 5, sync_first: 6 };
              const sorted = [...items].sort((a, b) => {
                const pa = a.primaryActionType ?? "monitor";
                const pb = b.primaryActionType ?? "monitor";
                const ga = actionGroupOrder[pa] ?? 4;
                const gb = actionGroupOrder[pb] ?? 4;
                if (ga !== gb) return ga - gb;
                return parseFloat(b.priorityScore) - parseFloat(a.priorityScore);
              });
              return (
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-2 font-medium w-[120px]">Primary action</th>
                    <th className="text-left py-2 px-2 font-medium">Market</th>
                    <th className="text-left py-2 px-2 font-medium">Review</th>
                    <th className="text-left py-2 px-2 font-medium">Type / warnings</th>
                    <th className="text-right py-2 px-2 font-medium">Price</th>
                    <th className="text-right py-2 px-2 font-medium">Fair</th>
                    <th className="text-right py-2 px-2 font-medium">Edge</th>
                    <th className="text-right py-2 px-2 font-medium">Conf</th>
                    <th className="text-right py-2 px-2 font-medium">Catalyst</th>
                    <th className="text-right py-2 px-2 font-medium">Score (H · ML)</th>
                    <th className="text-left py-2 px-2 font-medium">Policy</th>
                    <th className="text-right py-2 px-2 font-medium">Blend</th>
                    <th className="text-right py-2 px-2 font-medium">Final size</th>
                    <th className="text-left py-2 px-2 font-medium">Action</th>
                    <th className="text-right py-2 px-2 font-medium">Size</th>
                    <th className="text-left py-2 px-2 font-medium">Components</th>
                    <th className="text-left py-2 px-2 font-medium">Context / thesis</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => {
                    const isLateChase = r.signal.signalType === "LATE_CHASE";
                    const isOvercrowded = r.signal.signalType === "OVERCROWDED_THEME";
                    const comps = [
                      r.signal.momentumComponent != null && { label: "Mom", v: r.signal.momentumComponent },
                      r.signal.liquidityComponent != null && { label: "Liq", v: r.signal.liquidityComponent },
                      r.signal.crowdingComponent != null && { label: "Crowd", v: r.signal.crowdingComponent },
                      r.signal.portfolioComponent != null && { label: "Port", v: r.signal.portfolioComponent },
                      r.signal.behaviorComponent != null && { label: "Beh", v: r.signal.behaviorComponent },
                      r.signal.longshotComponent != null && { label: "Long", v: r.signal.longshotComponent },
                      r.signal.timeComponent != null && { label: "Time", v: r.signal.timeComponent },
                    ].filter(Boolean) as { label: string; v: string }[];
                    const primaryLabel = (r.primaryActionType && PRIMARY_ACTION_LABELS[r.primaryActionType]) ?? r.action;
                    const primaryGroup = r.primaryActionType ? PRIMARY_ACTION_GROUPS[r.primaryActionType] : null;
                    const explanationLines = [r.rationale, r.portfolioImpact, r.riskNote, r.timingNote, r.qualityBlocker].filter(Boolean) as string[];
                    return (
                      <tr key={r.id} className="border-b border-border/50 hover:bg-muted/50">
                        <td className="py-2 px-2 align-top">
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-xs font-semibold",
                              (r.primaryActionType === "add") && "bg-emerald-600/20 text-emerald-800 dark:text-emerald-300",
                              (r.primaryActionType === "review_existing") && "bg-blue-500/20 text-blue-700 dark:text-blue-400",
                              (r.primaryActionType === "trim" || r.primaryActionType === "hedge") && "bg-orange-500/20 text-orange-700 dark:text-orange-400",
                              (r.primaryActionType === "avoid" || r.primaryActionType === "monitor") && "bg-muted text-muted-foreground",
                              (r.primaryActionType === "sync_first") && "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                            )}
                          >
                            {primaryLabel}
                          </span>
                          {primaryGroup && (
                            <div className="text-[10px] text-muted-foreground mt-0.5">{primaryGroup}</div>
                          )}
                        </td>
                        <td className="py-2 px-2 max-w-[200px] truncate align-top" title={r.signal.marketTitle}>
                          <Link href={`/recommendations/${r.id}`} className="hover:underline truncate block font-medium">
                            {r.signal.marketTitle}
                          </Link>
                        </td>
                        <td className="py-2 px-2">
                          <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", r.reviewStatus === "APPROVED" ? "bg-green-500/20" : r.reviewStatus === "REJECTED" ? "bg-red-500/20" : r.reviewStatus === "REVIEWED" ? "bg-blue-500/20" : "bg-muted")}>
                            {r.reviewStatus}
                          </span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {["REVIEWED", "APPROVED", "REJECTED"].map((s) => (
                              <button key={s} type="button" className="text-xs underline disabled:opacity-50" disabled={updatingReviewId === r.id} onClick={() => setReview(r.id, s)}>
                                {s}
                              </button>
                            ))}
                            <Link href={`/recommendations/${r.id}`} className="text-xs underline">View</Link>
                            <Link href={`/recommendations/${r.id}`} className="text-xs underline text-green-600 dark:text-green-400">Place order</Link>
                          </div>
                        </td>
                        <td className="py-2 px-2">
                          <span className="text-xs text-muted-foreground">
                            {SIGNAL_TYPE_LABELS[r.signal.signalType] ?? r.signal.signalType}
                          </span>
                          {r.linkedNewsCount != null && r.linkedNewsCount > 0 && (
                            <span className="ml-1 rounded px-1.5 py-0.5 text-xs bg-blue-500/20 text-blue-700 dark:text-blue-400" title="Linked news count">
                              {r.linkedNewsCount} story{r.linkedNewsCount !== 1 ? "ies" : ""}
                            </span>
                          )}
                          {r.saturation != null && r.saturation >= 0.5 && (
                            <span className="ml-1 rounded px-1.5 py-0.5 text-xs bg-amber-500/20 text-amber-700 dark:text-amber-400" title="Story saturation / overcrowding">
                              Crowded
                            </span>
                          )}
                          {(isLateChase || isOvercrowded) && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {isLateChase && (
                                <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-amber-500/20 text-amber-700 dark:text-amber-400">
                                  Late chase
                                </span>
                              )}
                              {isOvercrowded && (
                                <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-orange-500/20 text-orange-700 dark:text-orange-400">
                                  Overcrowded
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">{formatPrice(r.signal.marketPrice)}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{formatPrice(r.signal.fairPrice)}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{formatPct(r.signal.edge)}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{formatPct(r.signal.confidence)}</td>
                        <td className="py-2 px-2 text-right">
                          {r.signal.catalystConfidence != null && parseFloat(r.signal.catalystConfidence) > 0 ? (
                            <span
                              className="rounded px-1.5 py-0.5 text-xs bg-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                              title={`Event impact boost: ${r.signal.eventImpactBoost ?? "—"}\nNarrative boost: ${r.signal.narrativeMomentumBoost ?? "—"}\nCatalyst confidence: ${r.signal.catalystConfidence ?? "—"} (source quality, novelty, link confidence). Stronger when catalyst is persistent; weaker for fast-decay.`}
                            >
                              {(parseFloat(r.signal.catalystConfidence) * 100).toFixed(0)}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right">
                          <span className="tabular-nums text-muted-foreground" title="Heuristic priority score">
                            H: {formatPct(r.priorityScore)}
                          </span>
                          {r.mlScore != null && (
                            <>
                              <span className="mx-1">·</span>
                              <span className="tabular-nums" title="Live ML score (from RecommendationMlScore / ACTIVE run)">
                                ML: {(parseFloat(r.mlScore) * 100).toFixed(0)}%
                              </span>
                              {r.mlModelRunStatus && (
                                <span className="ml-1 text-xs text-muted-foreground" title="Model run that produced this score">
                                  ({r.mlModelRunStatus})
                                </span>
                              )}
                              {Math.abs(parseFloat(r.priorityScore) - parseFloat(r.mlScore)) > 0.25 && (
                                <span className="ml-1 rounded px-1.5 py-0.5 text-xs font-medium bg-amber-500/20 text-amber-700 dark:text-amber-400" title="Heuristic and ML rank this recommendation very differently">
                                  ML disagrees
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="py-2 px-2">
                          {r.decision ? (
                            <>
                              <span
                                className={cn(
                                  "rounded px-1.5 py-0.5 text-xs font-medium",
                                  r.decision.policyState === "BLOCK" && "bg-red-500/20 text-red-700 dark:text-red-400",
                                  r.decision.policyState === "REVIEW_REQUIRED" && "bg-amber-500/20 text-amber-700 dark:text-amber-400",
                                  (r.decision.policyState === "ALLOW_SMALL" || r.decision.policyState === "ALLOW_NORMAL") && "bg-green-500/20 text-green-700 dark:text-green-400",
                                  r.decision.policyState === "ALLOW_HIGH_CONVICTION" && "bg-green-600/30 text-green-800 dark:text-green-300",
                                  (r.decision.policyState === "TRIM" || r.decision.policyState === "EXIT") && "bg-orange-500/20 text-orange-700 dark:text-orange-400"
                                )}
                              >
                                {r.decision.policyState}
                              </span>
                              {r.decision.reasoningJson && (() => {
                                try {
                                  const reason = JSON.parse(r.decision.reasoningJson) as { blockers?: string[] };
                                  if (reason.blockers?.length) {
                                    return (
                                      <div className="mt-1 text-xs text-muted-foreground max-w-[140px]" title={reason.blockers.join("; ")}>
                                        {reason.blockers.slice(0, 2).join("; ")}
                                      </div>
                                    );
                                  }
                                } catch { /* ignore */ }
                                return null;
                              })()}
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {r.decision ? formatPct(r.decision.blendedScore) : "—"}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {r.decision ? formatPct(r.decision.finalSuggestedSize) : "—"}
                        </td>
                        <td className="py-2 px-2 align-top">
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-xs font-medium",
                              r.action === "STRONG_BUY" && "bg-green-500/20 text-green-700 dark:text-green-400",
                              r.action === "BUY_SMALL" && "bg-green-500/10 text-green-600 dark:text-green-500",
                              r.action === "WATCH" && "bg-muted text-muted-foreground",
                              r.action === "NO_TRADE" && "bg-amber-500/20 text-amber-700 dark:text-amber-400",
                              (r.action === "TRIM" || r.action === "EXIT") && "bg-red-500/20 text-red-700 dark:text-red-400"
                            )}
                          >
                            {r.action}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums align-top">{formatPct(r.suggestedSize)}</td>
                        <td className="py-2 px-2 text-xs text-muted-foreground max-w-[180px] align-top">
                          {comps.length > 0 ? (
                            <span title={comps.map((c) => `${c.label}: ${c.v}`).join(", ")}>
                              {comps.map((c) => `${c.label}:${(parseFloat(c.v) * 100).toFixed(1)}`).join(" ")}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="py-2 px-2 max-w-[260px] align-top">
                          {explanationLines.length > 0 ? (
                            <div className="space-y-1 text-xs">
                              {explanationLines.map((line, i) => (
                                <p key={i} className={i === 0 ? "text-foreground" : "text-muted-foreground"}>{line}</p>
                              ))}
                            </div>
                          ) : r.blockedReason ? (
                            <span className="text-amber-600 dark:text-amber-500 text-xs">{r.blockedReason}</span>
                          ) : r.signal.thesis ? (
                            <span className="text-muted-foreground text-xs">{r.signal.thesis}</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
              );
            })()
          )}
        </CardContent>
      </Card>
    </div>
  );
}