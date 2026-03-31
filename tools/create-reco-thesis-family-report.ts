/**
 * Read-only report: whether PaperTrade.metadataJson carries reco-thesis structure
 * (strategyFamily / strategyVariant / hypothesisType) and coarse outcome/score mix by segment.
 * Does not change runtime, schema, admission, or trading logic.
 *
 * Run: npx tsx tools/create-reco-thesis-family-report.ts
 * Env: RECO_THESIS_REPORT_DAYS (default 14), RECO_THESIS_REPORT_MAX_TRADES (default 1200),
 *      RECO_THESIS_REPORT_MIN_SAMPLES (default 5), RECO_THESIS_REPORT_LINK_WINDOW_MINUTES (optional;
 *      when > 0, avg markout / pnl / hit-rate rows must be status=closed with exitTime within that
 *      many minutes after entryTime).
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { parseOpenAttributionFromMetadataJson } from "../lib/paper-trading/paper-trade-open-attribution";

const OUT_DIR = path.join(process.cwd(), "dump", "repo-exploration-pack");
const OUT_MD = path.join(OUT_DIR, "21-reco-thesis-family-report.md");

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const DAYS = envInt("RECO_THESIS_REPORT_DAYS", 14, 1, 3650);
const MAX_TRADES = envInt("RECO_THESIS_REPORT_MAX_TRADES", 1200, 1, 50_000);
const MIN_SAMPLES = envInt("RECO_THESIS_REPORT_MIN_SAMPLES", 5, 1, MAX_TRADES);
const LINK_WIN_RAW = process.env.RECO_THESIS_REPORT_LINK_WINDOW_MINUTES?.trim();
const LINK_WINDOW_MS =
  LINK_WIN_RAW && Number.isFinite(Number(LINK_WIN_RAW)) && Number(LINK_WIN_RAW) > 0
    ? Number(LINK_WIN_RAW) * 60_000
    : null;

const RECO_THESIS_FAMILY = "reco_thesis";

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

function parseNum(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

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

function resolvedScore(row: PtRow): number | null {
  const parsed = parseOpenAttributionFromMetadataJson(row.metadataJson);
  const adm = parsed?.paperShadowScoreCalibration?.admissionScore;
  if (adm != null && Number.isFinite(adm)) return adm;
  return Number.isFinite(row.score) ? row.score : null;
}

/** PnL for aggregates: numeric `pnlDollars` if present, else numeric `pnlPct` (not `markout12h`). */
function pnlProxy(row: PtRow): number | null {
  return parseNum(row.pnlDollars) ?? parseNum(row.pnlPct);
}

function outcomeEligible(row: PtRow): boolean {
  if (LINK_WINDOW_MS == null) return true;
  if (row.status !== "closed" || !row.exitTime) return false;
  return row.exitTime.getTime() - row.entryTime.getTime() <= LINK_WINDOW_MS;
}

/** First-available numeric among markout12h → pnlPct → pnlDollars; null if none or not outcome-eligible. */
function hitFromRow(row: PtRow): boolean | null {
  if (!outcomeEligible(row)) return null;
  const m = parseNum(row.markout12h);
  if (m != null) return m > 0;
  const p = parseNum(row.pnlPct);
  if (p != null) return p > 0;
  const d = parseNum(row.pnlDollars);
  if (d != null) return d > 0;
  return null;
}

function hasAnyNumericOutcomeField(row: PtRow): boolean {
  return (
    parseNum(row.markout12h) != null ||
    parseNum(row.pnlPct) != null ||
    parseNum(row.pnlDollars) != null
  );
}

function nonEmptyStrCol(v: string | null | undefined): boolean {
  return v != null && String(v).trim() !== "";
}

type Agg = {
  rows: PtRow[];
  markouts: number[];
  pnls: number[];
  scores: number[];
  hits: number;
  hitDenom: number;
  botMix: Map<string, number>;
};

function makeAgg(): Agg {
  return { rows: [], markouts: [], pnls: [], scores: [], hits: 0, hitDenom: 0, botMix: new Map() };
}

