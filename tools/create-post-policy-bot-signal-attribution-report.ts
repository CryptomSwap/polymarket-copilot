/**
 * Post-policy bot+signal attribution report (read-only).
 * Identifies which bot/signal combinations drive current expectancy.
 */
import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "post-policy-bot-signal-attribution-report.json");
const OUT_MD = path.join(DUMP_DIR, "post-policy-bot-signal-attribution-report.md");
const OUT_CHAT = path.join(DUMP_DIR, "post-policy-bot-signal-attribution-report-chat-summary.md");

const AFTER_RAW = process.env.POSTFIX_LINKAGE_AFTER?.trim();
const N = Math.min(
  10000,
  Math.max(20, Number(process.env.POST_POLICY_BOT_SIGNAL_ATTRIBUTION_N ?? "300") || 300)
);
const MIN_PAIR_COUNT = 5;

type TradeRow = {
  id: string;
  entryTime: Date;
  botType: string;
  metadataJson: string | null;
  markout12h: string | null;
  pnlPct: string | null;
};

type BotStats = {
  botType: string;
  count: number;
  avgMarkout: number | null;
  positiveRate: number | null;
  medianMarkout: number | null;
};

type BotSignalStats = {
  botType: string;
  signalType: string;
  count: number;
  avgMarkout: number | null;
  positiveRate: number | null;
  medianMarkout: number | null;
  shareWithinBot: number;
};

