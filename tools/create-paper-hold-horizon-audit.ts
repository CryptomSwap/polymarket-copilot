/**
 * Read-only audit: paper max-hold global vs per-bot, recent closes vs configured horizons.
 * Writes dump/paper-hold-horizon-audit.{json,md}
 *
 * Run: npx tsx tools/create-paper-hold-horizon-audit.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getPaperTradingMaxHoldHours } from "../lib/paper-trading/config";
import { getPaperHoldHorizonDiagnostics } from "../lib/paper-trading/bot-profiles";

const DUMP = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP, "paper-hold-horizon-audit.json");
const MD_PATH = path.join(DUMP, "paper-hold-horizon-audit.md");

const MS_D7 = 7 * 24 * 60 * 60 * 1000;

function parseCloseReason(metadataJson: string | null | undefined): string {
  if (!metadataJson) return "unknown";
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const pc = o.paperClose as Record<string, unknown> | undefined;
    const c = pc?.closeReasonCode;
    return typeof c === "string" && c.length > 0 ? c : "unknown";
  } catch {
    return "unknown";
  }
}

function holdHoursFromReasonCode(code: string): number | null {
  const m = /^max_hold_([\d.]+)h$/.exec(code);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  return Number.isFinite(n) ? n : null;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP, { recursive: true });
  const generatedAt = new Date().toISOString();

  let dbOk = false;
  let dbError: string | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  if (!dbOk) {
    const partial = { generatedAt, dbReachable: false, dbError };
    await fs.writeFile(JSON_PATH, JSON.stringify(partial, null, 2), "utf8");
    await fs.writeFile(MD_PATH, `# Paper hold horizon audit\n\nDB unreachable.\n\n\`\`\`\n${dbError}\n\`\`\`\n`, "utf8");
    console.log("DB unreachable:", dbError);
    await prisma.$disconnect().catch(() => undefined);
    return;
  }

  const globalHold = getPaperTradingMaxHoldHours();
  const holdDiag = await getPaperHoldHorizonDiagnostics();
  const since7 = new Date(Date.now() - MS_D7);

  const closed7d = await prisma.paperTrade.findMany({
    where: { status: "closed", exitTime: { gte: since7 } },
    select: {
      botType: true,
      entryTime: true,
      exitTime: true,
      pnlPct: true,
      metadataJson: true,
    },
    take: 15_000,
    orderBy: { exitTime: "desc" },
  });

  const effectiveHold = (bot: string | null | undefined) =>
    holdDiag.perBotEffectiveMaxHoldHours[bot ?? "default"] ?? holdDiag.globalMaxHoldHours;

  type BotAgg = {
    count: number;
    totalHold: number;
    totalPnl: number;
    pnlN: number;
    reasonCounts: Record<string, number>;
    holdMatchesConfigured: number;
    holdMismatchApprox: number;
    reasonHoldParsed: number;
  };
  const byBot: Record<string, BotAgg> = {};

  for (const r of closed7d) {
    const b = r.botType ?? "default";
    if (!byBot[b]) {
      byBot[b] = {
        count: 0,
        totalHold: 0,
        totalPnl: 0,
        pnlN: 0,
        reasonCounts: {},
        holdMatchesConfigured: 0,
        holdMismatchApprox: 0,
        reasonHoldParsed: 0,
      };
    }
    const agg = byBot[b]!;
    agg.count++;
    const ex = r.exitTime;
    const holdH = ex ? (ex.getTime() - r.entryTime.getTime()) / (60 * 60 * 1000) : 0;
    agg.totalHold += holdH;
    const pnl = r.pnlPct != null ? parseFloat(r.pnlPct) : NaN;
    if (Number.isFinite(pnl)) {
      agg.totalPnl += pnl;
      agg.pnlN++;
    }
    const reason = parseCloseReason(r.metadataJson);
    agg.reasonCounts[reason] = (agg.reasonCounts[reason] ?? 0) + 1;
    const cfgH = effectiveHold(b);
    const rh = holdHoursFromReasonCode(reason);
    if (rh != null) {
      agg.reasonHoldParsed++;
      if (Math.abs(rh - cfgH) < 0.05) agg.holdMatchesConfigured++;
      else agg.holdMismatchApprox++;
    }
  }

  const byBotSummary: Record<
    string,
    {
      configuredMaxHoldHours: number;
      closedCount7d: number;
      avgHoldHours: number | null;
      avgPnlPct: number | null;
      exitReasonTop: { reason: string; count: number }[];
      alignmentNote: string;
    }
  > = {};

  for (const [bot, agg] of Object.entries(byBot)) {
    const configured = effectiveHold(bot);
    const avgHold = agg.count > 0 ? agg.totalHold / agg.count : null;
    const avgPnl = agg.pnlN > 0 ? agg.totalPnl / agg.pnlN : null;
    const exitReasonTop = Object.entries(agg.reasonCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([reason, count]) => ({ reason, count }));
    let alignmentNote = "no max_hold_* closeReasonCode in sample";
    if (agg.reasonHoldParsed > 0) {
      const pct = (100 * agg.holdMatchesConfigured) / agg.reasonHoldParsed;
      alignmentNote = `${pct.toFixed(1)}% of parsed max_hold_* reasons match configured hold (${agg.holdMatchesConfigured}/${agg.reasonHoldParsed}); mismatches often pre-date per-bot rollout or manual/API closes.`;
    }
    byBotSummary[bot] = {
      configuredMaxHoldHours: configured,
      closedCount7d: agg.count,
      avgHoldHours: avgHold != null ? Math.round(avgHold * 1000) / 1000 : null,
      avgPnlPct: avgPnl != null ? Math.round(avgPnl * 1e6) / 1e6 : null,
      exitReasonTop,
      alignmentNote,
    };
  }

  let lastCloseMeta: Record<string, unknown> | null = null;
  try {
    const st = await prisma.paperTradingState.findUnique({ where: { id: "default" } });
    if (st?.lastCloseTickResultJson) {
      lastCloseMeta = JSON.parse(st.lastCloseTickResultJson) as Record<string, unknown>;
    }
  } catch {
    lastCloseMeta = null;
  }

  const report = {
    generatedAt,
    dbReachable: true,
    globalMaxHoldHours: globalHold,
    holdHorizonDiagnostics: holdDiag,
    closedTradesAnalyzed7d: closed7d.length,
    byBotSummary,
    lastCloseTickPersisted: lastCloseMeta
      ? {
          maxHoldHours: lastCloseMeta.maxHoldHours,
          usedPerBotHoldHorizons: lastCloseMeta.usedPerBotHoldHorizons,
          perBotEffectiveMaxHoldHours: lastCloseMeta.perBotEffectiveMaxHoldHours,
        }
      : null,
  };

  await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [
    "# Paper hold horizon audit",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Global vs per-bot configured hold",
    "",
    `- **Global (env default):** ${globalHold}h`,
    "",
    "| bot | effective max hold (h) |",
    "|-----|------------------------|",
    ...Object.entries(holdDiag.perBotEffectiveMaxHoldHours)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([b, h]) => `| ${b} | ${h} |`),
    "",
    "## Last close tick persisted (PaperTradingState)",
    "",
    "```json",
    JSON.stringify(report.lastCloseTickPersisted, null, 2),
    "```",
    "",
    "## Recent closes by bot (7d, up to 15k rows)",
    "",
    ...Object.entries(byBotSummary)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([bot, s]) => [
        `### ${bot}`,
        "",
        `- Configured max hold: **${s.configuredMaxHoldHours}h**`,
        `- Closed (sample): **${s.closedCount7d}**`,
        `- Avg hold: ${s.avgHoldHours ?? "—"}`,
        `- Avg pnlPct: ${s.avgPnlPct != null ? (s.avgPnlPct * 100).toFixed(4) + "%" : "—"}`,
        `- Alignment: ${s.alignmentNote}`,
        "",
        "Exit reasons (top):",
        "",
        "```json",
        JSON.stringify(s.exitReasonTop, null, 2),
        "```",
        "",
      ]),
    holdDiag.note,
    "",
  ];

  await fs.writeFile(MD_PATH, md.join("\n"), "utf8");
  console.log("Wrote", JSON_PATH);
  console.log("Wrote", MD_PATH);

  await prisma.$disconnect().catch(() => undefined);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