function ingestRow(a: Agg, row: PtRow): void {
  a.rows.push(row);
  const sc = resolvedScore(row);
  if (sc != null) a.scores.push(sc);
  const bt = row.botType?.trim() || "(missing)";
  a.botMix.set(bt, (a.botMix.get(bt) ?? 0) + 1);
  if (!outcomeEligible(row)) return;
  const mo = parseNum(row.markout12h);
  if (mo != null) a.markouts.push(mo);
  const pn = pnlProxy(row);
  if (pn != null) a.pnls.push(pn);
  const h = hitFromRow(row);
  if (h !== null) {
    a.hitDenom++;
    if (h) a.hits++;
  }
}

function avg(a: number[]): number | null {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

function fmtNum(n: number | null, d = 4): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return n.toFixed(d);
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${(n * 100).toFixed(1)}%`;
}

function sortCountEntries(m: Map<string, number>): [string, number][] {
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function botMixLine(mix: Map<string, number>): string {
  const parts = sortCountEntries(mix).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(", ") : "n/a";
}

function tableVariantHypo(title: string, entries: [string, Agg][], minSamples: number): string[] {
  const lines: string[] = [`### ${title}`];
  const ok = entries.filter(([, a]) => a.rows.length >= minSamples);
  lines.push("| key | n | n_outcomes | avg markout | avg pnl | hit rate | avg score | botType mix |");
  lines.push("|-----|---|------------|-------------|---------|----------|-----------|-------------|");
  for (const [k, a] of ok.sort((x, y) => y[1].rows.length - x[1].rows.length)) {
    const hr = a.hitDenom ? a.hits / a.hitDenom : null;
    lines.push(
      `| ${k} | ${a.rows.length} | ${a.hitDenom} | ${fmtNum(avg(a.markouts))} | ${fmtNum(avg(a.pnls))} | ${fmtPct(hr)} | ${fmtNum(avg(a.scores))} | ${botMixLine(a.botMix)} |`
    );
  }
  if (!ok.length) lines.push("| — | — | — | — | — | — | — | — |");
  lines.push(
    "_avg markout = mean of numeric `markout12h` only (rows without it are omitted from that average). avg pnl = mean of numeric `pnlDollars` if present else numeric `pnlPct`. n_outcomes = outcome-eligible rows with any first-available numeric outcome (same chain as hit rate)._"
  );
  lines.push("");
  return lines;
}

type CohortStats = {
  n: number;
  nOutcomes: number;
  avgMarkout: number | null;
  avgPnl: number | null;
  hitRate: number | null;
  avgScore: number | null;
};

function cohortStats(subset: PtRow[]): CohortStats {
  const markouts: number[] = [];
  const pnls: number[] = [];
  const scores: number[] = [];
  let hits = 0;
  let hitDenom = 0;
  for (const row of subset) {
    const sc = resolvedScore(row);
    if (sc != null) scores.push(sc);
    if (!outcomeEligible(row)) continue;
    const mo = parseNum(row.markout12h);
    if (mo != null) markouts.push(mo);
    const pn = pnlProxy(row);
    if (pn != null) pnls.push(pn);
    const h = hitFromRow(row);
    if (h !== null) {
      hitDenom++;
      if (h) hits++;
    }
  }
  return {
    n: subset.length,
    nOutcomes: hitDenom,
    avgMarkout: avg(markouts),
    avgPnl: avg(pnls),
    hitRate: hitDenom ? hits / hitDenom : null,
    avgScore: avg(scores),
  };
}

function fmtCohortRow(label: string, s: CohortStats): string {
  return `| ${label} | ${s.n} | ${s.nOutcomes} | ${fmtNum(s.avgMarkout)} | ${fmtNum(s.avgPnl)} | ${fmtPct(s.hitRate)} | ${fmtNum(s.avgScore)} |`;
}

