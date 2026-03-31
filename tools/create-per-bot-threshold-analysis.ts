/**
 * Read-only diagnostic: should ML admission thresholds differ per bot?
 * Uses paper trades + labelGoodDecision12h proxy (same join as paper-score-alignment-report).
 *
 * Run from project root (same as other dump scripts):
 *   npm run dump:per-bot-threshold-analysis
 *   npx tsx tools/create-per-bot-threshold-analysis.ts
 *
 * DB: `import "dotenv/config"` loads `.env` from cwd; Prisma uses `DATABASE_URL` via `lib/db.ts`.
 * Docker Compose defaults `DATABASE_URL` to host `postgres` inside app/worker — that hostname
 * usually does not resolve on the host; run the command inside the app container if needed:
 *   docker compose exec app npm run dump:per-bot-threshold-analysis
 *
 * Outputs: dump/per-bot-threshold-analysis.{json,md}, dump/per-bot-threshold-analysis-chat-summary.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { getEffectiveBotProfiles, type EffectiveBotProfile } from "../lib/paper-trading/bot-profiles";
import {
  computeEffectivePaperMinScore,
  readPaperBotMinScoreOverrideEnv,
} from "../lib/paper-trading/paper-roi-admission";
import { tryParseAdmissionScoreFromMetadata } from "../lib/paper-trading/rebalance";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "per-bot-threshold-analysis.json");
const OUT_MD = path.join(DUMP_DIR, "per-bot-threshold-analysis.md");
const OUT_CHAT = path.join(DUMP_DIR, "per-bot-threshold-analysis-chat-summary.md");

/** Thresholds for the compact chat-share file (subset of full simulation grid). */
const CHAT_HEADLINE_THRESHOLDS = [0.5, 0.6, 0.65] as const;

