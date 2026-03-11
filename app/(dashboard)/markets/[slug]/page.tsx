"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

interface MarketDetail {
  market: { id: string; slug: string | null; title: string; status: string; category: string | null; endDate: string | null; volumeNum: number | null; liquidityNum: number | null };
  outcomes: Array<{ assetId: string; outcome: string; outcomeIndex: number; price: string | null }>;
  priceSnapshots: Array<{ assetId: string; outcome: string; snapshots: Array<{ price: string; capturedAt: string }> }>;
  signals: Array<{
    id: string;
    outcome: string;
    marketPrice: string;
    fairPrice: string;
    edge: string;
    confidence: string;
    signalType: string;
    thesis: string | null;
    invalidation: string | null;
    momentumComponent?: string | null;
    liquidityComponent?: string | null;
    crowdingComponent?: string | null;
    portfolioComponent?: string | null;
    behaviorComponent?: string | null;
    longshotComponent?: string | null;
    timeComponent?: string | null;
    recommendation: {
      id: string;
      action: string;
      suggestedSize: string;
      blockedReason: string | null;
      review: { status: string; reviewerNote: string | null };
      decision: { policyState: string; blendedScore: string; sizeMultiplier: string; finalSuggestedSize: string } | null;
    } | null;
  }>;
  positions: Array<{ assetId: string; outcome: string; size: string; avgEntry: string; marketValue: string; unrealizedPnl: string }>;
  recentFills: Array<{ tradeId: string; assetId: string; side: string; size: string; price: string; outcome: string | null; syncedAt: string }>;
  recentOrders: Array<{ orderId: string; assetId: string; side: string; originalSize: string; price: string; status: string; outcome: string | null }>;
  behaviorFlags: Array<{ type: string; severity: string; description: string; marketTitle: string | null }>;
  notes: Array<{ id: string; note: string; tag: string; createdAt: string }>;
}