function recoThesisCohortSection(tagged: PtRow[]): string[] {
  const lines: string[] = [
    "## 4b. Reco_thesis cohort (`strategyFamily = reco_thesis`)",
    "",
    "### Overall",
    "| cohort | n | n_outcomes | avg markout | avg pnl | hit rate | avg score |",
    "|--------|---|------------|-------------|---------|----------|-----------|",
    fmtCohortRow("all tagged", cohortStats(tagged)),
    "",
    "### By botType",
    "| botType | n | n_outcomes | avg markout | avg pnl | hit rate | avg score |",
    "|---------|---|------------|-------------|---------|----------|-----------|",
  ];
  const byBot = new Map<string, PtRow[]>();
  for (const row of tagged) {
    const k = row.botType?.trim() || "(missing)";
    const arr = byBot.get(k) ?? [];
    arr.push(row);
    byBot.set(k, arr);
  }
  for (const k of [...byBot.keys()].sort((a, b) => (byBot.get(b)!.length - byBot.get(a)!.length) || a.localeCompare(b))) {
    lines.push(fmtCohortRow(k, cohortStats(byBot.get(k)!)));
  }
  if (byBot.size === 0) lines.push("| — | 0 | 0 | n/a | n/a | n/a | n/a |");
  lines.push("");
  lines.push("### By hypothesisType");
  lines.push("| hypothesisType | n | n_outcomes | avg markout | avg pnl | hit rate | avg score |");
  lines.push("|------------------|---|------------|-------------|---------|----------|-----------|");
  const byHypo = new Map<string, PtRow[]>();
  for (const row of tagged) {
    const hk = parseRecoFields(row.metadataJson).hypothesisType ?? "(missing)";
    const arr = byHypo.get(hk) ?? [];
    arr.push(row);
    byHypo.set(hk, arr);
  }
  for (const k of [...byHypo.keys()].sort((a, b) => (byHypo.get(b)!.length - byHypo.get(a)!.length) || a.localeCompare(b))) {
    lines.push(fmtCohortRow(k, cohortStats(byHypo.get(k)!)));
  }
  if (byHypo.size === 0) lines.push("| — | 0 | 0 | n/a | n/a | n/a | n/a |");
  lines.push("");
  return lines;
}