function redactDatabaseUrl(raw: string | undefined): {
  display: string;
  hostname: string | null;
  isMissing: boolean;
} {
  if (raw == null || String(raw).trim() === "") {
    return { display: "(DATABASE_URL missing or empty)", hostname: null, isMissing: true };
  }
  const s = String(raw).trim();
  try {
    const u = new URL(s);
    const db = (u.pathname || "/").replace(/^\//, "").split("?")[0] || "(database)";
    const display = `${u.protocol}//${u.hostname}:${u.port || "5432"}/${db}`;
    return { display, hostname: u.hostname, isMissing: false };
  } catch {
    return { display: "(DATABASE_URL is not a valid URL)", hostname: null, isMissing: false };
  }
}

function resolvedExecutionGuidance(hostname: string | null): "run inside container" | "run on host" {
  if (hostname === "postgres") return "run inside container";
  return "run on host";
}

function printExecutionGuidance(): void {
  const { display, hostname } = redactDatabaseUrl(process.env.DATABASE_URL);
  const mode = resolvedExecutionGuidance(hostname);
  console.log("[per-bot-threshold-analysis] DB access (matches other tools: dotenv + lib/db Prisma)");
  console.log("- Loads `.env` from project root via `dotenv/config` (cwd must be repo root).");
  console.log("- Uses `process.env.DATABASE_URL` — same as Next.js / Prisma CLI.");
  console.log("- docker-compose.yml: inside `app`/`worker`, DATABASE_URL defaults to host `postgres:5432`.");
  console.log("  That hostname normally does not resolve on the host OS → use **run inside container** below.");
  console.log(`- This shell: DATABASE_URL (redacted) = ${display}`);
  console.log(`- Suggested execution mode for this URL: **${mode}**`);
  console.log("");
}

function printDatabaseUnreachable(args: { err: unknown; redacted: string; hostname: string | null }): void {
  const msg = args.err instanceof Error ? args.err.message : String(args.err);
  console.error("");
  console.error("=== Database unreachable ===");
  console.error(`Error: ${msg}`);
  console.error(`DATABASE_URL (redacted, no password shown): ${args.redacted}`);
  if (args.hostname == null && args.redacted.includes("missing")) {
    console.error("Fix: set DATABASE_URL in `.env` at the project root (or export it in the shell).");
  } else if (args.hostname === "postgres") {
    console.error(
      "Host is `postgres` (Compose service name). Your shell cannot resolve it unless you use Docker DNS."
    );
    console.error("Fix (typical): run the dump inside the app container after DB is up, e.g.");
    console.error("  docker compose --profile postgres up -d");
    console.error("  docker compose exec app npm run dump:per-bot-threshold-analysis");
    console.error("Alternative: publish Postgres to localhost and point DATABASE_URL at 127.0.0.1:<port>.");
  } else {
    console.error(
      "Fix: start Postgres and ensure DATABASE_URL host/port is reachable from where you run Node."
    );
  }
  console.error("");
  console.error("Suggested mode for typical Compose setups: **run inside container** (app/worker service).");
  console.error("Suggested mode when DATABASE_URL uses localhost: **run on host**.");
  console.error("");
  console.error("No dump files were written. After a successful run you should see:");
  console.error(`  ${path.join(process.cwd(), "dump", "per-bot-threshold-analysis-chat-summary.md")}`);
  console.error("(The whole dump/ folder is gitignored — it only exists locally after tools generate it.)");
  console.error("");
}

function pct1(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

function pct2(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(2)}%`;
}

const PRIMARY_LABEL_FIELD = "labelGoodDecision12h";
const LOOKBACK_DAYS = Number(process.env.PAPER_THRESHOLD_ANALYSIS_LOOKBACK_DAYS ?? 90);
const RECENT_CLOSED_DAYS = Number(process.env.PAPER_THRESHOLD_ANALYSIS_RECENT_CLOSED_DAYS ?? 30);
const MIN_CLOSED_FOR_RECOMMENDATION = 15;
const MIN_LABELED_FOR_LABEL_RATE = 5;
const MIN_SAMPLES_THRESHOLD_SIM = 6;

const TARGET_BOT_ORDER = ["strict_quality", "relaxed_edge", "tail_extremes"] as const;

const CANDIDATE_THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7] as const;

type ScoreSource = "admission_metadata" | "fallback_row_score" | "missing_invalid";

type EnrichedTrade = {
  id: string;
  botType: string;
  status: string;
  entryTime: Date;
  exitTime: Date | null;
  score: number;
  resolvedScore: number | null;
  scoreSource: ScoreSource;
  pnlPct: string | null;
  markout12h: string | null;
  label12h: boolean | null;
  holdHoursClosed: number | null;
};

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function quantileSorted(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function distributionStats(values: number[]): {
  count: number;
  min: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
} {
  const finite = values.filter((x) => Number.isFinite(x));
  if (finite.length === 0) {
    return {
      count: 0,
      min: null,
      p10: null,
      p25: null,
      p50: null,
      p75: null,
      p90: null,
      max: null,
    };
  }
  const s = [...finite].sort((a, b) => a - b);
  return {
    count: s.length,
    min: s[0]!,
    p10: quantileSorted(s, 0.1),
    p25: quantileSorted(s, 0.25),
    p50: quantileSorted(s, 0.5),
    p75: quantileSorted(s, 0.75),
    p90: quantileSorted(s, 0.9),
    max: s[s.length - 1]!,
  };
}

function parseRecommendationId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const id = o.recommendationId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function resolveAnalysisScore(
  metadataJson: string | null,
  rowScore: number
): { value: number | null; source: ScoreSource } {
  const adm = tryParseAdmissionScoreFromMetadata(metadataJson);
  if (adm != null && Number.isFinite(adm)) {
    return { value: adm, source: "admission_metadata" };
  }
  if (Number.isFinite(rowScore)) {
    return { value: rowScore, source: "fallback_row_score" };
  }
  return { value: null, source: "missing_invalid" };
}

function realizedPnlProxy(row: EnrichedTrade): number | null {
  return parseNum(row.pnlPct) ?? parseNum(row.markout12h);
}

function effectiveMinScoreForProfile(profile: EffectiveBotProfile, cfg: ReturnType<typeof getPaperTradingConfig>): number {
  const baseMinScore = profile.threshold + profile.minScoreBuffer;
  return computeEffectivePaperMinScore({
    baseMinScore,
    globalOverride: cfg.paperMinScoreOverrideGlobal,
    botOverride: readPaperBotMinScoreOverrideEnv(profile.botType),
  }).effectiveMinScore;
}

const SCORE_BAND_DEFS: { label: string; min: number; maxExclusive: number | null }[] = [
  { label: "<0.50", min: -Infinity, maxExclusive: 0.5 },
  { label: "0.50–0.55", min: 0.5, maxExclusive: 0.55 },
  { label: "0.55–0.60", min: 0.55, maxExclusive: 0.6 },
  { label: "0.60–0.65", min: 0.6, maxExclusive: 0.65 },
  { label: "0.65–0.70", min: 0.65, maxExclusive: 0.7 },
  { label: "0.70+", min: 0.7, maxExclusive: null },
];

type ThresholdSimRow = {
  candidateThreshold: number;
  note: string;
  admittedTradeCount: number;
  filteredTradeCount: number;
  closedAdmittedCount: number;
  closedFilteredCount: number;
  admittedLabelGoodRate: number | null;
  filteredLabelGoodRate: number | null;
  admittedPnlHitRate: number | null;
  filteredPnlHitRate: number | null;
  admittedMeanPnlPct: number | null;
  filteredMeanPnlPct: number | null;
  admittedLabeledCount: number;
  filteredLabeledCount: number;
};

function runThresholdSimulation(rows: EnrichedTrade[], t: number): ThresholdSimRow {
  const valid = rows.filter((r) => r.resolvedScore != null) as Array<EnrichedTrade & { resolvedScore: number }>;
  const admitted = valid.filter((r) => r.resolvedScore >= t);
  const filtered = valid.filter((r) => r.resolvedScore < t);
  const closedAd = admitted.filter((r) => r.status === "closed");
  const closedFl = filtered.filter((r) => r.status === "closed");

  const pnlsAd = closedAd.map(realizedPnlProxy).filter((v): v is number => v != null);
  const pnlsFl = closedFl.map(realizedPnlProxy).filter((v): v is number => v != null);
  const labAd = closedAd.filter((r) => r.label12h !== null);
  const labFl = closedFl.filter((r) => r.label12h !== null);
  const posAd = labAd.filter((r) => r.label12h === true);
  const posFl = labFl.filter((r) => r.label12h === true);

  return {
    candidateThreshold: t,
    note:
      "Retrospective filter on trades that actually opened in the lookback window; does not model counterfactual opens. Open admitted rows have no realized outcome yet.",
    admittedTradeCount: admitted.length,
    filteredTradeCount: filtered.length,
    closedAdmittedCount: closedAd.length,
    closedFilteredCount: closedFl.length,
    admittedLabelGoodRate: labAd.length ? posAd.length / labAd.length : null,
    filteredLabelGoodRate: labFl.length ? posFl.length / labFl.length : null,
    admittedPnlHitRate: pnlsAd.length ? pnlsAd.filter((x) => x > 0).length / pnlsAd.length : null,
    filteredPnlHitRate: pnlsFl.length ? pnlsFl.filter((x) => x > 0).length / pnlsFl.length : null,
    admittedMeanPnlPct: mean(pnlsAd),
    filteredMeanPnlPct: mean(pnlsFl),
    admittedLabeledCount: labAd.length,
    filteredLabeledCount: labFl.length,
  };
}

type PerBotRecommendation = {
  recommendedAction: "keep_global" | "test_higher" | "test_lower" | "insufficient_data";
  suggestedThresholdBand: [number, number] | null;
  confidence: "low" | "medium" | "high";
  rationale: string;
};

function buildRecommendation(args: {
  botType: string;
  closedCount: number;
  labeledClosed: number;
  effectiveMinScore: number;
  simRows: ThresholdSimRow[];
  p50Score: number | null;
}): PerBotRecommendation {
  const { botType, closedCount, labeledClosed, effectiveMinScore, simRows, p50Score } = args;
  if (closedCount < MIN_CLOSED_FOR_RECOMMENDATION) {
    return {
      recommendedAction: "insufficient_data",
      suggestedThresholdBand: null,
      confidence: "low",
      rationale: `Only ${closedCount} closed trades in lookback; need ≥${MIN_CLOSED_FOR_RECOMMENDATION} for a stable read.`,
    };
  }

  const byT = new Map(simRows.map((s) => [s.candidateThreshold, s]));
  const s05 = byT.get(0.5);
  const s06 = byT.get(0.6);
  const s07 = byT.get(0.7);

  const usePnl =
    (s06?.closedAdmittedCount ?? 0) >= MIN_SAMPLES_THRESHOLD_SIM &&
    s06?.admittedMeanPnlPct != null &&
    s05?.admittedMeanPnlPct != null;

  if (usePnl && s06 && s05) {
    const improve = s06.admittedMeanPnlPct! - s05.admittedMeanPnlPct!;
    if (improve > 0.002 && s06.closedAdmittedCount >= 8) {
      return {
        recommendedAction: "test_higher",
        suggestedThresholdBand: [0.55, 0.65],
        confidence: labeledClosed >= MIN_LABELED_FOR_LABEL_RATE ? "medium" : "low",
        rationale: `${botType}: closed cohort shows higher mean paper PnL% when hypothetically cutting below ~0.60 vs ~0.50 (Δ≈${(improve * 100).toFixed(2)}pp on means); consider a cautious A/B on a higher admission bar. Labels sparse—lean on PnL proxy.`,
      };
    }
    if (improve < -0.002 && s05.closedAdmittedCount >= 8) {
      return {
        recommendedAction: "test_lower",
        suggestedThresholdBand: [0.45, 0.55],
        confidence: "low",
        rationale: `${botType}: stricter cut at 0.60 lowers mean PnL vs 0.50 on this window—may indicate score–outcome noise or thin highs; avoid tightening without more data.`,
      };
    }
  }

  if (p50Score != null && p50Score < effectiveMinScore - 0.02) {
    return {
      recommendedAction: "insufficient_data",
      suggestedThresholdBand: null,
      confidence: "low",
      rationale: `Median resolved score (${p50Score.toFixed(3)}) sits below effective min (${effectiveMinScore.toFixed(3)}); cohort may be dominated by exploration or metadata gaps—interpret bands carefully.`,
    };
  }

  if ((s07?.closedAdmittedCount ?? 0) < 5 && (byT.get(0.65)?.closedAdmittedCount ?? 0) < 8) {
    return {
      recommendedAction: "keep_global",
      suggestedThresholdBand: null,
      confidence: "low",
      rationale:
        "Tighter candidate thresholds (0.65–0.7) leave very few closed admits in this window; cannot justify per-bot shifts.",
    };
  }

  return {
    recommendedAction: "keep_global",
    suggestedThresholdBand: null,
    confidence: labeledClosed >= MIN_LABELED_FOR_LABEL_RATE ? "medium" : "low",
    rationale:
      "No strong, sample-backed case for a different bar vs current global/per-bot effective mins; revisit after more closes and label coverage.",
  };
}

function buildChatSummaryMarkdown(args: {
  generatedAt: string;
  lookbackDays: number;
  botSummaries: Array<{
    botType: string;
    currentOpens: number;
    totalClosesInLookback: number;
    meanResolvedScore: number | null;
    effectiveMinScoreAtAdmissionEngine: number | null;
    labelGoodDecision12hPositiveRate: number | null;
    pnlHitRateClosed: number | null;
  }>;
  meanPnlClosedByBot: Record<string, number | null>;
  thresholdSimulations: Array<{
    botType: string;
    candidateThresholds: ThresholdSimRow[];
  }>;
  recommendations: Array<{ botType: string; recommendation: PerBotRecommendation }>;
  caveats: string[];
}): string {
  const lines: string[] = [];
  lines.push("# Per-bot threshold analysis — chat summary");
  lines.push("");
  lines.push(`Generated: ${args.generatedAt} · Lookback: ${args.lookbackDays}d entry time`);
  lines.push("");
  lines.push("## 1. Bot summary");
  lines.push("");
  lines.push(
    "| botType | open_n | closed_n | mean_score | effective_min_score | label_positive_rate | pnl_hit_rate | mean_pnl |"
  );
  lines.push("| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const s of args.botSummaries) {
    const meanPnl = args.meanPnlClosedByBot[s.botType] ?? null;
    lines.push(
      `| ${s.botType} | ${s.currentOpens} | ${s.totalClosesInLookback} | ${s.meanResolvedScore?.toFixed(4) ?? "—"} | ${s.effectiveMinScoreAtAdmissionEngine?.toFixed(4) ?? "—"} | ${pct1(s.labelGoodDecision12hPositiveRate)} | ${pct1(s.pnlHitRateClosed)} | ${meanPnl != null ? pct2(meanPnl) : "—"} |`
    );
  }
  lines.push("");
  lines.push("- mean_score = mean resolved admission score (metadata `admissionScore`, else `PaperTrade.score`).");
  lines.push("- mean_pnl = mean closed-trade PnL proxy (`pnlPct` → `markout12h`).");
  lines.push("");
  lines.push("## 2. Threshold sensitivity (retrospective: resolved score ≥ T)");
  lines.push("");
  for (const block of args.thresholdSimulations) {
    lines.push(`### ${block.botType}`);
    lines.push("");
    lines.push(
      "| T | admitted_n | closed_admitted_n | mean_pnl_admitted | label_positive_rate_admitted |"
    );
    lines.push("| ---: | ---: | ---: | ---: | ---: |");
    for (const t of CHAT_HEADLINE_THRESHOLDS) {
      const row = block.candidateThresholds.find((r) => r.candidateThreshold === t);
      if (!row) continue;
      lines.push(
        `| ${t} | ${row.admittedTradeCount} | ${row.closedAdmittedCount} | ${row.admittedMeanPnlPct != null ? pct2(row.admittedMeanPnlPct) : "—"} | ${pct1(row.admittedLabelGoodRate)} |`
      );
    }
    lines.push("");
  }
  lines.push("## 3. Recommendations (heuristic, not live policy)");
  lines.push("");
  for (const r of args.recommendations) {
    const x = r.recommendation;
    lines.push(`- **${r.botType}**`);
    lines.push(`  - recommendedAction: \`${x.recommendedAction}\``);
    lines.push(
      `  - suggestedThresholdBand: ${x.suggestedThresholdBand ? `[${x.suggestedThresholdBand[0]}, ${x.suggestedThresholdBand[1]}]` : "—"}`
    );
    lines.push(`  - confidence: ${x.confidence}`);
    lines.push(`  - rationale: ${x.rationale}`);
    lines.push("");
  }
  lines.push("## 4. Data caveats");
  lines.push("");
  for (const c of args.caveats) {
    lines.push(`- ${c}`);
  }
  lines.push("");
  lines.push(
    "_Prefer ≥15 closed trades per bot; label_positive_rate needs `MlShadowTrainingExample` join; open rows have no final outcome._"
  );
  return lines.join("\n");
}

