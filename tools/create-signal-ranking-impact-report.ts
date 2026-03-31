/**
 * Read-only signal ranking impact report.
 * Parses recent per-tick ranking summaries emitted by paper trading engine logs.
 */
import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";

const ROOT = process.cwd();
const DUMP_DIR = path.join(ROOT, "dump");
const OUT_JSON = path.join(DUMP_DIR, "signal-ranking-impact-report.json");
const OUT_MD = path.join(DUMP_DIR, "signal-ranking-impact-report.md");
const LOG_FILE = process.env.SIGNAL_RANKING_IMPACT_LOG_PATH?.trim() || path.join(ROOT, "worker-live.log");
const MAX_TICKS = Math.min(500, Math.max(50, Number(process.env.SIGNAL_RANKING_IMPACT_TICKS ?? "300") || 300));

type RankingCandidate = {
  tickId: string;
  candidateId: string;
  botType: string;
  signalType: string;
  rawScore: number;
  scoreAfterSignalMultiplier: number;
  finalScoreUsedForRanking: number;
  rankPosition: number;
  selected: boolean;
};

type TickSummary = {
  tickId: string;
  candidates: RankingCandidate[];
};

function parseTickSummariesFromLog(text: string): TickSummary[] {
  const out: TickSummary[] = [];
  const marker = "[paper-signal-ranking] tick summary ";
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const i = line.indexOf(marker);
    if (i < 0) continue;
    const raw = line.slice(i + marker.length).trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as TickSummary;
      if (!parsed || typeof parsed.tickId !== "string" || !Array.isArray(parsed.candidates)) continue;
      out.push(parsed);
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, c) => a + c, 0) / values.length;
}

function pct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${(v * 100).toFixed(1)}%`;
}

function num(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return v.toFixed(4);
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  let logText = "";
  try {
    logText = await fs.readFile(LOG_FILE, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to read log file at ${LOG_FILE}: ${msg}`);
  }

  const allSummaries = parseTickSummariesFromLog(logText);
  const summaries = allSummaries.slice(-MAX_TICKS);
  const candidates = summaries.flatMap((s) => s.candidates ?? []);

  const bySignal = new Map<string, RankingCandidate[]>();
  for (const c of candidates) {
    const key = (c.signalType || "unknown").toLowerCase();
    const arr = bySignal.get(key) ?? [];
    arr.push(c);
    bySignal.set(key, arr);
  }

  const perSignal = [...bySignal.entries()]
    .map(([signalType, rows]) => ({
      signalType,
      count: rows.length,
      avgRawScore: mean(rows.map((r) => r.rawScore)),
      avgScoreAfterSignalMultiplier: mean(rows.map((r) => r.scoreAfterSignalMultiplier)),
      avgFinalScoreUsedForRanking: mean(rows.map((r) => r.finalScoreUsedForRanking)),
      avgRankPosition: mean(rows.map((r) => r.rankPosition)),
      selectionRate: rows.length ? rows.filter((r) => r.selected).length / rows.length : null,
    }))
    .sort((a, b) => b.count - a.count || a.signalType.localeCompare(b.signalType));

  const allow = perSignal.find((x) => x.signalType === "allow") ?? null;

  const report = {
    generatedAt: new Date().toISOString(),
    logFile: LOG_FILE,
    ticksAnalyzed: summaries.length,
    candidatesAnalyzed: candidates.length,
    perSignalType: perSignal,
    successCriteriaCheck: {
      allowLowerAfterMultiplierVsRaw:
        allow != null &&
        allow.avgRawScore != null &&
        allow.avgScoreAfterSignalMultiplier != null
          ? allow.avgScoreAfterSignalMultiplier < allow.avgRawScore
          : null,
      allowLowerSelectionRateThanOverall:
        allow != null && allow.selectionRate != null
          ? allow.selectionRate <
            ((candidates.length
              ? candidates.filter((c) => c.selected).length / candidates.length
              : 0) || 0)
          : null,
      note:
        "If allow does not show lower post-multiplier score, worse rank, and lower selectionRate, multiplier may not be influencing final selection as intended.",
    },
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Signal Ranking Impact Report",
    "",
    `- log file: \`${report.logFile}\``,
    `- ticks analyzed: ${report.ticksAnalyzed}`,
    `- candidates analyzed: ${report.candidatesAnalyzed}`,
    "",
    "## Per Signal Type",
    ...report.perSignalType.map(
      (r) =>
        `- ${r.signalType}: n=${r.count}, avgRaw=${num(r.avgRawScore)}, avgAfterMult=${num(
          r.avgScoreAfterSignalMultiplier
        )}, avgFinal=${num(r.avgFinalScoreUsedForRanking)}, avgRank=${num(r.avgRankPosition)}, selectionRate=${pct(
          r.selectionRate
        )}`
    ),
    "",
    "## Success Criteria Check (allow)",
    `- allow lower after-multiplier vs raw: ${String(report.successCriteriaCheck.allowLowerAfterMultiplierVsRaw)}`,
    `- allow lower selection rate vs overall: ${String(report.successCriteriaCheck.allowLowerSelectionRateThanOverall)}`,
    `- note: ${report.successCriteriaCheck.note}`,
    "",
    "- full JSON: `dump/signal-ranking-impact-report.json`",
  ].join("\n");

  await fs.writeFile(OUT_MD, md, "utf8");

  console.log("[signal-ranking-impact-report]");
  console.log("ticks analyzed:", report.ticksAnalyzed);
  console.log("candidates analyzed:", report.candidatesAnalyzed);
  console.log("output files:", OUT_JSON, OUT_MD);
}

main().catch((err) => {
  console.error("[signal-ranking-impact-report] failed", err);
  process.exitCode = 1;
});

