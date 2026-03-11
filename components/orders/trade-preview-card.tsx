"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TradePreviewCardProps {
  marketId: string;
  marketTitle: string;
  outcome: string;
  side: "BUY" | "SELL";
  initialPrice: string;
  initialSize: string;
  recommendationId?: string | null;
  assetId?: string | null;
  thesis?: string | null;
  invalidation?: string | null;
  reviewStatus?: string;
  blockedReason?: string | null;
}

interface RiskPreview {
  currentExposure: { assetMarketValue: number; assetSize: number; themeExposure: number; themeLabel: string };
  postTradeExposure: { assetMarketValue: number; assetSize: number; themeExposure: number };
  concentrationImpact: { currentTopPct: number; postTopPct: number; currentThemePct: number; postThemePct: number };
  themeImpact: { theme: string; currentPct: number; postPct: number; deltaPct: number };
  reservedCapitalImpact: { currentReserved: number; reservedForAsset: number };
  warnings: string[];
  blocked: boolean;
}

export function TradePreviewCard({
  marketId,
  marketTitle,
  outcome,
  side,
  initialPrice,
  initialSize,
  recommendationId,
  assetId,
  thesis,
  invalidation,
  reviewStatus,
  blockedReason,
}: TradePreviewCardProps) {
  const [limitPrice, setLimitPrice] = useState(initialPrice);
  const [size, setSize] = useState(initialSize);
  const [preview, setPreview] = useState<{ riskPreview: RiskPreview; marketTitle: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [placeLoading, setPlaceLoading] = useState(false);
  const [placeResult, setPlaceResult] = useState<{ success: boolean; error?: string; polymarketOrderId?: string } | null>(null);
  const [skipBlockedCheck, setSkipBlockedCheck] = useState(false);
  const [preflightResult, setPreflightResult] = useState<{ passed: boolean; warnings: string[] } | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [skipPreflightCheck, setSkipPreflightCheck] = useState(false);

  const runPreflight = async () => {
    setPreflightResult(null);
    setPreflightLoading(true);
    try {
      const res = await fetch("/api/orders/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId,
          assetId: assetId ?? undefined,
          outcome,
          limitPrice,
          size,
          recommendationId: recommendationId ?? undefined,
        }),
      });
      const data = await res.json();
      if (data.warnings != null) {
        setPreflightResult({ passed: !!data.passed, warnings: Array.isArray(data.warnings) ? data.warnings : [] });
      }
    } finally {
      setPreflightLoading(false);
    }
  };

  const runPreview = async () => {
    setPreview(null);
    setPreviewLoading(true);
    setPlaceResult(null);
    try {
      const res = await fetch("/api/orders/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId,
          assetId: assetId ?? undefined,
          outcome,
          side,
          limitPrice,
          size,
          recommendationId: recommendationId ?? undefined,
        }),
      });
      const data = await res.json();
      if (data.valid && data.riskPreview) {
        setPreview({ riskPreview: data.riskPreview, marketTitle: data.marketTitle ?? marketTitle });
      }
    } finally {
      setPreviewLoading(false);
    }
  };

  const placeOrder = async () => {
    setPlaceResult(null);
    setPlaceLoading(true);
    try {
      const res = await fetch("/api/orders/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId,
          assetId: assetId ?? undefined,
          outcome,
          side,
          limitPrice,
          size,
          recommendationId: recommendationId ?? undefined,
          skipBlockedCheck: preview?.riskPreview?.blocked ? skipBlockedCheck : undefined,
          skipPreflightCheck: preflightResult && !preflightResult.passed ? skipPreflightCheck : undefined,
        }),
      });
      const data = await res.json();
      setPlaceResult({
        success: data.success,
        error: data.error,
        polymarketOrderId: data.polymarketOrderId,
      });
      if (data.success) setPreview(null);
    } finally {
      setPlaceLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review trade / Place order</CardTitle>
        <CardDescription>
          Manual approval only. Preview impact then place limit order. No autonomous trading.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm font-medium">{marketTitle}</p>
        <p className="text-xs text-muted-foreground">{outcome} · {side}</p>
        {thesis && <p className="text-sm text-muted-foreground">Thesis: {thesis}</p>}
        {invalidation && (
          <p className="text-sm text-amber-600 dark:text-amber-500">Invalidation: {invalidation}</p>
        )}
        {reviewStatus && (
          <p className="text-xs text-muted-foreground">Review status: {reviewStatus}</p>
        )}
        {blockedReason && (
          <p className="text-xs text-amber-600 dark:text-amber-500">Blocked: {blockedReason}</p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Limit price (0–1)</label>
            <input
              type="text"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              placeholder="0.50"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Size</label>
            <input
              type="text"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              placeholder="10"
            />
          </div>
        </div>

        {preflightResult && (
          <div className={cn(
            "rounded-md border p-3 text-sm",
            preflightResult.passed ? "border-green-500/50 bg-green-500/10" : "border-amber-500/50 bg-amber-500/10"
          )}>
            <p className="font-medium">Preflight: {preflightResult.passed ? "Passed" : "Failed"}</p>
            {preflightResult.warnings.length > 0 && (
              <ul className="list-disc list-inside text-muted-foreground mt-1">
                {preflightResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={runPreflight} disabled={preflightLoading}>
            {preflightLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Run preflight
          </Button>
          <Button variant="outline" size="sm" onClick={runPreview} disabled={previewLoading}>
            {previewLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Preview impact
          </Button>
          {preview?.riskPreview && (
            <>
              {preview.riskPreview.blocked && (
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={skipBlockedCheck}
                    onChange={(e) => setSkipBlockedCheck(e.target.checked)}
                    className="rounded border-input"
                  />
                  Override block (accept risk)
                </label>
              )}
              {preflightResult && !preflightResult.passed && (
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={skipPreflightCheck}
                    onChange={(e) => setSkipPreflightCheck(e.target.checked)}
                    className="rounded border-input"
                  />
                  Override preflight
                </label>
              )}
              <Button
                size="sm"
                onClick={placeOrder}
                disabled={
                  placeLoading ||
                  (preview.riskPreview.blocked && !skipBlockedCheck) ||
                  !!(preflightResult && !preflightResult.passed && !skipPreflightCheck)
                }
              >
                {placeLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                Place order
              </Button>
            </>
          )}
        </div>

        {placeResult && (
          <div
            className={cn(
              "rounded-md border p-3 text-sm",
              placeResult.success ? "border-green-500/50 bg-green-500/10" : "border-red-500/50 bg-red-500/10"
            )}
          >
            {placeResult.success ? (
              <p>Order placed. Polymarket ID: {placeResult.polymarketOrderId}</p>
            ) : (
              <p>{placeResult.error}</p>
            )}
          </div>
        )}

        {preview?.riskPreview && (
          <div className="space-y-2 rounded-md border border-border p-3 text-sm">
            <p className="font-medium">Risk preview</p>
            <p className="text-muted-foreground">
              Theme: {preview.riskPreview.themeImpact.theme} · Current {preview.riskPreview.concentrationImpact.currentThemePct.toFixed(0)}% → Post {preview.riskPreview.concentrationImpact.postThemePct.toFixed(0)}%
            </p>
            {preview.riskPreview.warnings.length > 0 && (
              <div className="flex flex-col gap-1">
                {preview.riskPreview.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-amber-600 dark:text-amber-500">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
            {preview.riskPreview.blocked && (
              <p className="font-medium text-amber-600 dark:text-amber-500">Order blocked by concentration/safety rules.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
