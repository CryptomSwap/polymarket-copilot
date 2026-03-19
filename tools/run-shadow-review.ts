/**
 * Local review utility: fetch shadow/calibration APIs, save raw JSON, generate markdown report.
 * Read-only; no trading behavior change. Run with app at localhost:3000 (or REVIEW_BASE_URL).
 */

import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.REVIEW_BASE_URL ?? "http://localhost:3000";

const ENDPOINTS: { name: string; path: string }[] = [
  { name: "ml-shadow-disagreement", path: "/api/ops/ml-shadow-disagreement" },
  { name: "shadow-evaluation", path: "/api/ops/shadow-evaluation" },
  { name: "shadow-analysis", path: "/api/ops/shadow-analysis" },
  { name: "execution-quality-calibration", path: "/api/ops/execution-quality-calibration" },
  { name: "portfolio-risk-calibration", path: "/api/ops/portfolio-risk-calibration" },
  { name: "runtime-policy-calibration", path: "/api/ops/runtime-policy-calibration" },
  { name: "decision-calibration", path: "/api/ops/decision-calibration" },
];

const OUT_DIR = path.join(process.cwd(), "audit-dumps", "manual-shadow-review");
const REPORT_PATH = path.join(process.cwd(), "docs", "MANUAL_SHADOW_REVIEW.md");

interface FetchResult {
  name: string;
  ok: boolean;
  data: unknown;
  error?: string;
}

