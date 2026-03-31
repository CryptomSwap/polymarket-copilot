/**
 * Read-only diagnostic: reco_thesis-tagged PaperTrade rows — outcome column fill vs close pipeline.
 * No schema changes, no writes to DB (only reads + report file).
 *
 * Parsing of strategyFamily / strategyVariant / hypothesisType mirrors
 * tools/create-reco-thesis-family-report.ts (parseRecoFields).
 *
 * Run: npx tsx tools/debug-reco-thesis-outcome-readiness.ts
 * Env: RECO_THESIS_READINESS_DAYS (default 14), RECO_THESIS_READINESS_MAX_FETCH (default 8000)
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const OUT_DIR = path.join(process.cwd(), "dump", "repo-exploration-pack");
const OUT_MD = path.join(OUT_DIR, "22-reco-thesis-outcome-readiness.md");

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const DAYS = envInt("RECO_THESIS_READINESS_DAYS", 14, 1, 3650);
const MAX_FETCH = envInt("RECO_THESIS_READINESS_MAX_FETCH", 8000, 100, 100_000);
const TAG_FAMILY = "reco_thesis";
const TABLE_LIMIT = 50;

type PtRow = {
  id: string;
  entryTime: Date;
  exitTime: Date | null;
  status: string;
  botType: string;
  score: number;
  metadataJson: string | null;
  markout12h: string | null;
  pnlPct: string | null;
  pnlDollars: string | null;
};

type RecoFields = {
  strategyFamily: string | null;
  strategyVariant: string | null;
  hypothesisType: string | null;
};

/** Same logic as tools/create-reco-thesis-family-report.ts */
function parseNum(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** Same logic as tools/create-reco-thesis-family-report.ts */
function parseRecoFields(raw: string | null): RecoFields {
  const empty: RecoFields = { strategyFamily: null, strategyVariant: null, hypothesisType: null };
  if (!raw) return empty;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const nest = (o.recoThesis ?? o.reco_thesis) as Record<string, unknown> | undefined;
    const pick = (k: string): string | null => {
      const v = o[k] ?? nest?.[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
      return null;
    };
    return {
      strategyFamily: pick("strategyFamily"),
      strategyVariant: pick("strategyVariant"),
      hypothesisType: pick("hypothesisType"),
    };
  } catch {
    return empty;
  }
}

function isTaggedRecoThesis(row: PtRow): boolean {
  return parseRecoFields(row.metadataJson).strategyFamily === TAG_FAMILY;
}

function hasAnyNumericOutcome(row: PtRow): boolean {
  return (
    parseNum(row.markout12h) != null ||
    parseNum(row.pnlPct) != null ||
    parseNum(row.pnlDollars) != null
  );
}

function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

type StatusAgg = { n: number; withExitTime: number; withMarkout12h: number; withNumericOutcome: number };
type HypoAgg = StatusAgg;

function bumpAgg(agg: StatusAgg, row: PtRow): void {
  agg.n++;
  if (row.exitTime != null) agg.withExitTime++;
  if (row.markout12h != null && String(row.markout12h).trim() !== "") agg.withMarkout12h++;
  if (hasAnyNumericOutcome(row)) agg.withNumericOutcome++;
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const since = new Date(Date.now() - DAYS * 86_400_000);
  let fetched: PtRow[] = [];
  let dbError: string | null = null;

  try {
    fetched = (await prisma.paperTrade.findMany({
      where: { entryTime: { gte: since } },
      orderBy: { entryTime: "desc" },
      take: MAX_FETCH,
      select: {
        id: true,
        entryTime: true,
        exitTime: true,
        status: true,
        botType: true,
        score: true,
        metadataJson: true,
        markout12h: true,
        pnlPct: true,
        pnlDollars: true,
      },
    })) as PtRow[];
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  const tagged = fetched.filter(isTaggedRecoThesis);
  tagged.sort((a, b) => b.entryTime.getTime() - a.entryTime.getTime());

  const byStatus = new Map<string, StatusAgg>();
  const byHypo = new Map<string, HypoAgg>();

  for (const row of tagged) {
    const st = row.status?.trim() || "(missing)";
    const r = parseRecoFields(row.metadataJson);
    const hk = r.hypothesisType ?? "(missing)";

    if (!byStatus.has(st)) byStatus.set(st, { n: 0, withExitTime: 0, withMarkout12h: 0, withNumericOutcome: 0 });
    bumpAgg(byStatus.get(st)!, row);

    if (!byHypo.has(hk)) byHypo.set(hk, { n: 0, withExitTime: 0, withMarkout12h: 0, withNumericOutcome: 0 });
    bumpAgg(byHypo.get(hk)!, row);
  }

  const statusCounts = new Map<string, number>();
  let withExitTime = 0;
  let withMarkout12h = 0;
  let withPnlPct = 0;
  let withPnlDollars = 0;

  for (const row of tagged) {
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
    if (row.exitTime != null) withExitTime++;
    if (row.markout12h != null && String(row.markout12h).trim() !== "") withMarkout12h++;
    if (row.pnlPct != null && String(row.pnlPct).trim() !== "") withPnlPct++;
    if (row.pnlDollars != null && String(row.pnlDollars).trim() !== "") withPnlDollars++;
  }

  const top50 = tagged.slice(0, TABLE_LIMIT);

  const md: string[] = [];
  md.push("# Reco-thesis outcome readiness (PaperTrade)");
  md.push("");
  md.push(`Generated: **${new Date().toISOString()}**`);
  md.push("");
  md.push("## Parameters");
  md.push(
    `- Window: last **${DAYS}** days by \`entryTime\`, fetch up to **${MAX_FETCH}** rows (newest first), then keep rows where \`strategyFamily\` is **${TAG_FAMILY}** (root or nested \`recoThesis\` / \`reco_thesis\`, same \`parseRecoFields\` as \`create-reco-thesis-family-report.ts\`).`
  );
  md.push(`- Tagged rows in this run: **${tagged.length}** (of **${fetched.length}** fetched).`);
  if (dbError) {
    const shortErr = dbError.replace(/\s+/g, " ").trim().slice(0, 400);
    md.push(`- **Database error:** ${escCell(shortErr)}`);
  }
  md.push("");

  md.push("## 1. Totals (tagged only)");
  md.push(`| Metric | Count |`);
  md.push(`|--------|-------|`);
  md.push(`| Total tagged rows | ${tagged.length} |`);
  md.push("");

  md.push("## 2. Counts by status");
  md.push(`| status | n |`);
  md.push(`|--------|---|`);
  const statusSorted = [...statusCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [k, v] of statusSorted) {
    md.push(`| ${escCell(k)} | ${v} |`);
  }
  if (!statusSorted.length) md.push("| — | 0 |");
  md.push("");

  md.push("## 3. Non-null outcome columns (tagged)");
  md.push(`| Column | Count |`);
  md.push(`|--------|-------|`);
  md.push(`| exitTime | ${withExitTime} |`);
  md.push(`| markout12h (non-null non-empty) | ${withMarkout12h} |`);
  md.push(`| pnlPct (non-null non-empty) | ${withPnlPct} |`);
  md.push(`| pnlDollars (non-null non-empty) | ${withPnlDollars} |`);
  md.push("");

  md.push(`## 4. Sample table (most recent ${Math.min(TABLE_LIMIT, top50.length)} tagged)`);
  md.push(
    "| id | entryTime | exitTime | status | botType | score | strategyVariant | hypothesisType | markout12h | pnlPct | pnlDollars |"
  );
  md.push("|----|-----------|----------|--------|---------|-------|-----------------|----------------|------------|--------|------------|");
  for (const row of top50) {
    const r = parseRecoFields(row.metadataJson);
    md.push(
      `| ${escCell(row.id)} | ${row.entryTime.toISOString()} | ${row.exitTime?.toISOString() ?? ""} | ${escCell(row.status)} | ${escCell(row.botType)} | ${row.score} | ${escCell(r.strategyVariant ?? "")} | ${escCell(r.hypothesisType ?? "")} | ${escCell(row.markout12h ?? "")} | ${escCell(row.pnlPct ?? "")} | ${escCell(row.pnlDollars ?? "")} |`
    );
  }
  md.push("");

  md.push("## 5. Grouped by status");
  md.push("| status | n | with exitTime | with markout12h | with any numeric outcome* |");
  md.push("|--------|---|---------------|-----------------|---------------------------|");
  const statusAggSorted = [...byStatus.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  for (const [k, a] of statusAggSorted) {
    md.push(
      `| ${escCell(k)} | ${a.n} | ${a.withExitTime} | ${a.withMarkout12h} | ${a.withNumericOutcome} |`
    );
  }
  if (!statusAggSorted.length) md.push("| — | 0 | 0 | 0 | 0 |");
  md.push("");
  md.push(
    "_\\*Numeric outcome: at least one of `markout12h`, `pnlPct`, `pnlDollars` parses to a finite number (same `parseNum` as family report)._"
  );
  md.push("");

  md.push("## 6. Grouped by hypothesisType");
  md.push("| hypothesisType | n | with exitTime | with markout12h | with any numeric outcome* |");
  md.push("|------------------|---|---------------|-----------------|---------------------------|");
  const hypoSorted = [...byHypo.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  for (const [k, a] of hypoSorted) {
    md.push(
      `| ${escCell(k)} | ${a.n} | ${a.withExitTime} | ${a.withMarkout12h} | ${a.withNumericOutcome} |`
    );
  }
  if (!hypoSorted.length) md.push("| — | 0 | 0 | 0 | 0 |");
  md.push("");

  md.push("## Note");
  md.push(
    "If closes work but family report shows **n/a** outcomes, check whether rows are **closed** with **markout12h** / **pnlPct** populated; open rows or closes without markout will read as n/a in aggregates."
  );
  md.push("");

  await fs.writeFile(OUT_MD, md.join("\n"), "utf8");

  console.log("[debug-reco-thesis-outcome-readiness]", {
    out: OUT_MD,
    tagged: tagged.length,
    fetched: fetched.length,
    byStatus: Object.fromEntries(statusSorted),
    exitTime: withExitTime,
    markout12h: withMarkout12h,
    pnlPct: withPnlPct,
    pnlDollars: withPnlDollars,
    dbError,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