interface MarketNewsLinkRow {
  id: string;
  relevanceScore: number;
  impactScore: number;
  noveltyScore: number;
  freshnessScore: number;
  catalystSummary: string | null;
  newsItem: {
    id: string;
    url: string;
    title: string;
    summary: string | null;
    publishedAt: string | null;
    source: { id: string; name: string; credibilityScore: number };
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

export default function MarketDetailPage() {
  const params = useParams();
  const router = useRouter();
  const slug = typeof params.slug === "string" ? params.slug : "";
  const [data, setData] = useState<MarketDetail | null>(null);
  const [newsLinks, setNewsLinks] = useState<MarketNewsLinkRow[]>([]);
  const [marketImpact, setMarketImpact] = useState<{
    impactEstimate: number;
    confidence: number;
    eventCount: number;
    totalBlendedImpact?: number;
    totalPersistentImpact?: number;
    calibratedEventCount?: number;
    links: Array<{
      id: string;
      impactEstimate: number;
      confidence: number;
      instantImpact?: number | null;
      persistentImpact?: number | null;
      decayHalfLifeMinutes?: number | null;
      impactObserved5m?: number | null;
      impactObserved30m?: number | null;
      impactObserved2h?: number | null;
      impactObserved24h?: number | null;
      calibrationError5m?: number | null;
      calibrationError30m?: number | null;
      calibrationError2h?: number | null;
      calibrationError24h?: number | null;
      calibrationOutcomeIndex?: number | null;
      calibrationConfidence?: number | null;
      eventSignal: {
        eventType: string;
        entityPrimary: string | null;
        severity: string | null;
        sentiment: string | null;
        sourceName?: string | null;
        isOfficialSource?: boolean | null;
        noveltyScore?: number | null;
        confirmationCount?: number | null;
        newsItem: { title: string; url: string };
      };
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [noteText, setNoteText] = useState("");
  const [noteTag, setNoteTag] = useState<string>("manual");

  const fetchDetail = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    try {
      const [marketRes, newsRes, impactRes] = await Promise.all([
        fetch(`/api/markets/${encodeURIComponent(slug)}`),
        fetch(`/api/news/market/${encodeURIComponent(slug)}`),
        fetch(`/api/news/market-impact/${encodeURIComponent(slug)}`),
      ]);
      if (marketRes.ok) setData(await marketRes.json());
      else setData(null);
      if (newsRes.ok) {
        const newsData = await newsRes.json();
        setNewsLinks(newsData.links ?? []);
      } else setNewsLinks([]);
      if (impactRes.ok) {
        const impactData = await impactRes.json();
        setMarketImpact({
          impactEstimate: impactData.impactEstimate ?? impactData.totalBlendedImpact ?? 0,
          confidence: impactData.confidence ?? impactData.averageConfidence ?? 0,
          eventCount: impactData.eventCount ?? 0,
          totalBlendedImpact: impactData.totalBlendedImpact,
          totalPersistentImpact: impactData.totalPersistentImpact,
          calibratedEventCount: impactData.calibratedEventCount ?? impactData.calibratedEventCount,
          links: impactData.links ?? [],
        });
      } else setMarketImpact(null);
    } catch {
      setData(null);
      setNewsLinks([]);
      setMarketImpact(null);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const addNote = async () => {
    if (!noteText.trim()) return;
    const res = await fetch(`/api/markets/${encodeURIComponent(slug)}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: noteText.trim(), tag: noteTag }),
    });
    if (res.ok) {
      setNoteText("");
      fetchDetail();
    }
  };

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <Link href="/markets" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" /> Back to markets
        </Link>
        <p className="text-muted-foreground">{loading ? "Loading…" : "Market not found."}</p>
      </div>
    );
  }

  const { market, outcomes, priceSnapshots, signals, positions, recentFills, recentOrders, behaviorFlags, notes } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/markets" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" /> Back to markets
        </Link>
      </div>

      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">{market.title}</h2>
        <p className="text-muted-foreground text-sm">
          {market.category && <span>Category: {market.category}</span>}
          {market.endDate && <span> · End: {new Date(market.endDate).toLocaleDateString()}</span>}
          {market.volumeNum != null && <span> · Volume: {market.volumeNum.toLocaleString()}</span>}
        </p>
      </div>

      {marketImpact && (marketImpact.eventCount > 0 || marketImpact.impactEstimate !== 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Structured events &amp; probability impact</CardTitle>
            <CardDescription>Event signals, V2 impact (instant/persistent), observed and calibration.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3 text-sm">
              <span className="rounded px-2 py-1 bg-muted">Blended: {((marketImpact.totalBlendedImpact ?? marketImpact.impactEstimate) * 100).toFixed(1)}%</span>
              <span className="rounded px-2 py-1 bg-muted">Persistent: {((marketImpact.totalPersistentImpact ?? marketImpact.impactEstimate) * 100).toFixed(1)}%</span>
              <span className="rounded px-2 py-1 bg-muted">Confidence: {(marketImpact.confidence * 100).toFixed(0)}%</span>
              <span className="rounded px-2 py-1 bg-muted">Events: {marketImpact.eventCount}</span>
              {(marketImpact.calibratedEventCount ?? 0) > 0 && (
                <span className="rounded px-2 py-1 bg-muted">Calibrated: {marketImpact.calibratedEventCount}</span>
              )}
            </div>
            {marketImpact.links.length > 0 && (
              <ul className="space-y-3 text-sm">
                {marketImpact.links.slice(0, 10).map((l) => (
                  <li key={l.id} className="rounded border p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">{l.eventSignal.eventType}</span>
                      {l.eventSignal.entityPrimary && <span className="text-muted-foreground">{l.eventSignal.entityPrimary}</span>}
                      {l.eventSignal.sourceName && <span className="text-muted-foreground">{l.eventSignal.sourceName}</span>}
                      {l.eventSignal.isOfficialSource && <span className="rounded px-1.5 py-0.5 text-xs bg-green-500/20">Official</span>}
                      {l.eventSignal.noveltyScore != null && <span className="text-muted-foreground">Novelty {(l.eventSignal.noveltyScore * 100).toFixed(0)}%</span>}
                      {l.eventSignal.confirmationCount != null && l.eventSignal.confirmationCount > 0 && <span className="text-muted-foreground">×{l.eventSignal.confirmationCount}</span>}
                    </div>
                    <div className="flex flex-wrap gap-2 text-muted-foreground">
                      <span>Instant {(l.instantImpact != null ? (l.instantImpact * 100).toFixed(1) : "—")}%</span>
                      <span>Persistent {(l.persistentImpact != null ? (l.persistentImpact * 100).toFixed(1) : "—")}%</span>
                      <span>Conf {(l.confidence * 100).toFixed(0)}%</span>
                      {l.decayHalfLifeMinutes != null && <span>t½ {l.decayHalfLifeMinutes}m</span>}
                      {l.impactObserved5m != null && <span>Obs 5m {(l.impactObserved5m * 100).toFixed(1)}%</span>}
                      {l.impactObserved24h != null && <span>Obs 24h {(l.impactObserved24h * 100).toFixed(1)}%</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Calibration:{" "}
                      {l.calibrationConfidence != null && l.calibrationConfidence >= 1.0 ? (
                        <>✓ YES token (confidence {l.calibrationConfidence.toFixed(1)})</>
                      ) : l.calibrationConfidence != null && l.calibrationConfidence >= 0.5 ? (
                        <>✓ inferred YES (confidence {l.calibrationConfidence.toFixed(1)})</>
                      ) : l.calibrationConfidence != null && l.calibrationConfidence > 0 ? (
                        <>⚠ fallback asset (confidence {l.calibrationConfidence.toFixed(1)})</>
                      ) : l.calibrationOutcomeIndex != null ? (
                        <>Outcome index {l.calibrationOutcomeIndex} (confidence —)</>
                      ) : (
                        <>—</>
                      )}
                    </div>
                    <a href={l.eventSignal.newsItem?.url} target="_blank" rel="noopener noreferrer" className="truncate max-w-full block hover:underline">{l.eventSignal.newsItem?.title}</a>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {newsLinks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Linked news &amp; catalysts</CardTitle>
            <CardDescription>Relevance, freshness, credibility. Catalyst summaries for context.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {newsLinks.slice(0, 15).map((link) => (
              <div key={link.id} className="border rounded-lg p-3 space-y-2 text-sm">
                <div className="flex flex-wrap gap-2">
                  <a href={link.newsItem.url} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">
                    {link.newsItem.title}
                  </a>
                  <span className="rounded px-1.5 py-0.5 text-xs bg-muted">rel {(link.relevanceScore * 100).toFixed(0)}%</span>
                  <span className="rounded px-1.5 py-0.5 text-xs bg-muted">fresh {(link.freshnessScore * 100).toFixed(0)}%</span>
                  <span className="rounded px-1.5 py-0.5 text-xs bg-muted">cred {(link.impactScore * 100).toFixed(0)}%</span>
                  <span className="rounded px-1.5 py-0.5 text-xs bg-muted">{link.newsItem.source.name}</span>
                </div>
                {link.catalystSummary && (
                  <p className="text-muted-foreground text-xs">{link.catalystSummary}</p>
                )}
                {link.newsItem.publishedAt && (
                  <p className="text-xs text-muted-foreground">{new Date(link.newsItem.publishedAt).toLocaleString()}</p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Outcomes &amp; prices</CardTitle>
          <CardDescription>Current outcome prices from latest snapshot / raw</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {outcomes.map((o) => (
              <li key={o.assetId} className="flex justify-between text-sm">
                <span>{o.outcome}</span>
                <span className="tabular-nums">{o.price != null ? formatPrice(o.price) : "—"}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {priceSnapshots.some((p) => p.snapshots.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Price history (by outcome)</CardTitle>
            <CardDescription>Recent snapshots for chart</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {priceSnapshots.map((p) => (
                <div key={p.assetId}>
                  <p className="text-sm font-medium mb-2">{p.outcome}</p>
                  <div className="h-8 flex gap-px rounded overflow-hidden">
                    {p.snapshots.slice(0, 30).reverse().map((s, i) => {
                      const price = parseFloat(s.price);
                      return (
                        <div
                          key={i}
                          className="flex-1 min-w-[4px] bg-primary/60 hover:bg-primary"
                          style={{ height: `${Math.max(5, price * 100)}%`, alignSelf: "flex-end" }}
                          title={`${formatPrice(s.price)} @ ${new Date(s.capturedAt).toLocaleString()}`}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {signals.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Signals &amp; recommendations</CardTitle>
            <CardDescription>Latest signal per outcome with component breakdown</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {signals.map((s) => (
              <div key={s.id} className="border rounded-lg p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{s.outcome}</span>
                  <span className="text-xs text-muted-foreground">{s.signalType}</span>
                  {s.recommendation && (
                    <>
                      <span className={cn("rounded px-1.5 py-0.5 text-xs", s.recommendation.action === "STRONG_BUY" || s.recommendation.action === "BUY_SMALL" ? "bg-green-500/20" : "bg-muted")}>
                        {s.recommendation.action}
                      </span>
                      <span className={cn("rounded px-1.5 py-0.5 text-xs", s.recommendation.review?.status === "APPROVED" ? "bg-green-500/20" : s.recommendation.review?.status === "REJECTED" ? "bg-red-500/20" : "bg-muted")}>
                        {s.recommendation.review?.status ?? "NEW"}
                      </span>
                      {s.recommendation.decision && (
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-xs font-medium",
                            s.recommendation.decision.policyState === "BLOCK" && "bg-red-500/20",
                            s.recommendation.decision.policyState === "REVIEW_REQUIRED" && "bg-amber-500/20",
                            (s.recommendation.decision.policyState === "ALLOW_SMALL" || s.recommendation.decision.policyState === "ALLOW_NORMAL") && "bg-green-500/20",
                            s.recommendation.decision.policyState === "ALLOW_HIGH_CONVICTION" && "bg-green-600/30",
                            (s.recommendation.decision.policyState === "TRIM" || s.recommendation.decision.policyState === "EXIT") && "bg-orange-500/20"
                          )}
                        >
                          {s.recommendation.decision.policyState}
                        </span>
                      )}
                      {s.recommendation.decision && (
                        <span className="text-xs text-muted-foreground">
                          Blend {formatPct(s.recommendation.decision.blendedScore)} · Final size {formatPct(s.recommendation.decision.finalSuggestedSize)}
                        </span>
                      )}
                      <Link href={`/recommendations/${s.recommendation.id}`}>
                        <Button variant="ghost" size="sm" className="h-7 text-xs">View</Button>
                      </Link>
                    </>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">Price {formatPrice(s.marketPrice)} → Fair {formatPrice(s.fairPrice)} · Edge {formatPct(s.edge)} · Conf {formatPct(s.confidence)}</p>
                {(s.momentumComponent != null || s.liquidityComponent != null) && (
                  <p className="text-xs text-muted-foreground">
                    Components: Mom {s.momentumComponent ?? "—"} Liq {s.liquidityComponent ?? "—"} Crowd {s.crowdingComponent ?? "—"} Port {s.portfolioComponent ?? "—"}
                  </p>
                )}
                {s.thesis && <p className="text-xs">{s.thesis}</p>}
                {s.invalidation && <p className="text-xs text-amber-600 dark:text-amber-500">Invalidation: {s.invalidation}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Your positions in this market</CardTitle>
          <CardDescription>Positions linked to this market (by catalog) are shown here.</CardDescription>
        </CardHeader>
        <CardContent>
          {positions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No positions linked to this market.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {positions.map((p) => (
                <li key={p.assetId} className="flex justify-between">
                  <span>{p.outcome} size {p.size}</span>
                  <span>Avg {formatPrice(p.avgEntry)} · Value {p.marketValue} · PnL {p.unrealizedPnl}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent fills</CardTitle>
          </CardHeader>
          <CardContent>
            {recentFills.length === 0 ? <p className="text-sm text-muted-foreground">None</p> : (
              <ul className="space-y-1 text-sm">
                {recentFills.map((f) => (
                  <li key={f.tradeId}>{f.side} {f.size} @ {f.price} ({f.outcome ?? "—"})</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent open orders</CardTitle>
          </CardHeader>
          <CardContent>
            {recentOrders.length === 0 ? <p className="text-sm text-muted-foreground">None</p> : (
              <ul className="space-y-1 text-sm">
                {recentOrders.map((o) => (
                  <li key={o.orderId}>{o.side} {o.originalSize} @ {o.price} — {o.status}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {behaviorFlags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Related behavior flags</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {behaviorFlags.map((f, i) => (
                <li key={i} className={cn("rounded px-2 py-1", f.severity === "high" ? "bg-red-500/10" : "bg-muted")}>{f.type}: {f.description}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
          <CardDescription>Add notes (news, thesis, warning, catalyst, manual). Read-only app; no order placement.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2 flex-wrap">
            <input
              className="flex-1 min-w-[200px] rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="Add a note…"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
            />
            <select className="rounded-md border border-input bg-background px-3 py-2 text-sm" value={noteTag} onChange={(e) => setNoteTag(e.target.value)}>
              <option value="manual">manual</option>
              <option value="news">news</option>
              <option value="thesis">thesis</option>
              <option value="warning">warning</option>
              <option value="catalyst">catalyst</option>
            </select>
            <Button size="sm" onClick={addNote} disabled={!noteText.trim()}>Add note</Button>
          </div>
          {notes.length === 0 ? <p className="text-sm text-muted-foreground">No notes yet.</p> : (
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id} className="text-sm border-l-2 pl-2 border-muted">
                  <span className="text-xs text-muted-foreground">{n.tag} · {new Date(n.createdAt).toLocaleString()}</span>
                  <p>{n.note}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
