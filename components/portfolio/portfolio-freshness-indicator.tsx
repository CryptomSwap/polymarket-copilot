"use client";

import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";

/** Contract: freshnessMs=0 => fresh, >0 => cached age, null => unknown. Do not treat unknown as fresh. */
export type FreshnessState = "fresh" | "cached" | "unknown";

export interface PortfolioFreshnessProps {
  /** Positions: e.g. "official" | "derived" | "mixed_fallback" */
  sourceOfTruth?: string | null;
  /** Positions: ISO date when positions/live portfolio was fetched. Canonical "last updated" for positions. */
  asOf?: string | null;
  /** Positions: 0 = fresh, >0 = cached age ms, null = unknown */
  freshnessMs?: number | null;
  /** Positions: "fresh" | "cached" | "unknown" */
  freshnessState?: FreshnessState | null;
  /** Orders: e.g. "official" | "derived" */
  orderSourceOfTruth?: string | null;
  /** Orders: ISO date when open orders were fetched. Shown separately when different from asOf. */
  ordersAsOf?: string | null;
  /** Orders: 0 = fresh, >0 = cached age, null = unknown */
  ordersFreshnessMs?: number | null;
  /** Orders: "fresh" | "cached" | "unknown" */
  ordersFreshnessState?: FreshnessState | null;
  /** Compact (single line when unified) vs normal */
  compact?: boolean;
  className?: string;
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "—";
    const now = Date.now();
    const diffMs = now - d.getTime();
    const sec = Math.floor(diffMs / 1000);
    const min = Math.floor(sec / 60);
    if (sec < 10) return "just now";
    if (sec < 60) return `${sec}s ago`;
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    return `${h}h ago`;
  } catch {
    return "—";
  }
}

function freshnessStateLabel(state: FreshnessState | null | undefined): string {
  if (state === "fresh") return "Just fetched";
  if (state === "cached") return "From cache";
  if (state === "unknown") return "Freshness unknown";
  return "";
}

function tooltipForSegment(
  kind: "Positions" | "Orders",
  asOf: string | null | undefined,
  state: FreshnessState,
  freshnessMs: number | null | undefined,
  source: string
): string {
  const parts: string[] = [`${kind}:`];
  if (asOf) parts.push(`as of ${new Date(asOf).toLocaleString()}`);
  if (state === "fresh") parts.push("fresh fetch");
  else if (state === "cached" && freshnessMs != null) parts.push(`cached ${Math.round(freshnessMs / 1000)}s ago`);
  else if (state === "unknown") parts.push("freshness unknown (do not assume fresh)");
  parts.push(`source ${source}`);
  return parts.join(" · ");
}

export function PortfolioFreshnessIndicator({
  sourceOfTruth,
  asOf,
  freshnessMs,
  freshnessState,
  orderSourceOfTruth,
  ordersAsOf,
  ordersFreshnessMs,
  ordersFreshnessState,
  compact = false,
  className,
}: PortfolioFreshnessProps) {
  const posState: FreshnessState = freshnessState ?? (freshnessMs == null ? "unknown" : freshnessMs === 0 ? "fresh" : "cached");
  const orderState: FreshnessState = ordersFreshnessState ?? (ordersFreshnessMs == null ? "unknown" : ordersFreshnessMs === 0 ? "fresh" : "cached");
  const posLabel = asOf ? formatRelative(asOf) : "—";
  const orderLabel = ordersAsOf ? formatRelative(ordersAsOf) : "—";
  const posSource = sourceOfTruth ?? "—";
  const orderSource = orderSourceOfTruth ?? "—";

  const hasOrdersData = ordersAsOf != null;
  const sameTime = hasOrdersData && asOf != null && ordersAsOf === asOf;
  const sameSource = posSource === orderSource;
  const sameFreshness = posState === orderState;
  const unified = !hasOrdersData || (sameTime && sameSource && sameFreshness);

  const posTooltip = tooltipForSegment("Positions", asOf, posState, freshnessMs, posSource);
  const orderTooltip = tooltipForSegment("Orders", ordersAsOf, orderState, ordersFreshnessMs, orderSource);
  const fullTooltip = unified
    ? hasOrdersData
      ? `Positions and orders from same time. ${posTooltip}`
      : posTooltip
    : [posTooltip, orderTooltip].join(" | ");

  if (compact) {
    if (unified) {
      return (
        <span
          className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}
          title={fullTooltip}
        >
          <Clock className="h-3 w-3 shrink-0" />
          {posLabel}
          {posSource !== "—" && <span className="opacity-80">· {posSource}</span>}
          {posState === "cached" && freshnessMs != null && <span className="opacity-80">· Cached</span>}
          {posState === "unknown" && <span className="opacity-80">· Unknown</span>}
        </span>
      );
    }
    return (
      <span
        className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground", className)}
        title={fullTooltip}
      >
        <Clock className="h-3 w-3 shrink-0" />
        <span title={posTooltip}>Positions: {posLabel} · {posSource}</span>
        <span className="opacity-70" aria-hidden>|</span>
        <span title={orderTooltip}>Orders: {orderLabel} · {orderSource}</span>
      </span>
    );
  }

  if (unified) {
    return (
      <div
        className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", className)}
        title={fullTooltip}
      >
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3 w-3 shrink-0" />
          Last updated: {posLabel}
        </span>
        {posSource !== "—" && <span title="Positions source">Source: {posSource}</span>}
        {posState === "cached" && freshnessMs != null && (
          <span title="Positions data from server cache">Cached {Math.round(freshnessMs / 1000)}s</span>
        )}
        {posState === "unknown" && <span title="Freshness unknown">Unknown</span>}
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-col gap-0.5 text-xs text-muted-foreground", className)}
      title={fullTooltip}
    >
      <span className="inline-flex items-center gap-1" title={posTooltip}>
        <Clock className="h-3 w-3 shrink-0" />
        Positions: {posLabel} · {posSource}
        {posState === "cached" && freshnessMs != null && ` (cached ${Math.round(freshnessMs / 1000)}s)`}
        {posState === "unknown" && " (unknown)"}
      </span>
      <span className="inline-flex items-center gap-1 pl-4" title={orderTooltip}>
        Orders: {orderLabel} · {orderSource}
        {orderState === "cached" && ordersFreshnessMs != null && ` (cached ${Math.round(ordersFreshnessMs / 1000)}s)`}
        {orderState === "unknown" && " (unknown)"}
      </span>
    </div>
  );
}
