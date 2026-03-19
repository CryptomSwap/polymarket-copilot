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
import { Loader2, RefreshCw, Shield, CheckCircle, AlertTriangle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface GuardrailCheck {
  key: string;
  status: "pass" | "warn" | "fail";
  title: string;
  message: string;
  blocking: boolean;
  metadata?: Record<string, unknown>;
}

interface GuardrailsPayload {
  ready: boolean;
  status: "ready" | "caution" | "blocked";
  checks: GuardrailCheck[];
  asOf: string;
  notes?: string | null;
}

export function GuardrailsCard() {
  const [data, setData] = useState<GuardrailsPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchGuardrails = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bot/guardrails");
      if (res.ok) {
        const json = await res.json();
        setData(json);
      } else {
        setData(null);
      }
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGuardrails();
  }, [fetchGuardrails]);

  if (loading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" /> Bot readiness
          </CardTitle>
          <CardDescription>Preflight guardrails (read-only). No autonomous trading.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" /> Bot readiness
          </CardTitle>
          <CardDescription>Preflight guardrails (read-only). No autonomous trading.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Guardrails unavailable. Connect wallet and retry.</p>
        </CardContent>
      </Card>
    );
  }

  const statusIcon =
    data.status === "ready" ? (
      <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
    ) : data.status === "caution" ? (
      <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
    ) : (
      <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
    );

  const statusLabel =
    data.status === "ready" ? "Ready" : data.status === "caution" ? "Caution" : "Blocked";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Shield className="h-5 w-5" /> Bot readiness
            </CardTitle>
            <CardDescription>
              Preflight guardrails (read-only). Does not enable autonomous trading.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium",
                data.status === "ready" && "bg-green-500/15 text-green-700 dark:text-green-400",
                data.status === "caution" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                data.status === "blocked" && "bg-red-500/15 text-red-700 dark:text-red-400"
              )}
            >
              {statusIcon}
              {statusLabel}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={fetchGuardrails}
              disabled={loading}
              aria-label="Refresh guardrails"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        {data.notes && (
          <p className="text-sm text-muted-foreground mt-1">{data.notes}</p>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-xs text-muted-foreground mb-3">As of {new Date(data.asOf).toLocaleString()}</p>
        <ul className="space-y-2">
          {data.checks.map((c) => (
            <li
              key={c.key}
              className={cn(
                "flex items-start gap-2 rounded border px-2.5 py-1.5 text-sm",
                c.status === "pass" && "border-green-500/30 bg-green-500/5",
                c.status === "warn" && "border-amber-500/30 bg-amber-500/5",
                c.status === "fail" && "border-red-500/30 bg-red-500/5"
              )}
            >
              {c.status === "pass" && <CheckCircle className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400 mt-0.5" />}
              {c.status === "warn" && <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />}
              {c.status === "fail" && <XCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400 mt-0.5" />}
              <div>
                <span className="font-medium">{c.title}</span>
                {c.blocking && (
                  <span className="ml-1.5 text-xs font-medium text-red-600 dark:text-red-400">(blocking)</span>
                )}
                <p className="text-muted-foreground mt-0.5">{c.message}</p>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