function parseNum(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function markoutProxy(markout12h: string | null, pnlPct: string | null): number | null {
  return parseNum(markout12h) ?? parseNum(pnlPct);
}

function resolveSignalType(metadataJson: string | null): string {
  if (!metadataJson) return "unknown";
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const open = (o.openAttribution ?? {}) as Record<string, unknown>;
    const exec = (open.executionContext ?? {}) as Record<string, unknown>;
    const candidates = [
      exec.policyState,
      o.signalType,
      o.derivationSource,
      o.candidateSource,
      o.executionPolicyState,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim().toLowerCase();
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avgMarkout: sorted.length ? sorted.reduce((a, c) => a + c, 0) / sorted.length : null,
    positiveRate: sorted.length ? sorted.filter((x) => x > 0).length / sorted.length : null,
    medianMarkout: quantile(sorted, 0.5),
  };
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
  if (!AFTER_RAW) {
    console.error("POSTFIX_LINKAGE_AFTER is required.");
    process.exit(1);
  }
  const cutoff = new Date(AFTER_RAW);
  if (Number.isNaN(cutoff.getTime())) {
    console.error("POSTFIX_LINKAGE_AFTER invalid ISO date:", AFTER_RAW);
    process.exit(1);
  }
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const rows = (await prisma.paperTrade.findMany({
    where: { entryTime: { gte: cutoff } },
    orderBy: { entryTime: "desc" },
    take: N,
    select: {
      id: true,
      entryTime: true,
      botType: true,
      metadataJson: true,
      markout12h: true,
      pnlPct: true,
    },
  })) as TradeRow[];

  const trades = rows.map((r) => ({
    paperTradeId: r.id,
    entryTime: r.entryTime.toISOString(),
    botType: r.botType || "unknown",
    signalType: resolveSignalType(r.metadataJson),
    markout: markoutProxy(r.markout12h, r.pnlPct),
  }));

  const withMarkout = trades.filter((t) => t.markout != null);

  // B) By botType
  const byBotMap = new Map<string, number[]>();
  for (const t of trades) {
    const arr = byBotMap.get(t.botType) ?? [];
    if (t.markout != null) arr.push(t.markout);
    byBotMap.set(t.botType, arr);
  }
  const byBot: BotStats[] = [...byBotMap.entries()]
    .map(([botType, vals]) => {
      const count = trades.filter((t) => t.botType === botType).length;
      const s = summarize(vals);
      return { botType, count, ...s };
    })
    .sort((a, b) => b.count - a.count || a.botType.localeCompare(b.botType));

  // C) By botType + signalType
  const byBotSignalMap = new Map<string, number[]>();
  const botCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (const t of trades) {
    const bot = t.botType;
    const sig = t.signalType;
    const key = `${bot}\0${sig}`;
    botCounts.set(bot, (botCounts.get(bot) ?? 0) + 1);
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    const arr = byBotSignalMap.get(key) ?? [];
    if (t.markout != null) arr.push(t.markout);
    byBotSignalMap.set(key, arr);
  }

  const byBotSignal: BotSignalStats[] = [...pairCounts.entries()]
    .map(([key, count]) => {
      const [botType, signalType] = key.split("\0");
      const vals = byBotSignalMap.get(key) ?? [];
      const s = summarize(vals);
      const botN = botCounts.get(botType) ?? 0;
      return {
        botType,
        signalType,
        count,
        ...s,
        shareWithinBot: botN > 0 ? count / botN : 0,
      };
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.botType.localeCompare(b.botType) ||
        a.signalType.localeCompare(b.signalType)
    );

  // D) Best and worst pairs
  const eligiblePairs = byBotSignal.filter((p) => p.count >= MIN_PAIR_COUNT && p.avgMarkout != null);
  const top5BestPairs = [...eligiblePairs].sort((a, b) => (b.avgMarkout ?? 0) - (a.avgMarkout ?? 0)).slice(0, 5);
  const bottom5WorstPairs = [...eligiblePairs].sort((a, b) => (a.avgMarkout ?? 0) - (b.avgMarkout ?? 0)).slice(0, 5);

  const dominantPositiveDriver = top5BestPairs.length
    ? `${top5BestPairs[0]!.botType}+${top5BestPairs[0]!.signalType}`
    : "none";
  const dominantNegativeDriver = bottom5WorstPairs.length
    ? `${bottom5WorstPairs[0]!.botType}+${bottom5WorstPairs[0]!.signalType}`
    : "none";

  const recommendation = (() => {
    if (withMarkout.length < 40) return "collect more data";
    const worstAllow = bottom5WorstPairs.find((p) => p.signalType === "allow");
    if (worstAllow && worstAllow.botType !== "unknown") return "penalize allow only for specific bots";
    if (bottom5WorstPairs.some((p) => p.signalType === "allow")) return "penalize allow more";
    if (top5BestPairs.some((p) => p.signalType === "warn")) return "promote warn for specific bots";
    if (top5BestPairs.length > 0 && (top5BestPairs[0]!.avgMarkout ?? -1) > 0) return "keep current policy";
    return "collect more data";
  })();

  const report = {
    generatedAt: new Date().toISOString(),
    env: {
      POSTFIX_LINKAGE_AFTER: AFTER_RAW,
      POST_POLICY_BOT_SIGNAL_ATTRIBUTION_N: N,
      MIN_PAIR_COUNT: MIN_PAIR_COUNT,
    },
    scope: {
      cutoffUsed: cutoff.toISOString(),
      rowsScanned: trades.length,
      rowsWithMarkoutOrPnl: withMarkout.length,
    },
    byBotType: byBot,
    byBotTypeAndSignalType: byBotSignal,
    bestAndWorstBotSignalPairs: {
      top5ByAvgMarkoutMinCount5: top5BestPairs,
      bottom5ByAvgMarkoutMinCount5: bottom5WorstPairs,
    },
    interpretation: {
      dominantPositiveDriver,
      dominantNegativeDriver,
      recommendation,
    },
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Post-Policy Bot+Signal Attribution Report",
    "",
    "## A) Scope",
    `- cutoff used: ${report.scope.cutoffUsed}`,
    `- rows scanned: ${report.scope.rowsScanned}`,
    `- rows with markout/pnl: ${report.scope.rowsWithMarkoutOrPnl}`,
    "",
    "## B) By botType",
    ...report.byBotType.map(
      (b) =>
        `- ${b.botType}: n=${b.count}, avg=${num(b.avgMarkout)}, positive=${pct(
          b.positiveRate
        )}, median=${num(b.medianMarkout)}`
    ),
    "",
    "## C) By botType + signalType",
    ...report.byBotTypeAndSignalType.map(
      (p) =>
        `- ${p.botType} + ${p.signalType}: n=${p.count}, avg=${num(p.avgMarkout)}, positive=${pct(
          p.positiveRate
        )}, median=${num(p.medianMarkout)}, shareWithinBot=${pct(p.shareWithinBot)}`
    ),
    "",
    "## D) Best and Worst bot+signal pairs (min count 5)",
    ...report.bestAndWorstBotSignalPairs.top5ByAvgMarkoutMinCount5.map(
      (p) => `- BEST: ${p.botType}+${p.signalType} avg=${num(p.avgMarkout)} n=${p.count}`
    ),
    ...report.bestAndWorstBotSignalPairs.bottom5ByAvgMarkoutMinCount5.map(
      (p) => `- WORST: ${p.botType}+${p.signalType} avg=${num(p.avgMarkout)} n=${p.count}`
    ),
    "",
    "## E) Interpretation",
    `- dominantPositiveDriver: ${report.interpretation.dominantPositiveDriver}`,
    `- dominantNegativeDriver: ${report.interpretation.dominantNegativeDriver}`,
    `- recommendation: ${report.interpretation.recommendation}`,
    "",
    "- full JSON: `dump/post-policy-bot-signal-attribution-report.json`",
  ].join("\n");
  await fs.writeFile(OUT_MD, md, "utf8");

  const chat = [
    "# Post-Policy Bot+Signal Attribution (Chat Summary)",
    "",
    `- rows scanned: ${report.scope.rowsScanned}`,
    `- rows with markout/pnl: ${report.scope.rowsWithMarkoutOrPnl}`,
    `- best pair: ${report.interpretation.dominantPositiveDriver}`,
    `- worst pair: ${report.interpretation.dominantNegativeDriver}`,
    `- recommendation: ${report.interpretation.recommendation}`,
    "",
    "- paste this file back into chat: `dump/post-policy-bot-signal-attribution-report-chat-summary.md`",
  ].join("\n");
  await fs.writeFile(OUT_CHAT, chat, "utf8");

  const bestPair = top5BestPairs[0] ? `${top5BestPairs[0].botType}+${top5BestPairs[0].signalType}` : "none";
  const worstPair = bottom5WorstPairs[0]
    ? `${bottom5WorstPairs[0].botType}+${bottom5WorstPairs[0].signalType}`
    : "none";
  console.log("[post-policy-bot-signal-attribution-report]");
  console.log("rows scanned:", report.scope.rowsScanned);
  console.log("best bot+signal pair:", bestPair);
  console.log("worst bot+signal pair:", worstPair);
  console.log("recommendation:", report.interpretation.recommendation);
  console.log("output files:", OUT_JSON, OUT_MD, OUT_CHAT);
}

main().catch((err) => {
  console.error("[post-policy-bot-signal-attribution-report] failed", err);
  process.exitCode = 1;
});