async function fetchJson(url: string): Promise<{ ok: boolean; data: unknown; error?: string }> {
  try {
    const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, data, error: `HTTP ${res.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, data: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function extractRecommendationsByType(recommendations: unknown[], type: string): unknown[] {
  if (!Array.isArray(recommendations)) return [];
  return recommendations.filter((r: unknown) => (r as { recommendation?: string })?.recommendation === type);
}

function buildMarkdown(results: FetchResult[], timestamp: string): string {
  const lines: string[] = [];
  lines.push("# Manual Shadow Review");
  lines.push("");
  lines.push(`**Generated:** ${timestamp}`);
  lines.push("");

  const byName = new Map(results.map((r) => [r.name, r]));

  lines.push("## Endpoint status");
  lines.push("");
  for (const r of results) {
    lines.push(`- \`${r.name}\`: ${r.ok ? "OK" : "FAILED"}${r.error ? ` (${r.error})` : ""}`);
  }
  lines.push("");

  const disagreement = byName.get("ml-shadow-disagreement");
  if (disagreement?.ok && disagreement.data && typeof disagreement.data === "object") {
    const d = disagreement.data as Record<string, unknown>;
    lines.push("## Disagreement summary");
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| totalRows | ${d.totalRows ?? "—"} |`);
    lines.push(`| evaluatedRows | ${d.evaluatedRows ?? "—"} |`);
    lines.push(`| agreementRate | ${d.agreementRate != null ? Number(d.agreementRate).toFixed(2) : "—"} |`);
    lines.push(`| disagreementRate | ${d.disagreementRate != null ? Number(d.disagreementRate).toFixed(2) : "—"} |`);
    lines.push(`| modelId | ${d.modelId ?? "—"} |`);
    lines.push("");
    const cohortStats = d.cohortStats as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(cohortStats) && cohortStats.length > 0) {
      const sorted = [...cohortStats].sort((a, b) => (Number(b.evaluated) || 0) - (Number(a.evaluated) || 0));
      lines.push("### Top cohorts by evaluated count");
      lines.push("");
      lines.push("| Staged | Band | Total | Evaluated | Good block | Bad block | Good allow | Bad allow | Staged right | Shadow right | Usefulness |");
      lines.push("|--------|------|-------|-----------|------------|-----------|------------|-----------|--------------|--------------|-------------|");
      for (const c of sorted.slice(0, 9)) {
        const k = c.cohortKey as Record<string, string> | undefined;
        const staged = k?.stagedCohort ?? "—";
        const band = k?.shadowBand ?? "—";
        lines.push(`| ${staged} | ${band} | ${c.total ?? 0} | ${c.evaluated ?? 0} | ${c.goodBlock ?? 0} | ${c.badBlock ?? 0} | ${c.goodAllow ?? 0} | ${c.badAllow ?? 0} | ${c.stagedRightCount ?? 0} | ${c.shadowRightCount ?? 0} | ${c.usefulnessSummary ?? "—"} |`);
      }
      lines.push("");
    }
  } else {
    lines.push("## Disagreement summary");
    lines.push("");
    lines.push("*(No data — endpoint failed or missing.)*");
    lines.push("");
  }

  const shadowEval = byName.get("shadow-evaluation");
  if (shadowEval?.ok && shadowEval.data && typeof shadowEval.data === "object") {
    const s = (shadowEval.data as Record<string, unknown>).summary as Record<string, unknown> | undefined;
    if (s) {
      lines.push("## Shadow evaluation summary");
      lines.push("");
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| totalCandidates | ${s.totalCandidates ?? "—"} |`);
      lines.push(`| blockedCandidates | ${s.blockedCandidates ?? "—"} |`);
      lines.push(`| allowedCandidates | ${s.allowedCandidates ?? "—"} |`);
      lines.push(`| evaluatedCandidates | ${s.evaluatedCandidates ?? "—"} |`);
      lines.push(`| goodBlocks | ${s.goodBlocks ?? "—"} |`);
      lines.push(`| badBlocks | ${s.badBlocks ?? "—"} |`);
      lines.push(`| goodAllows | ${s.goodAllows ?? "—"} |`);
      lines.push(`| badAllows | ${s.badAllows ?? "—"} |`);
      lines.push(`| averageMarkout24h | ${s.averageMarkout24h != null ? s.averageMarkout24h : "—"} |`);
      lines.push("");
    }
  } else {
    lines.push("## Shadow evaluation summary");
    lines.push("");
    lines.push("*(No data.)*");
    lines.push("");
  }

  const calibrationEndpoints = [
    "execution-quality-calibration",
    "portfolio-risk-calibration",
    "runtime-policy-calibration",
    "decision-calibration",
  ];
  lines.push("## Calibration summaries");
  lines.push("");
  for (const name of calibrationEndpoints) {
    const r = byName.get(name);
    if (!r?.ok || !r.data || typeof r.data !== "object") {
      lines.push(`### ${name}`);
      lines.push("");
      lines.push("*(No data.)*");
      lines.push("");
      continue;
    }
    const recs = (r.data as Record<string, unknown>).recommendations as unknown[] | undefined;
    const loosen = extractRecommendationsByType(recs ?? [], "review_loosen");
    const tighten = extractRecommendationsByType(recs ?? [], "review_tighten");
    const keep = extractRecommendationsByType(recs ?? [], "keep_strict");
    lines.push(`### ${name}`);
    lines.push("");
    lines.push(`- **Top review_loosen:** ${loosen.length} (${(loosen as Record<string, unknown>[]).slice(0, 5).map((x) => x.subtype ?? x.reasonGroup).join(", ") || "—"})`);
    lines.push(`- **Top review_tighten:** ${tighten.length} (${(tighten as Record<string, unknown>[]).slice(0, 5).map((x) => x.subtype ?? x.reasonGroup).join(", ") || "—"})`);
    lines.push(`- **Top keep_strict:** ${keep.length} (${(keep as Record<string, unknown>[]).slice(0, 5).map((x) => x.subtype ?? x.reasonGroup).join(", ") || "—"})`);
    lines.push("");
  }

  const analysis = byName.get("shadow-analysis");
  if (analysis?.ok && analysis.data && typeof analysis.data === "object") {
    const cal = (analysis.data as Record<string, unknown>).calibrationSuggestions as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(cal) && cal.length > 0) {
      lines.push("### shadow-analysis calibration suggestions");
      lines.push("");
      for (const c of cal) {
        lines.push(`- **${c.reasonGroup ?? "—"}**: ${c.suggestion ?? "—"} — ${c.summary ?? ""}`);
      }
      lines.push("");
    }
  }

  lines.push("## Recommended next manual review focus");
  lines.push("");
  lines.push("1. **Disagreement:** If disagreement rate is high, inspect cohorts where `shadow_more_right` — shadow ML may be flagging missed opportunities or bad allows.");
  lines.push("2. **Calibration:** Prioritize subtypes with `review_loosen` or `review_tighten` for threshold review; `keep_strict` suggests current blocking is beneficial.");
  lines.push("3. **Shadow evaluation:** Compare good_block vs bad_block and good_allow vs bad_allow to balance block vs allow decisions.");
  lines.push("");

  return lines.join("\n");
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  const timestamp = new Date().toISOString();
  const results: FetchResult[] = [];

  for (const ep of ENDPOINTS) {
    const url = `${BASE_URL}${ep.path}`;
    const { ok, data, error } = await fetchJson(url);
    results.push({ name: ep.name, ok, data, error });
    const outFile = path.join(OUT_DIR, `${ep.name}.json`);
    fs.writeFileSync(outFile, JSON.stringify(data, null, 2), "utf-8");
    console.log(`${ep.name}: ${ok ? "OK" : "FAILED"}${error ? ` (${error})` : ""}`);
  }

  const md = buildMarkdown(results, timestamp);
  ensureDir(path.dirname(REPORT_PATH));
  fs.writeFileSync(REPORT_PATH, md, "utf-8");
  console.log(`\nWrote raw JSON to ${OUT_DIR}`);
  console.log(`Wrote report to ${REPORT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
