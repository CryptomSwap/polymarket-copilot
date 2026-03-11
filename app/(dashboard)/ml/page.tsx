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
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface MlSummary {
  latestRun: {
    id: string;
    modelType: string;
    targetLabel: string;
    featureSetName: string;
    status: string;
    trainCount: number | null;
    validationCount: number | null;
    trainedFrom: string | null;
    trainedTo: string | null;
    validatedFrom: string | null;
    validatedTo: string | null;
    leakageCheckPassed: boolean | null;
    createdAt: string;
  } | null;
  activeModel: { id: string; status: string; targetLabel: string; featureSetName: string } | null;
  datasetSize: number;
  liveScoredCount: number;
  latestScoringTime: string | null;
  metrics: {
    accuracy: number;
    precision: number;
    recall: number;
    f1: number;
    rocAuc: number;
    threshold: number;
  } | null;
  comparison: {
    topN: Array<{ n: number; heuristicHitRate: number; mlHitRate: number; heuristicAvgReturn: number | null; mlAvgReturn: number | null }>;
  } | null;
  calibration: { mae: number } | null;
  featureImportance: Array<{ name: string; coefficient: number; absCoefficient: number }> | null;
}

interface MlRun {
  id: string;
  modelType: string;
  targetLabel: string;
  featureSetName: string;
  status: string;
  trainCount: number | null;
  validationCount: number | null;
  trainedFrom: string | null;
  trainedTo: string | null;
  validatedFrom: string | null;
  validatedTo: string | null;
  leakageCheckPassed: boolean | null;
  createdAt: string;
}