function conclude(args: {
  total: number;
  withFamily: number;
  byVariant: Map<string, Agg>;
  byHypo: Map<string, Agg>;
  minSamples: number;
}): { tag: "informative" | "flat" | "too sparse"; bullets: string[] } {
  const { total, withFamily, byVariant, byHypo, minSamples } = args;
  const variantOk = [...byVariant.entries()].filter(
    ([k, a]) => k !== "(missing)" && a.rows.length >= minSamples
  );
  const hypoOk = [...byHypo.entries()].filter(([k, a]) => k !== "(missing)" && a.rows.length >= minSamples);
  const bullets: string[] = [];

  if (total < minSamples) {
    bullets.push(`Only **${total}** trades in window (< minSamples=${minSamples}).`);
    return { tag: "too sparse", bullets };
  }
  if (withFamily < minSamples) {
    bullets.push(
      `**${withFamily}** rows carry \`strategyFamily\` (< minSamples=${minSamples}); metadata is sparse for this window.`
    );
    return { tag: "too sparse", bullets };
  }
  if (variantOk.length < 2 && hypoOk.length < 2) {
    bullets.push(
      `At most one non-missing segment meets **n ≥ ${minSamples}** for variant/hypothesis; cross-segment comparison is weak.`
    );
    return { tag: "too sparse", bullets };
  }

  const avgs = variantOk
    .map(([, a]) => avg(a.markouts))
    .filter((x): x is number => x != null && Number.isFinite(x));
  if (avgs.length >= 2) {
    const spread = Math.max(...avgs) - Math.min(...avgs);
    bullets.push(`Largest vs smallest segment mean markout (\`markout12h\` only) spread ≈ **${fmtNum(spread, 6)}**.`);
    if (spread < 1e-5) {
      bullets.push("Outcomes are very similar across labeled variants (flat).");
      return { tag: "flat", bullets };
    }
  }
  bullets.push("Multiple segments meet the sample floor; use tables for structure vs outcome.");
  return { tag: "informative", bullets };
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const since = new Date(Date.now() - DAYS * 86_400_000);
  let rows: PtRow[] = [];
  let dbError: string | null = null;

  try {
    rows = (await prisma.paperTrade.findMany({
      where: { entryTime: { gte: since } },
      orderBy: { entryTime: "desc" },
      take: MAX_TRADES,
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

  const taggedRecoThesis = rows.filter(
    (row) => parseRecoFields(row.metadataJson).strategyFamily === RECO_THESIS_FAMILY
  );
  let recoDbgExitTime = 0;
  let recoDbgMarkout12h = 0;
  let recoDbgPnlPct = 0;
  let recoDbgPnlDollars = 0;
  let recoDbgAnyNumericOutcome = 0;
  for (const row of taggedRecoThesis) {
    if (row.exitTime != null) recoDbgExitTime++;
    if (nonEmptyStrCol(row.markout12h)) recoDbgMarkout12h++;
    if (nonEmptyStrCol(row.pnlPct)) recoDbgPnlPct++;
    if (nonEmptyStrCol(row.pnlDollars)) recoDbgPnlDollars++;
    if (hasAnyNumericOutcomeField(row)) recoDbgAnyNumericOutcome++;
  }

  const byFamily = new Map<string, Agg>();
  const byVariant = new Map<string, Agg>();
  const byHypo = new Map<string, Agg>();

  const bump = (m: Map<string, Agg>, key: string, row: PtRow) => {
    let a = m.get(key);
    if (!a) {
      a = makeAgg();
      m.set(key, a);
    }
    ingestRow(a, row);
  };

  let withFamily = 0;
  for (const row of rows) {
    const r = parseRecoFields(row.metadataJson);
    const fk = r.strategyFamily ?? "(missing)";
    const vk = r.strategyVariant ?? "(missing)";
    const hk = r.hypothesisType ?? "(missing)";
    bump(byFamily, fk, row);
    bump(byVariant, vk, row);
    bump(byHypo, hk, row);
    if (r.strategyFamily) withFamily++;
  }

  const md: string[] = [];
  md.push("# Reco-thesis family evidence (PaperTrade metadata)");
  md.push("");
  md.push(`Generated: **${new Date().toISOString()}**`);
  md.push("");
  md.push("## Parameters");
  md.push(`- Window: last **${DAYS}** days by \`entryTime\`, up to **${MAX_TRADES}** trades (most recent first).`);
  md.push(`- Min sample threshold (tables + conclusion): **${MIN_SAMPLES}**.`);
  md.push(
    `- Link window: **${LINK_WINDOW_MS == null ? "off (no exit-duration filter for outcomes)" : `${LINK_WIN_RAW} minutes (closed trades only; exit within window after entry)`}**.`
  );
  if (dbError) {
    const reach = dbError.match(/Can't reach database[^\n]*/);
    const hint = dbError.match(/Please make sure[^\n]*/);
    const short =
      reach != null
        ? [reach[0]!.trim(), hint?.[0]?.trim()].filter(Boolean).join(" ")
        : dbError.replace(/\s+/g, " ").trim().slice(0, 240);
    md.push(`- **Database:** query failed — ${short}`);
  }
  md.push("");

  md.push("## 1. Totals");
  md.push(`- Recent PaperTrade rows in window: **${rows.length}**`);
  md.push(`- Rows with non-empty \`strategyFamily\` in metadata: **${withFamily}**`);
  md.push("");

  md.push("## 1b. Reco_thesis tagged — outcome column debug (before aggregation)");
  md.push(
    "_Subset: \`strategyFamily === reco_thesis\` via the same \`parseRecoFields\` as elsewhere. Column checks use non-empty string; numeric outcome = any of \`markout12h\` / \`pnlPct\` / \`pnlDollars\` parses to a finite number._"
  );
  md.push(`- Total tagged rows: **${taggedRecoThesis.length}**`);
  md.push(`- With \`exitTime\`: **${recoDbgExitTime}**`);
  md.push(`- With non-null non-empty \`markout12h\`: **${recoDbgMarkout12h}**`);
  md.push(`- With non-null non-empty \`pnlPct\`: **${recoDbgPnlPct}**`);
  md.push(`- With non-null non-empty \`pnlDollars\`: **${recoDbgPnlDollars}**`);
  md.push(`- With any numeric outcome field (parse): **${recoDbgAnyNumericOutcome}**`);
  md.push("");

  const countLines = (m: Map<string, Agg>) => {
    const pairs = sortCountEntries(new Map([...m.entries()].map(([key, a]) => [key, a.rows.length])));
    return pairs.length ? pairs.map(([k, v]) => `- \`${k}\`: **${v}**`) : ["- _(none)_"];
  };

  md.push("## 2. Counts by strategyFamily");
  md.push(...countLines(byFamily));
  md.push("");

  md.push("## 3. Counts by strategyVariant");
  md.push(...countLines(byVariant));
  md.push("");

  md.push("## 4. Counts by hypothesisType");
  md.push(...countLines(byHypo));
  md.push("");

  md.push(...recoThesisCohortSection(taggedRecoThesis));

  md.push("## 5. Per-variant stats (n ≥ minSamples)");
  md.push(...tableVariantHypo("By strategyVariant", [...byVariant.entries()], MIN_SAMPLES));

  md.push("## 6. Per-hypothesis stats (n ≥ minSamples)");
  md.push(...tableVariantHypo("By hypothesisType", [...byHypo.entries()], MIN_SAMPLES));
  md.push(
    "_Tables 5–6: see footnotes under each table. Outcome-eligible rows honor \`RECO_THESIS_REPORT_LINK_WINDOW_MINUTES\` when set._"
  );
  md.push("");

  md.push("## 7. Sparse segments");
  const sparseVariants = [...byVariant.entries()].filter(
    ([, a]) => a.rows.length > 0 && a.rows.length < MIN_SAMPLES
  );
  const sparseHypos = [...byHypo.entries()].filter(
    ([, a]) => a.rows.length > 0 && a.rows.length < MIN_SAMPLES
  );
  md.push("### Variants under threshold");
  md.push(
    sparseVariants.length
      ? sparseVariants.map(([k, a]) => `- \`${k}\`: ${a.rows.length}`).join("\n")
      : "- none"
  );
  md.push("");
  md.push("### Hypotheses under threshold");
  md.push(
    sparseHypos.length
      ? sparseHypos.map(([k, a]) => `- \`${k}\`: ${a.rows.length}`).join("\n")
      : "- none"
  );
  md.push("");

  const concl = conclude({
    total: rows.length,
    withFamily,
    byVariant,
    byHypo,
    minSamples: MIN_SAMPLES,
  });
  md.push("## 8. Conclusion");
  md.push(`- **Assessment:** ${concl.tag}`);
  for (const b of concl.bullets) md.push(`- ${b}`);
  md.push("");

  md.push("## 9. Implementation note");
  md.push("- **Files added:** `tools/create-reco-thesis-family-report.ts`");
  md.push(
    "- **Data sources:** `PaperTrade` only — `entryTime`, `status`, `exitTime`, `botType`, `score`, `metadataJson`, `markout12h`, `pnlPct`, `pnlDollars`."
  );
  md.push(
    "- **Caveats:** Metadata keys are read from JSON root (and optional `recoThesis` / `reco_thesis` nest). Score prefers `openAttribution.paperShadowScoreCalibration.admissionScore` when parseable, else `PaperTrade.score`. Avg markout uses numeric `markout12h` only. Avg pnl uses numeric `pnlDollars` if present else numeric `pnlPct`. Hit rate uses first-available numeric among `markout12h` → `pnlPct` → `pnlDollars`, only for rows with at least one such value (n_outcomes). Link-window filter excludes ineligible rows from outcome aggregates when enabled."
  );
  if (dbError) md.push("- **Caveats:** Report generated without DB rows due to connection/query failure.");
  md.push("");

  await fs.writeFile(OUT_MD, md.join("\n"), "utf8");
  console.log("[reco-thesis-family-report]", { rows: rows.length, withFamily, out: OUT_MD, dbError });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
