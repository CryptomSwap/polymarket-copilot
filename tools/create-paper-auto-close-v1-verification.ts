/**
 * Read-only verification: paper auto-close v1 wiring + optional DB counts.
 * Writes dump/paper-auto-close-v1-verification.{json,md}
 *
 * Run: npx tsx tools/create-paper-auto-close-v1-verification.ts
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import {
  DEFAULT_PAPER_TRADING_MAX_HOLD_HOURS,
  getPaperTradingMaxHoldHours,
} from "../lib/paper-trading/config";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "paper-auto-close-v1-verification.json");
const OUT_MD = path.join(DUMP_DIR, "paper-auto-close-v1-verification.md");
const ENGINE_PATH = path.join(process.cwd(), "lib", "paper-trading", "engine.ts");
const CONFIG_PATH = path.join(process.cwd(), "lib", "paper-trading", "config.ts");
const SCHEDULED_JOBS_PATH = path.join(process.cwd(), "lib", "ops", "scheduled-jobs.ts");

function readUtf8(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function snippetByLine(haystack: string, needle: string, context = 6): string | null {
  const i = haystack.indexOf(needle);
  if (i < 0) return null;
  const lineIndex = haystack.slice(0, i).split(/\r?\n/).length - 1;
  const lines = haystack.split(/\r?\n/);
  const start = Math.max(0, lineIndex - context);
  const end = Math.min(lines.length, lineIndex + context + 1);
  return lines
    .slice(start, end)
    .map((l, j) => `${String(start + j + 1).padStart(5, " ")} | ${l}`)
    .join("\n")
    .slice(0, 4000);
}

async function main(): Promise<void> {
  fs.mkdirSync(DUMP_DIR, { recursive: true });

  const engine = readUtf8(ENGINE_PATH);
  const configSrc = readUtf8(CONFIG_PATH);
  const scheduled = readUtf8(SCHEDULED_JOBS_PATH);

  const configuredMaxHoldHours = getPaperTradingMaxHoldHours();

  const tickStart = engine.indexOf("export async function runPaperTradingTick");
  const tickBlock = tickStart >= 0 ? engine.slice(tickStart, tickStart + 4500) : "";
  const iAuto = tickBlock.indexOf("const autoCloseResult = await closeDuePaperTrades(");
  const iLoad = tickBlock.indexOf("loadShadowCandidatesForPaperTick");
  const tickCallsCloseDue =
    iAuto >= 0 && iLoad >= 0 && iAuto < iLoad && tickBlock.includes("getPaperTradingMaxHoldHours()");

  const close12hIsWrapper =
    /export\s+async\s+function\s+closePaperTradesAt12h\s*\([^)]*\)[^{]*\{[\s\S]*?await\s+closeDuePaperTrades\s*\(\s*\{[\s\S]*?maxHoldHours:\s*12[\s\S]*?reasonCode:\s*["']max_hold_12h["']/.test(
      engine
    );

  const scheduledRoutesViaWrapper =
    scheduled.includes('case "paper_trading_close_due"') &&
    scheduled.includes("closePaperTradesAt12h") &&
    /paper_trading_close_due[\s\S]{0,400}closePaperTradesAt12h/.test(scheduled);

  const openDefInEngine =
    (engine.match(/status:\s*["']open["']/g) ?? []).length >= 2;

  let db: {
    available: boolean;
    error?: string;
    totalOpen?: number;
    eligibleToClose?: number;
    byBotOpen?: Record<string, number>;
    byBotEligible?: Record<string, number>;
    maxHoldHoursUsedForEligible?: number | null;
  } = { available: false };

  try {
    const { prisma } = await import("../lib/db");
    const maxH = configuredMaxHoldHours;

    const openByBot = await prisma.paperTrade.groupBy({
      by: ["botType"],
      where: { status: "open" },
      _count: { _all: true },
    });
    const byBotOpen: Record<string, number> = {};
    for (const r of openByBot) byBotOpen[r.botType] = r._count._all;
    const totalOpen = Object.values(byBotOpen).reduce((a, b) => a + b, 0);

    let eligibleToClose = 0;
    const byBotEligible: Record<string, number> = {};
    if (maxH > 0) {
      const cutoff = new Date(Date.now() - maxH * 60 * 60 * 1000);
      const eligibleByBot = await prisma.paperTrade.groupBy({
        by: ["botType"],
        where: { status: "open", entryTime: { lte: cutoff } },
        _count: { _all: true },
      });
      for (const r of eligibleByBot) {
        byBotEligible[r.botType] = r._count._all;
        eligibleToClose += r._count._all;
      }
    }

    db = {
      available: true,
      totalOpen,
      eligibleToClose,
      byBotOpen,
      byBotEligible,
      maxHoldHoursUsedForEligible: maxH > 0 ? maxH : null,
    };
    await prisma.$disconnect();
  } catch (e) {
    db = {
      available: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const json = {
    generatedAt: new Date().toISOString(),
    configuredMaxHoldHours,
    defaultMaxHoldHoursConstant: DEFAULT_PAPER_TRADING_MAX_HOLD_HOURS,
    codeChecks: {
      canonicalOpenStatusFilter: openDefInEngine,
      runPaperTradingTickCallsCloseDuePaperTradesAtStart: tickCallsCloseDue,
      closePaperTradesAt12hIsThinWrapperOverCloseDue: close12hIsWrapper,
      scheduledCloseDueUsesClosePaperTradesAt12h: scheduledRoutesViaWrapper,
    },
    fileReferences: {
      engine: "lib/paper-trading/engine.ts",
      config: "lib/paper-trading/config.ts",
      scheduledJobs: "lib/ops/scheduled-jobs.ts",
      paperCloseHelpers: "lib/paper-trading/paper-close-helpers.ts",
      resolveExitPrice: "lib/polymarket/market-price-snapshot-lookup.ts",
    },
    database: db,
  };

  const mdLines: string[] = [
    "# Paper auto-close v1 verification",
    "",
    `Generated: \`${json.generatedAt}\``,
    "",
    "## Configured max hold (runtime)",
    "",
    `- **getPaperTradingMaxHoldHours()** → \`${configuredMaxHoldHours}\` (env-driven; 0 = disabled)`,
    `- Default constant: \`${DEFAULT_PAPER_TRADING_MAX_HOLD_HOURS}\``,
    "",
    "## Code checks",
    "",
    "| Check | OK |",
    "|-------|-----|",
    `| Engine uses \`status: "open"\` in close path (heuristic) | ${openDefInEngine ? "yes" : "no"} |`,
    `| \`runPaperTradingTick\` calls \`closeDuePaperTrades\` before \`loadShadowCandidatesForPaperTick\` | ${tickCallsCloseDue ? "yes" : "no"} |`,
    `| \`closePaperTradesAt12h\` delegates to \`closeDuePaperTrades({ maxHoldHours: 12, reasonCode: 'max_hold_12h' })\` | ${close12hIsWrapper ? "yes" : "no"} |`,
    `| \`paper_trading_close_due\` job imports \`closePaperTradesAt12h\` | ${scheduledRoutesViaWrapper ? "yes" : "no"} |`,
    "",
    "## Database (live counts)",
    "",
  ];

  if (db.available) {
    mdLines.push(
      `- **Total open** (\`status === "open"\`): ${db.totalOpen}`,
      `- **Eligible to close** under configured hold (\`entryTime <= now - maxHoldHours\`): ${db.eligibleToClose}` +
        (db.maxHoldHoursUsedForEligible == null
          ? " _(hold disabled: \`PAPER_TRADING_MAX_HOLD_HOURS=0\`)_"
          : ` _(hold=${db.maxHoldHoursUsedForEligible}h)_`),
      "",
      "### By bot (open)",
      "",
      "```json",
      JSON.stringify(db.byBotOpen ?? {}, null, 2),
      "```",
      "",
      "### By bot (eligible)",
      "",
      "```json",
      JSON.stringify(db.byBotEligible ?? {}, null, 2),
      "```",
      ""
    );
  } else {
    mdLines.push(
      "_Database section unavailable._",
      "",
      db.error ? `Error: \`${db.error.replace(/`/g, "'")}\`` : "",
      ""
    );
  }

  mdLines.push(
    "## Evidence snippets",
    "",
    "### `getPaperTradingMaxHoldHours` (config.ts)",
    "",
    "```ts",
    snippetByLine(configSrc, "export function getPaperTradingMaxHoldHours", 8) ?? "(not found)",
    "```",
    "",
    "### Tick start auto-close (engine.ts)",
    "",
    "```ts",
    snippetByLine(engine, "const autoCloseResult = await closeDuePaperTrades", 10) ?? "(not found)",
    "```",
    "",
    "### `closePaperTradesAt12h` wrapper (engine.ts)",
    "",
    "```ts",
    snippetByLine(engine, "export async function closePaperTradesAt12h", 12) ?? "(not found)",
    "```",
    "",
    "### Scheduled job (scheduled-jobs.ts)",
    "",
    "```ts",
    snippetByLine(scheduled, 'case "paper_trading_close_due"', 10) ?? "(not found)",
    "```",
    ""
  );

  fs.writeFileSync(OUT_JSON, JSON.stringify(json, null, 2), "utf8");
  fs.writeFileSync(OUT_MD, mdLines.join("\n"), "utf8");
  console.info("Wrote", OUT_JSON);
  console.info("Wrote", OUT_MD);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