export default function MlPage() {
  const [summary, setSummary] = useState<MlSummary | null>(null);
  const [runs, setRuns] = useState<MlRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [training, setTraining] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [actionRunId, setActionRunId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [summaryRes, runsRes] = await Promise.all([
        fetch("/api/ml/evaluation-summary"),
        fetch("/api/ml/runs?limit=10"),
      ]);
      if (summaryRes.ok) {
        const json = await summaryRes.json();
        setSummary({
          latestRun: json.latestRun ?? null,
          activeModel: json.activeModel ?? null,
          datasetSize: json.datasetSize ?? 0,
          liveScoredCount: json.liveScoredCount ?? 0,
          latestScoringTime: json.latestScoringTime ?? null,
          metrics: json.metrics ?? null,
          comparison: json.comparison ?? null,
          calibration: json.calibration ?? null,
          featureImportance: json.featureImportance ?? null,
        });
      } else setSummary(null);
      if (runsRes.ok) {
        const json = await runsRes.json();
        setRuns(json.runs ?? []);
      } else setRuns([]);
    } catch {
      setSummary(null);
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const runAction = async (runId: string, action: "approve" | "reject" | "activate") => {
    setActionRunId(runId);
    try {
      const endpoint = action === "approve" ? "/api/ml/approve-run" : action === "reject" ? "/api/ml/reject-run" : "/api/ml/activate-run";
      await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId }) });
      await fetchData();
    } finally {
      setActionRunId(null);
    }
  };

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">ML baseline</h2>
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">ML baseline</h2>
        <p className="text-muted-foreground">
          Time-based train/validation split, leakage check, model registry (approve/activate). Score live with ACTIVE model; RecommendationMlScore is source of truth. Advisory only; no autonomous trading.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dataset, training &amp; scoring</CardTitle>
          <CardDescription>Build dataset, train (time-split), then approve/activate a run and score live recommendations.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={building}
            onClick={async () => {
              setBuilding(true);
              try {
                await fetch("/api/ml/build-dataset", { method: "POST" });
                await fetchData();
              } finally {
                setBuilding(false);
              }
            }}
          >
            {building ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Build dataset
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={training}
            onClick={async () => {
              setTraining(true);
              try {
                await fetch("/api/ml/train-baseline", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ targetLabel: "labelPositive24h" }),
                });
                await fetchData();
              } finally {
                setTraining(false);
              }
            }}
          >
            {training ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Train baseline (24h)
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={training}
            onClick={async () => {
              setTraining(true);
              try {
                await fetch("/api/ml/train-baseline", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ targetLabel: "labelPositive6h" }),
                });
                await fetchData();
              } finally {
                setTraining(false);
              }
            }}
          >
            {training ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Train baseline (6h)
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={scoring || !summary?.activeModel}
            onClick={async () => {
              setScoring(true);
              try {
                await fetch("/api/ml/score-live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
                await fetchData();
              } finally {
                setScoring(false);
              }
            }}
          >
            {scoring ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Score live
          </Button>
        </CardContent>
      </Card>

      {summary && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
              <CardDescription>Dataset, active model, and live scoring.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm">Dataset: <span className="font-mono font-medium">{summary.datasetSize}</span> examples</p>
              {summary.activeModel && (
                <p className="text-sm">
                  Active model: <span className="font-mono">{summary.activeModel.id.slice(0, 8)}…</span> · {summary.activeModel.targetLabel} · status <span className="font-medium">{summary.activeModel.status}</span>
                </p>
              )}
              <p className="text-sm">Live-scored rows: <span className="font-mono">{summary.liveScoredCount}</span> · Last scoring: {summary.latestScoringTime ? new Date(summary.latestScoringTime).toLocaleString() : "—"}</p>
              {summary.latestRun && (
                <p className="text-sm text-muted-foreground">
                  Latest run: <span className="font-mono">{summary.latestRun.modelType}</span> / <span className="font-mono">{summary.latestRun.targetLabel}</span> · status <span className="font-medium">{summary.latestRun.status}</span> · {new Date(summary.latestRun.createdAt).toLocaleString()}
                </p>
              )}
            </CardContent>
          </Card>

          {summary.latestRun && (summary.latestRun.trainCount != null || summary.latestRun.validatedFrom) && (
            <Card>
              <CardHeader>
                <CardTitle>Time-split validation (latest run)</CardTitle>
                <CardDescription>Train on oldest examples, validate on newest.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>Train: <span className="font-mono">{summary.latestRun.trainCount ?? "—"}</span> examples · {summary.latestRun.trainedFrom ? new Date(summary.latestRun.trainedFrom).toLocaleString() : "—"} → {summary.latestRun.trainedTo ? new Date(summary.latestRun.trainedTo).toLocaleString() : "—"}</p>
                <p>Validation: <span className="font-mono">{summary.latestRun.validationCount ?? "—"}</span> examples · {summary.latestRun.validatedFrom ? new Date(summary.latestRun.validatedFrom).toLocaleString() : "—"} → {summary.latestRun.validatedTo ? new Date(summary.latestRun.validatedTo).toLocaleString() : "—"}</p>
                <p>Leakage check: {summary.latestRun.leakageCheckPassed === true ? "Passed" : summary.latestRun.leakageCheckPassed === false ? "Failed" : "—"}</p>
              </CardContent>
            </Card>
          )}

          {summary.metrics && (
            <Card>
              <CardHeader>
                <CardTitle>Metrics (validation)</CardTitle>
                <CardDescription>Accuracy, F1, ROC-AUC, calibration.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <div className="rounded border p-3">
                    <p className="text-xs text-muted-foreground">Accuracy</p>
                    <p className="text-lg font-mono font-medium">{(summary.metrics.accuracy * 100).toFixed(1)}%</p>
                  </div>
                  <div className="rounded border p-3">
                    <p className="text-xs text-muted-foreground">Precision</p>
                    <p className="text-lg font-mono font-medium">{(summary.metrics.precision * 100).toFixed(1)}%</p>
                  </div>
                  <div className="rounded border p-3">
                    <p className="text-xs text-muted-foreground">Recall</p>
                    <p className="text-lg font-mono font-medium">{(summary.metrics.recall * 100).toFixed(1)}%</p>
                  </div>
                  <div className="rounded border p-3">
                    <p className="text-xs text-muted-foreground">F1</p>
                    <p className="text-lg font-mono font-medium">{(summary.metrics.f1 * 100).toFixed(1)}%</p>
                  </div>
                  <div className="rounded border p-3">
                    <p className="text-xs text-muted-foreground">ROC-AUC</p>
                    <p className="text-lg font-mono font-medium">{(summary.metrics.rocAuc * 100).toFixed(1)}%</p>
                  </div>
                  <div className="rounded border p-3">
                    <p className="text-xs text-muted-foreground">Calibration MAE</p>
                    <p className="text-lg font-mono font-medium">{summary.calibration ? summary.calibration.mae.toFixed(3) : "—"}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {summary.comparison && summary.comparison.topN.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Heuristic vs ML (validation window)</CardTitle>
                <CardDescription>Top-N hit rate and average forward return on validation set only.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 px-2 font-medium">Top N</th>
                        <th className="text-right py-2 px-2 font-medium">Heuristic hit %</th>
                        <th className="text-right py-2 px-2 font-medium">ML hit %</th>
                        <th className="text-right py-2 px-2 font-medium">H avg return</th>
                        <th className="text-right py-2 px-2 font-medium">ML avg return</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.comparison.topN.map((t) => (
                        <tr key={t.n} className="border-b border-border/50">
                          <td className="py-2 px-2">{t.n}</td>
                          <td className="py-2 px-2 text-right font-mono">{(t.heuristicHitRate * 100).toFixed(0)}%</td>
                          <td className="py-2 px-2 text-right font-mono">{(t.mlHitRate * 100).toFixed(0)}%</td>
                          <td className="py-2 px-2 text-right font-mono">{t.heuristicAvgReturn != null ? (t.heuristicAvgReturn * 100).toFixed(1) + "%" : "—"}</td>
                          <td className="py-2 px-2 text-right font-mono">{t.mlAvgReturn != null ? (t.mlAvgReturn * 100).toFixed(1) + "%" : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {summary.featureImportance && summary.featureImportance.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Feature importance</CardTitle>
                <CardDescription>Coefficients (logistic regression).</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm max-h-64 overflow-y-auto">
                  {summary.featureImportance.map((f) => (
                    <li key={f.name} className="flex justify-between gap-4">
                      <span className="truncate">{f.name}</span>
                      <span className="font-mono tabular-nums shrink-0">{f.coefficient.toFixed(4)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <CardDescription>Model runs with status. Approve or activate to use for live scoring.</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet. Build dataset and train baseline.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono">{r.modelType}</span>
                    <span className="text-muted-foreground">{r.targetLabel}</span>
                    <span className={cn(
                      "rounded px-1.5 py-0.5 text-xs font-medium",
                      r.status === "ACTIVE" && "bg-green-500/20 text-green-700 dark:text-green-400",
                      r.status === "APPROVED" && "bg-blue-500/20 text-blue-700 dark:text-blue-400",
                      r.status === "TRAINED" && "bg-muted",
                      r.status === "VALIDATED" && "bg-muted",
                      r.status === "REJECTED" && "bg-red-500/20 text-red-700 dark:text-red-400"
                    )}>
                      {r.status}
                    </span>
                    {r.leakageCheckPassed === true && <span className="text-xs text-green-600 dark:text-green-400">Leak OK</span>}
                  </div>
                  <div className="flex items-center gap-1">
                    {r.status !== "APPROVED" && r.status !== "REJECTED" && (
                      <Button variant="outline" size="sm" disabled={actionRunId !== null} onClick={() => runAction(r.id, "approve")}>
                        {actionRunId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Approve"}
                      </Button>
                    )}
                    {r.status !== "REJECTED" && (
                      <Button variant="outline" size="sm" disabled={actionRunId !== null} onClick={() => runAction(r.id, "reject")}>
                        Reject
                      </Button>
                    )}
                    {(r.status === "APPROVED" || r.status === "TRAINED" || r.status === "VALIDATED") && (
                      <Button variant="outline" size="sm" disabled={actionRunId !== null} onClick={() => runAction(r.id, "activate")}>
                        {actionRunId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Activate"}
                      </Button>
                    )}
                  </div>
                  <div className="w-full text-xs text-muted-foreground">
                    Train {r.trainCount ?? "—"} · Val {r.validationCount ?? "—"} · {new Date(r.createdAt).toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