async function runPerBotThresholdAnalysis(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const cfg = getPaperTradingConfig();
  const effectiveProfiles = await getEffectiveBotProfiles();
  const minByBot = new Map<string, number>();
  for (const p of effectiveProfiles) {
    minByBot.set(p.botType, effectiveMinScoreForProfile(p, cfg));
  }

  const from = new Date();
  from.setDate(from.getDate() - LOOKBACK_DAYS);
  const recentClosedFrom = new Date();
  recentClosedFrom.setDate(recentClosedFrom.getDate() - RECENT_CLOSED_DAYS);

  const trades = await prisma.paperTrade.findMany({
    where: { entryTime: { gte: from } },
    select: {
      id: true,
      botType: true,
      status: true,
      score: true,
      assetId: true,
      side: true,
      metadataJson: true,
      markout12h: true,
      pnlPct: true,
      entryTime: true,
      exitTime: true,
    },
  });

  const shadowExamples = await prisma.mlShadowTrainingExample.findMany({
    where: {},
    select: {
      recommendationId: true,
      assetId: true,
      side: true,
      labelGoodDecision12h: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const labelByKey = new Map<string, boolean>();
  for (const row of shadowExamples) {
    const recId = row.recommendationId ?? "";
    const key = `${recId}|${row.assetId}|${row.side}`;
    if (labelByKey.has(key)) continue;
    if (row.labelGoodDecision12h === null) continue;
    labelByKey.set(key, row.labelGoodDecision12h);
  }

  const enriched: EnrichedTrade[] = trades.map((t) => {
    const recId = parseRecommendationId(t.metadataJson);
    const key = recId != null ? `${recId}|${t.assetId}|${t.side}` : null;
    const label12h = key != null && labelByKey.has(key) ? labelByKey.get(key)! : null;
    const { value: resolvedScore, source: scoreSource } = resolveAnalysisScore(t.metadataJson, t.score);
    let holdHoursClosed: number | null = null;
    if (t.status === "closed" && t.exitTime) {
      holdHoursClosed = Math.max(0, (t.exitTime.getTime() - t.entryTime.getTime()) / (60 * 60 * 1000));
    }
    return {
      id: t.id,
      botType: t.botType,
      status: t.status,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      score: t.score,
      resolvedScore,
      scoreSource,
      pnlPct: t.pnlPct,
      markout12h: t.markout12h,
      label12h,
      holdHoursClosed,
    };
  });

  const botTypesInData = new Set(enriched.map((t) => t.botType));
  const reportBotTypes = [...new Set([...TARGET_BOT_ORDER, ...botTypesInData])].sort((a, b) => {
    const ia = TARGET_BOT_ORDER.indexOf(a as (typeof TARGET_BOT_ORDER)[number]);
    const ib = TARGET_BOT_ORDER.indexOf(b as (typeof TARGET_BOT_ORDER)[number]);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });

  const outcomeFieldsDoc = {
    primaryLabel: PRIMARY_LABEL_FIELD,
    joinLogic:
      "MlShadowTrainingExample rows joined to PaperTrade via metadataJson.recommendationId + PaperTrade.assetId + PaperTrade.side; first non-null label by updatedAt desc (same as paper-score-alignment-report).",
    pnlProxy: "parseFloat(pnlPct) with fallback to markout12h string when pnlPct missing.",
    goodOutcomeRates: {
      labelPositiveRate: "Among closed trades with a joined label: fraction labelGoodDecision12h === true.",
      pnlHitRate: "Among closed trades with numeric PnL proxy: fraction with value > 0.",
    },
  };

  const scoreFallbackDoc = {
    admissionPath: "metadataJson.paperShadowScoreCalibration.admissionScore (via tryParseAdmissionScoreFromMetadata).",
    fallback: "PaperTrade.score when admission score absent or non-finite.",
    missing: "Rows with neither usable admission nor finite row score excluded from distribution/threshold sims but counted in coverage.",
  };

  const urlMeta = redactDatabaseUrl(process.env.DATABASE_URL);
  const sections: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    recentClosedDays: RECENT_CLOSED_DAYS,
    outcomeFieldsUsed: outcomeFieldsDoc,
    scoreResolution: scoreFallbackDoc,
    dataCaveats: [] as string[],
    executionContext: {
      dotenv: 'import "dotenv/config" loads `.env` from process.cwd() (run from repo root).',
      databaseUrlRedacted: urlMeta.display,
      databaseHostname: urlMeta.hostname,
      resolvedExecutionGuidance: resolvedExecutionGuidance(urlMeta.hostname),
      prismaClient: "lib/db.ts (shared PrismaClient, DATABASE_URL from env).",
      dockerComposeReference:
        "docker-compose.yml: app/worker default DATABASE_URL uses host `postgres:5432`; on the host OS that name usually only resolves inside the compose network — use `docker compose exec app npm run dump:per-bot-threshold-analysis` or set DATABASE_URL to a published localhost port / DATABASE_URL_DOCKER for external Postgres.",
    },
  };

  const caveats: string[] = [
    "Analysis is read-only; does not change admission or models.",
    "Open trades have no final PnL/label; they affect counts and score bands but not closed-only rates.",
    "Hypothetical thresholds apply to the observed opened cohort only (survivorship: all rows passed historical gates at open).",
    "Exploration admits may appear below current effective min score—interpret score bands accordingly.",
  ];

  const botSummaries: unknown[] = [];
  const scoreDistributions: unknown[] = [];
  const outcomeByBand: unknown[] = [];
  const thresholdSimulations: unknown[] = [];
  const recommendations: unknown[] = [];

  for (const bot of reportBotTypes) {
    const botRows = enriched.filter((r) => r.botType === bot);
    const openedInWindow = botRows;
    const openNow = botRows.filter((r) => r.status === "open");
    const closedInWindow = botRows.filter((r) => r.status === "closed");
    const recentClosed = closedInWindow.filter((r) => r.exitTime && r.exitTime >= recentClosedFrom);

    const cov = {
      admission_metadata: botRows.filter((r) => r.scoreSource === "admission_metadata").length,
      fallback_row_score: botRows.filter((r) => r.scoreSource === "fallback_row_score").length,
      missing_invalid: botRows.filter((r) => r.scoreSource === "missing_invalid").length,
    };

    const withScore = botRows.filter((r) => r.resolvedScore != null) as Array<
      EnrichedTrade & { resolvedScore: number }
    >;
    const scoresOpened = withScore.map((r) => r.resolvedScore);
    const scoresOpenNow = openNow
      .map((r) => r.resolvedScore)
      .filter((x): x is number => x != null);
    const scoresRecentClosed = recentClosed
      .map((r) => r.resolvedScore)
      .filter((x): x is number => x != null);

    const closedLabeled = closedInWindow.filter((r) => r.label12h !== null);
    const labelPos = closedLabeled.filter((r) => r.label12h === true);
    const pnls = closedInWindow.map(realizedPnlProxy).filter((v): v is number => v != null);
    const holds = closedInWindow.map((r) => r.holdHoursClosed).filter((v): v is number => v != null);

    const effMin = minByBot.get(bot) ?? null;

    botSummaries.push({
      botType: bot,
      totalOpensInLookback: openedInWindow.length,
      totalClosesInLookback: closedInWindow.length,
      currentOpens: openNow.length,
      labelGoodDecision12hPositiveRate: closedLabeled.length ? labelPos.length / closedLabeled.length : null,
      labelLabeledClosedCount: closedLabeled.length,
      pnlHitRateClosed: pnls.length ? pnls.filter((x) => x > 0).length / pnls.length : null,
      pnlClosedWithNumericProxy: pnls.length,
      meanHoldHoursClosed: mean(holds),
      meanResolvedScore: mean(withScore.map((r) => r.resolvedScore)),
      scoreCoverage: {
        ...cov,
        totalRows: botRows.length,
        shareAdmissionMetadata: botRows.length ? cov.admission_metadata / botRows.length : null,
      },
      effectiveMinScoreAtAdmissionEngine: effMin,
    });

    scoreDistributions.push({
      botType: bot,
      openedTrades: distributionStats(scoresOpened),
      currentlyOpenTrades: distributionStats(scoresOpenNow),
      recentlyClosedTrades: distributionStats(scoresRecentClosed),
    });

    const bandRows: unknown[] = [];
    for (const def of SCORE_BAND_DEFS) {
      const inBand = withScore.filter((r) => {
        if (r.resolvedScore < def.min) return false;
        if (def.maxExclusive != null && r.resolvedScore >= def.maxExclusive) return false;
        return true;
      });
      const closedB = inBand.filter((r) => r.status === "closed");
      const openB = inBand.filter((r) => r.status === "open");
      const lab = closedB.filter((r) => r.label12h !== null);
      const labPos = lab.filter((r) => r.label12h === true);
      const pn = closedB.map(realizedPnlProxy).filter((v): v is number => v != null);
      const hh = closedB.map((r) => r.holdHoursClosed).filter((v): v is number => v != null);
      bandRows.push({
        bandLabel: def.label,
        tradeCount: inBand.length,
        closedCount: closedB.length,
        openCount: openB.length,
        labelGoodDecision12hPositiveRate: lab.length ? labPos.length / lab.length : null,
        labeledClosedInBand: lab.length,
        pnlHitRate: pn.length ? pn.filter((x) => x > 0).length / pn.length : null,
        meanPnlPct: mean(pn),
        meanHoldHoursClosed: mean(hh),
      });
    }
    outcomeByBand.push({ botType: bot, bands: bandRows });

    const simRows = CANDIDATE_THRESHOLDS.map((t) => runThresholdSimulation(botRows, t));
    thresholdSimulations.push({ botType: bot, candidateThresholds: simRows });

    const rec = buildRecommendation({
      botType: bot,
      closedCount: closedInWindow.length,
      labeledClosed: closedLabeled.length,
      effectiveMinScore: effMin ?? cfg.threshold + cfg.minScoreBuffer,
      simRows,
      p50Score: distributionStats(scoresOpened).p50,
    });
    recommendations.push({ botType: bot, recommendation: rec });
  }

  if (enriched.some((r) => r.scoreSource === "fallback_row_score")) {
    caveats.push("Some rows use PaperTrade.score because paperShadowScoreCalibration.admissionScore was missing.");
  }
  if (enriched.some((r) => r.scoreSource === "missing_invalid")) {
    caveats.push("Some rows lack a usable resolved score and were excluded from quantiles and threshold simulations.");
  }
  const lowLabelBots = (botSummaries as { botType: string; labelLabeledClosedCount: number }[]).filter(
    (b) => b.labelLabeledClosedCount < MIN_LABELED_FOR_LABEL_RATE
  );
  if (lowLabelBots.length > 0) {
    caveats.push(
      `Low label join count (<${MIN_LABELED_FOR_LABEL_RATE} closed labeled) for: ${lowLabelBots.map((b) => b.botType).join(", ")} — prefer PnL metrics where labels are thin.`
    );
  }

  const tighter065 = Object.fromEntries(
    reportBotTypes.map((bot) => {
      const botRows = enriched.filter((r) => r.botType === bot);
      const sim = runThresholdSimulation(botRows, 0.65);
      return [
        bot,
        {
          closedAdmittedCount: sim.closedAdmittedCount,
          admittedMeanPnlPct: sim.admittedMeanPnlPct,
          admittedTradeCount: sim.admittedTradeCount,
        },
      ];
    })
  );

  const p50ByBot = Object.fromEntries(
    scoreDistributions.map((s) => {
      const o = s as { botType: string; openedTrades: { p50: number | null } };
      return [o.botType, o.openedTrades.p50];
    })
  );

  const meanPnlClosedByBot = Object.fromEntries(
    reportBotTypes.map((bot) => {
      const c = enriched.filter((r) => r.botType === bot && r.status === "closed");
      const pn = c.map(realizedPnlProxy).filter((v): v is number => v != null);
      return [bot, mean(pn)];
    })
  );

  const globalComparison = {
    p50ResolvedScoreOpenedCohort: p50ByBot,
    meanPnlPctClosed: meanPnlClosedByBot,
    sensitivityAt065: tighter065,
    scoreRegimeOverlap:
      "Compare p50 resolved scores across bots; large gaps suggest different score mass under the same model. Similar p50s with different PnL by band suggest execution/policy mix rather than a single threshold split.",
    tighterThresholdComment:
      "At hypothetical 0.65, admitted closed counts show how aggressively a universal tight bar would starve each bot given this history.",
  };

  sections["A_botSummary"] = botSummaries;
  sections["B_scoreDistributionByBot"] = scoreDistributions;
  sections["C_outcomeByScoreBand"] = outcomeByBand;
  sections["D_thresholdSensitivitySimulation"] = {
    label:
      "Simple retrospective filter: among trades opened in the lookback, how counts and closed outcomes split if admission required resolvedScore ≥ T. Not a backtest of policy.",
    perBot: thresholdSimulations,
  };
  sections["E_recommendationByBot"] = recommendations;
  sections["F_globalComparison"] = globalComparison;
  sections.dataCaveats = caveats;

  await fs.writeFile(OUT_JSON, JSON.stringify(sections, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Per-bot threshold analysis (read-only)");
  md.push("");
  md.push(`- **Generated:** ${sections.generatedAt}`);
  md.push(`- **Lookback:** ${LOOKBACK_DAYS}d entry time · **Recent closed:** last ${RECENT_CLOSED_DAYS}d exit time`);
  md.push(`- **Outcome:** \`${PRIMARY_LABEL_FIELD}\` join (see JSON \`outcomeFieldsUsed\`) + PnL proxy (\`pnlPct\` → \`markout12h\`)`);
  md.push(`- **Score:** admission metadata first, else \`PaperTrade.score\` (see \`scoreResolution\`)`);
  md.push("");
  md.push("## A. Bot summary (compact)");
  md.push("");
  md.push("| bot | opens | closes | open now | p50 score* | mean PnL%† | label +% | eff. min‡ |");
  md.push("|-----|------:|-------:|---------:|-----------:|-----------:|---------:|----------:|");
  for (let i = 0; i < reportBotTypes.length; i++) {
    const bot = reportBotTypes[i]!;
    const sum = botSummaries[i] as {
      botType: string;
      totalOpensInLookback: number;
      totalClosesInLookback: number;
      currentOpens: number;
      meanResolvedScore: number | null;
      labelGoodDecision12hPositiveRate: number | null;
      effectiveMinScoreAtAdmissionEngine: number | null;
    };
    const dist = scoreDistributions[i] as {
      openedTrades: { p50: number | null };
    };
    const meanPnl = meanPnlClosedByBot[bot];
    md.push(
      `| ${sum.botType} | ${sum.totalOpensInLookback} | ${sum.totalClosesInLookback} | ${sum.currentOpens} | ${dist.openedTrades.p50?.toFixed(3) ?? "—"} | ${meanPnl != null ? (meanPnl * 100).toFixed(2) + "%" : "—"} | ${sum.labelGoodDecision12hPositiveRate != null ? (sum.labelGoodDecision12hPositiveRate * 100).toFixed(1) + "%" : "—"} | ${sum.effectiveMinScoreAtAdmissionEngine?.toFixed(3) ?? "—"} |`
    );
  }
  md.push("");
  md.push("*resolved score on opened cohort · †closed only · ‡engine effective min (profile + overrides)");
  md.push("");
  md.push("## E. Recommendations");
  md.push("");
  for (const r of recommendations as { botType: string; recommendation: PerBotRecommendation }[]) {
    const x = r.recommendation;
    md.push(`- **${r.botType}:** \`${x.recommendedAction}\` (${x.confidence}) — ${x.rationale}`);
    if (x.suggestedThresholdBand) {
      md.push(`  - Suggested band: [${x.suggestedThresholdBand[0]}, ${x.suggestedThresholdBand[1]}]`);
    }
  }
  md.push("");
  md.push("## F. Global comparison (headline)");
  md.push("");
  md.push(`- **p50 (opened):** ${JSON.stringify(p50ByBot)}`);
  md.push(`- **At T=0.65 (closed admitted n / mean PnL%):**`);
  for (const bot of reportBotTypes) {
    const s = (tighter065 as Record<string, { closedAdmittedCount: number; admittedMeanPnlPct: number | null }>)[bot];
    if (!s) continue;
    md.push(
      `  - ${bot}: n=${s.closedAdmittedCount}, mean=${s.admittedMeanPnlPct != null ? (s.admittedMeanPnlPct * 100).toFixed(2) + "%" : "—"}`
    );
  }
  md.push("");
  md.push("## Data caveats");
  md.push("");
  for (const c of caveats) {
    md.push(`- ${c}`);
  }
  md.push("");
  md.push(`Full detail: \`${OUT_JSON}\``);
  md.push("");
  md.push(`Chat-sized paste: \`${OUT_CHAT}\``);

  await fs.writeFile(OUT_MD, md.join("\n"), "utf8");

  const chatMd = buildChatSummaryMarkdown({
    generatedAt: String(sections.generatedAt),
    lookbackDays: LOOKBACK_DAYS,
    botSummaries: botSummaries as Array<{
      botType: string;
      currentOpens: number;
      totalClosesInLookback: number;
      meanResolvedScore: number | null;
      effectiveMinScoreAtAdmissionEngine: number | null;
      labelGoodDecision12hPositiveRate: number | null;
      pnlHitRateClosed: number | null;
    }>,
    meanPnlClosedByBot,
    thresholdSimulations: thresholdSimulations as Array<{
      botType: string;
      candidateThresholds: ThresholdSimRow[];
    }>,
    recommendations: recommendations as Array<{ botType: string; recommendation: PerBotRecommendation }>,
    caveats,
  });
  await fs.writeFile(OUT_CHAT, chatMd, "utf8");

  console.log("--- Per-bot threshold analysis ---");
  console.log(`Rows analyzed (lookback): ${enriched.length}`);
  console.log(`Bots in report: ${reportBotTypes.join(", ")}`);
  console.log("Score coverage (admission / fallback / missing):");
  for (let i = 0; i < reportBotTypes.length; i++) {
    const bot = reportBotTypes[i]!;
    const s = botSummaries[i] as {
      scoreCoverage: { admission_metadata: number; fallback_row_score: number; missing_invalid: number };
    };
    console.log(
      `  ${bot}: admission=${s.scoreCoverage.admission_metadata} fallback=${s.scoreCoverage.fallback_row_score} missing=${s.scoreCoverage.missing_invalid}`
    );
  }
  console.log("Headline recommendation by bot:");
  for (const r of recommendations as { botType: string; recommendation: PerBotRecommendation }[]) {
    console.log(`  ${r.botType}: ${r.recommendation.recommendedAction} (${r.recommendation.confidence})`);
  }
  console.log(`Wrote ${OUT_JSON}`);
  console.log(`Wrote ${OUT_MD}`);
  console.log(`Wrote ${OUT_CHAT}`);
  console.log("");
  console.log("--- Rerun & outputs ---");
  console.log("Exact commands:");
  console.log("  npm run dump:per-bot-threshold-analysis");
  console.log("  npx tsx tools/create-per-bot-threshold-analysis.ts");
  console.log("Docker (when DATABASE_URL host is `postgres`):");
  console.log("  docker compose exec app npm run dump:per-bot-threshold-analysis");
  console.log("Output files:");
  console.log(`  ${OUT_JSON}`);
  console.log(`  ${OUT_MD}`);
  console.log(`  ${OUT_CHAT}  ← best for pasting into ChatGPT`);
  console.log("");
  console.log("IMPLEMENTATION SUMMARY:");
  console.log(
    "- outputs: dump/per-bot-threshold-analysis.json, .md, per-bot-threshold-analysis-chat-summary.md"
  );
  console.log("- DB: same as other tools — dotenv/config + prisma from lib/db.ts + DATABASE_URL");
  console.log(
    "- outcome fields/logic: labelGoodDecision12h via MlShadowTrainingExample join (recommendationId|assetId|side); PnL proxy pnlPct then markout12h; good-outcome rates = label positive rate and/or PnL>0 hit rate on closed trades"
  );
  console.log(
    "- score fallback: tryParseAdmissionScoreFromMetadata (paperShadowScoreCalibration.admissionScore); else finite PaperTrade.score; else missing (excluded from distributions/sims)"
  );
  for (const r of recommendations as { botType: string; recommendation: PerBotRecommendation }[]) {
    console.log(`- top-level recommendation ${r.botType}: ${r.recommendation.recommendedAction} — ${r.recommendation.rationale.slice(0, 120)}${r.recommendation.rationale.length > 120 ? "…" : ""}`);
  }
}

async function main(): Promise<void> {
  printExecutionGuidance();
  const rawUrl = process.env.DATABASE_URL;
  const urlInfo = redactDatabaseUrl(rawUrl);
  if (urlInfo.isMissing) {
    console.error("DATABASE_URL is missing or empty. Add it to `.env` at the project root (same file as Next.js).");
    process.exit(1);
  }
  try {
    await prisma.$connect();
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch (e) {
    printDatabaseUnreachable({ err: e, redacted: urlInfo.display, hostname: urlInfo.hostname });
    process.exit(1);
  }
  try {
    await runPerBotThresholdAnalysis();
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
