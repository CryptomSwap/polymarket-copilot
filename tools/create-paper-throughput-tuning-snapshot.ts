/**
 * Read-only: condensed paper throughput / tuning snapshot (config + last ticks + open book).
 *
 * Writes:
 * - dump/paper-throughput-tuning-snapshot.json
 * - dump/paper-throughput-tuning-snapshot.md
 *
 * Run: npx tsx tools/create-paper-throughput-tuning-snapshot.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getEffectiveBotProfiles } from "../lib/paper-trading/bot-profiles";
import {
  getPaperTradingConfig,
  DEFAULT_PAPER_TRADING_COOLDOWN_HOURS,
  DEFAULT_PAPER_TRADING_MAX_DAILY_NEW_TRADES,
  DEFAULT_PAPER_TRADING_MAX_OPEN_TOTAL,
  DEFAULT_PAPER_TRADING_MAX_SPREAD_BPS,
} from "../lib/paper-trading/config";
import { normalizeCloseTickResult } from "../lib/paper-trading/normalize-close-tick-result";
import { enablePaperBotBudgetAllocatorV1 } from "../lib/ml/config";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "paper-throughput-tuning-snapshot.json");
const MD_PATH = path.join(DUMP_DIR, "paper-throughput-tuning-snapshot.md");

function optNum(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

const COOLDOWN_MERGE_ORDER =
  "Effective cooldown: `dump/paper-config-optimizer-overrides.json` (v1 `botOverrides.cooldownHours` / `cooldownMarketHours` if present) → `BOT_PROFILES` → global `getPaperTradingConfig()`.";

async function readOptimizerCooldownOverrideBots(): Promise<string[]> {
  const file = path.join(process.cwd(), "dump", "paper-config-optimizer-overrides.json");
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return [];
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as {
      version?: number;
      botOverrides?: Record<string, { cooldownHours?: number; cooldownMarketHours?: number }>;
    };
    if (parsed?.version !== 1 || !parsed.botOverrides) return [];
    return Object.entries(parsed.botOverrides)
      .filter(([, v]) => v && (v.cooldownHours != null || v.cooldownMarketHours != null))
      .map(([k]) => k);
  } catch {
    return [];
  }
}

/** Linear interpolation quantile on sorted array, q in [0,1]. */
function linearQuantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const clamped = Math.min(1, Math.max(0, q));
  const pos = (sorted.length - 1) * clamped;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo]! * (hi - pos) + sorted[hi]! * (pos - lo);
}

type CooldownDiagRow = {
  botType: string;
  effectiveCooldownHours: number;
  effectiveCooldownMarketHours: number;
  baseProfileCooldownHours: number;
  baseProfileCooldownMarketHours: number;
};

function parseMaxHoldHoursNumeric(raw: string | null): number | null {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

async function buildCooldownDiagnosticsFromProfiles(): Promise<{
  perBot: CooldownDiagRow[];
  source?: string;
  loadError?: string;
}> {
  try {
    const profiles = await getEffectiveBotProfiles();
    return {
      perBot: profiles.map((p) => ({
        botType: p.botType,
        effectiveCooldownHours: p.cooldownHours,
        effectiveCooldownMarketHours: p.cooldownMarketHours,
        baseProfileCooldownHours: p.cooldownHours,
        baseProfileCooldownMarketHours: p.cooldownMarketHours,
      })),
      source: "getEffectiveBotProfiles",
    };
  } catch (e) {
    return {
      perBot: [],
      source: "fallback_empty",
      loadError: e instanceof Error ? e.message : String(e),
    };
  }
}

async function buildPaperHoldHorizonFromEnv(globalHours: number | null): Promise<Record<string, unknown>> {
  try {
    const profiles = await getEffectiveBotProfiles();
    const perBot: Record<string, number | null> = {};
    for (const p of profiles) perBot[p.botType] = globalHours;
    return {
      perBotEffectiveMaxHoldHours: perBot,
      globalMaxHoldHours: globalHours,
      source: "PAPER_TRADING_MAX_HOLD_HOURS_env",
    };
  } catch {
    return {
      perBotEffectiveMaxHoldHours: {},
      globalMaxHoldHours: globalHours,
      source: "fallback_empty",
    };
  }
}

function dominantBlocker(row: {
  cooldown: number;
  risk: number;
  spread: number;
  slip: number;
}): { label: string; count: number } {
  const entries = [
    ["cooldown", row.cooldown],
    ["risk_limit", row.risk],
    ["spread_guard", row.spread],
    ["slippage_guard", row.slip],
  ] as const;
  let best = entries[0]!;
  for (const e of entries) {
    if (e[1] > best[1]) best = e;
  }
  return { label: best[0], count: best[1] };
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const maxHoldHours = process.env.PAPER_TRADING_MAX_HOLD_HOURS ?? null;
  const maxHoldHoursNumeric = parseMaxHoldHoursNumeric(maxHoldHours);

  let cfg: {
    maxOpenTotal: number;
    cooldownHours: number;
    paperMaxSpreadBps: number;
    paperMaxEstimatedSlippageBps: number | null;
    maxDailyNewTrades: number;
  };
  let configLoadError: string | null = null;
  try {
    const c = getPaperTradingConfig();
    cfg = {
      maxOpenTotal: c.maxOpenTotal,
      cooldownHours: c.cooldownHours,
      paperMaxSpreadBps: c.paperMaxSpreadBps,
      paperMaxEstimatedSlippageBps: c.paperMaxEstimatedSlippageBps,
      maxDailyNewTrades: c.maxDailyNewTrades,
    };
  } catch (e) {
    configLoadError = e instanceof Error ? e.message : String(e);
    cfg = {
      maxOpenTotal: DEFAULT_PAPER_TRADING_MAX_OPEN_TOTAL,
      cooldownHours: DEFAULT_PAPER_TRADING_COOLDOWN_HOURS,
      paperMaxSpreadBps: DEFAULT_PAPER_TRADING_MAX_SPREAD_BPS,
      paperMaxEstimatedSlippageBps: null,
      maxDailyNewTrades: DEFAULT_PAPER_TRADING_MAX_DAILY_NEW_TRADES,
    };
  }

  let allocatorOn = false;
  try {
    allocatorOn = enablePaperBotBudgetAllocatorV1();
  } catch {
    allocatorOn = false;
  }

  const cooldownDiagnostics = await buildCooldownDiagnosticsFromProfiles();
  const optimizerCooldownOverrideBots = await readOptimizerCooldownOverrideBots();
  const paperHoldHorizon = await buildPaperHoldHorizonFromEnv(maxHoldHoursNumeric);

  const effectiveConfig = {
    maxOpenTotal: cfg.maxOpenTotal,
    cooldownHours: cfg.cooldownHours,
    maxHoldHoursEnv: maxHoldHours,
    maxHoldHours: maxHoldHoursNumeric,
    perBotEffectiveMaxHoldHours: paperHoldHorizon.perBotEffectiveMaxHoldHours,
    globalMaxHoldHoursEcho: paperHoldHorizon.globalMaxHoldHours,
    maxSpreadBps: cfg.paperMaxSpreadBps,
    maxEstimatedSlippageBps: cfg.paperMaxEstimatedSlippageBps,
    maxDailyNewTrades: cfg.maxDailyNewTrades,
    budgetAllocatorEnabled: allocatorOn,
    configLoadError,
    note:
      "Multi-bot path uses per-profile `maxOpenTotal` and per-profile cooldowns from `lib/paper-trading/bot-profiles.ts` (after optimizer file, before global). See `cooldownDiagnostics` and `cooldownMergeOrderNote` in this report. `maxHoldHours` is parsed from `PAPER_TRADING_MAX_HOLD_HOURS`; cooldown snapshot is built from `getEffectiveBotProfiles` when dedicated diagnostics helpers are absent.",
  };

  let dbAvailable = true;
  let dbError: string | null = null;
  let lastOpenTickAt: string | null = null;
  let lastCloseTickAt: string | null = null;
  let openTickSummary: Record<string, unknown> = {};
  let closeSummary: Record<string, unknown> = {};
  let openBook: Record<string, unknown> = {};
  let diagnosis: Record<string, unknown> = {};
  let turnoverCadence: Record<string, unknown> = { note: "db_unavailable" };
  let perBotOpenCapUtilization: Array<{
    botType: string;
    displayName: string;
    effectiveEnabled: boolean;
    maxOpenTotalCap: number;
    openCount: number;
    utilizationPct: number | null;
  }> = [];
  let perBotOpenUnknownTypes: Record<string, number> = {};

  try {
    const state = await prisma.paperTradingState.findUnique({ where: { id: "default" } });
    lastOpenTickAt = state?.lastOpenTickAt?.toISOString() ?? null;
    lastCloseTickAt = state?.lastCloseTickAt?.toISOString() ?? null;

    let openParsed: Record<string, unknown> | null = null;
    if (state?.lastOpenTickResultJson) {
      try {
        openParsed = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
      } catch {
        openParsed = null;
      }
    }

    const cd = optNum(openParsed?.rejectedByCooldownCount) ?? 0;
    const risk = optNum(openParsed?.rejectedByRiskLimitCount) ?? 0;
    const spread = optNum(openParsed?.rejectedBySpreadGuardCount) ?? 0;
    const slip = optNum(openParsed?.rejectedBySlippageGuardCount) ?? 0;
    const dom = dominantBlocker({ cooldown: cd, risk, spread, slip });

    const rebalanceByBotRaw = openParsed?.rebalanceByBot;
    const rebalanceByBot =
      rebalanceByBotRaw &&
      typeof rebalanceByBotRaw === "object" &&
      rebalanceByBotRaw !== null &&
      !Array.isArray(rebalanceByBotRaw)
        ? (rebalanceByBotRaw as Record<string, number>)
        : null;

    openTickSummary = {
      lastOpenTickAt,
      opened: optNum(openParsed?.opened),
      candidatesLoaded: optNum(openParsed?.candidatesLoaded),
      candidatesScored: optNum(openParsed?.candidatesScored),
      aboveThresholdCount: optNum(openParsed?.aboveThresholdCount),
      rejectedByCooldownCount: optNum(openParsed?.rejectedByCooldownCount),
      rejectedByRiskLimitCount: optNum(openParsed?.rejectedByRiskLimitCount),
      rejectedBySpreadGuardCount: optNum(openParsed?.rejectedBySpreadGuardCount),
      rejectedBySlippageGuardCount: optNum(openParsed?.rejectedBySlippageGuardCount),
      rebalanceClosedCount: optNum(openParsed?.rebalanceClosedCount),
      rebalanceByBot,
    };

    let closeParsed: Record<string, unknown> | null = null;
    if (state?.lastCloseTickResultJson) {
      try {
        closeParsed = JSON.parse(state.lastCloseTickResultJson) as Record<string, unknown>;
      } catch {
        closeParsed = null;
      }
    }
    const closeNorm = normalizeCloseTickResult(closeParsed);
    const totalOpenAfter =
      typeof closeParsed?.totalOpenAfter === "number" ? closeParsed.totalOpenAfter : null;

    closeSummary = {
      lastCloseTickAt,
      openTotalCount: closeNorm.openTotalCount,
      dueCount: closeNorm.dueCount,
      closed: closeNorm.closed,
      totalOpenAfter,
      maxHoldHours:
        typeof closeParsed?.maxHoldHours === "number" ? closeParsed.maxHoldHours : maxHoldHoursNumeric,
      legacyShape: closeNorm.legacyShape,
    };

    const openRows = await prisma.paperTrade.findMany({
      where: { status: "open" },
      select: {
        botType: true,
        entryTime: true,
        intendedSize: true,
        entryPrice: true,
      },
    });

    const byBot = new Map<string, number>();
    let notional = 0;
    const entryTimes: Date[] = [];
    for (const r of openRows) {
      byBot.set(r.botType, (byBot.get(r.botType) ?? 0) + 1);
      const sz = parseFloat(r.intendedSize);
      const px = parseFloat(r.entryPrice);
      if (Number.isFinite(sz) && Number.isFinite(px)) notional += sz * px;
      entryTimes.push(r.entryTime);
    }
    const now = Date.now();
    const agesHours = entryTimes.map((t) => (now - t.getTime()) / (60 * 60 * 1000));
    const oldestOpenAgeHours = agesHours.length ? Math.max(...agesHours) : null;
    const newestOpenAgeHours = agesHours.length ? Math.min(...agesHours) : null;

    const effectiveProfiles = await getEffectiveBotProfiles();
    const profileBotTypes = new Set(effectiveProfiles.map((p) => p.botType));
    for (const [bt, n] of byBot) {
      if (!profileBotTypes.has(bt)) {
        perBotOpenUnknownTypes[bt] = n;
      }
    }
    perBotOpenCapUtilization = effectiveProfiles.map((p) => {
      const openCount = byBot.get(p.botType) ?? 0;
      const cap = p.maxOpenTotal;
      const utilizationPct =
        cap > 0 ? Math.round((openCount / cap) * 10000) / 100 : null;
      return {
        botType: p.botType,
        displayName: p.displayName,
        effectiveEnabled: p.effectiveEnabled,
        maxOpenTotalCap: cap,
        openCount,
        utilizationPct,
      };
    });
    const sumPerBotCaps = perBotOpenCapUtilization.reduce((s, r) => s + r.maxOpenTotalCap, 0);

    openBook = {
      openTradeCount: openRows.length,
      byBotType: Object.fromEntries([...byBot.entries()].sort((a, b) => b[1] - a[1])),
      estimatedNotionalOpen: Math.round(notional * 100) / 100,
      oldestOpenAgeHours: oldestOpenAgeHours != null ? Math.round(oldestOpenAgeHours * 100) / 100 : null,
      newestOpenAgeHours: newestOpenAgeHours != null ? Math.round(newestOpenAgeHours * 100) / 100 : null,
      perBotOpenCapUtilization,
      sumPerBotMaxOpenTotal: sumPerBotCaps,
      globalMaxOpenTotal: cfg.maxOpenTotal,
      openTradesNotInProfileBots:
        Object.keys(perBotOpenUnknownTypes).length > 0 ? perBotOpenUnknownTypes : undefined,
    };

    const sortedAges = [...agesHours].sort((a, b) => a - b);
    const avgOpenAgeHours =
      agesHours.length > 0
        ? Math.round((agesHours.reduce((s, a) => s + a, 0) / agesHours.length) * 100) / 100
        : null;
    const p50OpenAgeHours = linearQuantile(sortedAges, 0.5);
    const p90OpenAgeHours = linearQuantile(sortedAges, 0.9);
    const roundedP50 = p50OpenAgeHours != null ? Math.round(p50OpenAgeHours * 100) / 100 : null;
    const roundedP90 = p90OpenAgeHours != null ? Math.round(p90OpenAgeHours * 100) / 100 : null;

    const nearMaxWindowH = 0.1;
    const nearMaxCount =
      maxHoldHoursNumeric != null && maxHoldHoursNumeric > 0
        ? agesHours.filter((a) => a >= maxHoldHoursNumeric - nearMaxWindowH).length
        : 0;
    const nearMaxFraction = agesHours.length > 0 ? nearMaxCount / agesHours.length : 0;
    const turnoverMode: "burst" | "continuous" =
      agesHours.length === 0
        ? "continuous"
        : nearMaxFraction >= 0.4
          ? "burst"
          : "continuous";

    const estRaw =
      maxHoldHoursNumeric != null && maxHoldHoursNumeric > 0 && oldestOpenAgeHours != null
        ? maxHoldHoursNumeric - oldestOpenAgeHours
        : null;
    const estimatedTimeUntilNextCloseWaveHours =
      estRaw != null ? Math.round(Math.max(0, estRaw) * 100) / 100 : null;

    turnoverCadence = {
      maxHoldHours: maxHoldHoursNumeric,
      maxHoldHoursEnv: maxHoldHours,
      avgOpenAgeHours,
      p50OpenAgeHours: roundedP50,
      p90OpenAgeHours: roundedP90,
      estimatedTimeUntilNextCloseWaveHours,
      estimatedTimeNote:
        "max(0, maxHoldHours - oldestOpenAgeHours); proxy for oldest position reaching hold horizon if no other closes interleave.",
      turnoverMode,
      turnoverModeHeuristic:
        ">=40% of open trades have age within 0.1h of maxHold => burst; else continuous (read-only diagnostic).",
      nearMaxHoldBandCount: agesHours.length > 0 ? nearMaxCount : null,
      nearMaxHoldBandFraction: agesHours.length > 0 ? Math.round(nearMaxFraction * 1000) / 1000 : null,
    };

    const turnoverActive =
      maxHoldHoursNumeric != null &&
      maxHoldHoursNumeric > 0 &&
      ((closeNorm.closed != null && closeNorm.closed > 0) ||
        (closeNorm.dueCount != null && closeNorm.dueCount > 0));

    const cap = cfg.maxOpenTotal;
    const nearCap = cap > 0 && openRows.length >= cap * 0.9;

    diagnosis = {
      dominantBlockerFromLatestOpenTick: dom,
      turnoverLikelyActive: turnoverActive,
      turnoverNote:
        "Heuristic: maxHoldHours > 0 and last close tick shows closed > 0 or dueCount > 0. Scheduler may still be idle between runs.",
      portfolioNearGlobalOpenCap: nearCap,
      openCountVsGlobalMax: cap > 0 ? `${openRows.length} / ${cap}` : `${openRows.length} (no global cap)`,
      perBotOpenCapUtilization,
      sumPerBotMaxOpenTotal: sumPerBotCaps,
      capsAlignedWithGlobalNote:
        sumPerBotCaps === cap
          ? "sum(per-bot maxOpenTotal) equals global maxOpenTotal"
          : `sum(per-bot maxOpenTotal)=${sumPerBotCaps} vs global=${cap} (review env PAPER_TRADING_MAX_OPEN_TOTAL and profiles)`,
    };
  } catch (e) {
    dbAvailable = false;
    dbError = e instanceof Error ? e.message : String(e);
    openTickSummary = { error: "db_unavailable" };
    closeSummary = { error: "db_unavailable" };
    openBook = { error: "db_unavailable" };
    try {
      const effectiveProfiles = await getEffectiveBotProfiles();
      perBotOpenCapUtilization = effectiveProfiles.map((p) => ({
        botType: p.botType,
        displayName: p.displayName,
        effectiveEnabled: p.effectiveEnabled,
        maxOpenTotalCap: p.maxOpenTotal,
        openCount: 0,
        utilizationPct: 0,
      }));
    } catch {
      perBotOpenCapUtilization = [];
    }
    const sumFallback = perBotOpenCapUtilization.reduce((s, r) => s + r.maxOpenTotalCap, 0);
    diagnosis = {
      dominantBlockerFromLatestOpenTick: null,
      turnoverLikelyActive: null,
      portfolioNearGlobalOpenCap: null,
      perBotOpenCapUtilization,
      sumPerBotMaxOpenTotal: perBotOpenCapUtilization.length > 0 ? sumFallback : null,
      capsAlignedWithGlobalNote:
        perBotOpenCapUtilization.length > 0 && sumFallback === cfg.maxOpenTotal
          ? "sum(per-bot maxOpenTotal) equals global maxOpenTotal (open counts unavailable — DB error)"
          : perBotOpenCapUtilization.length > 0
            ? `sum(per-bot maxOpenTotal)=${sumFallback} vs global=${cfg.maxOpenTotal}`
            : null,
      dbError,
    };
    turnoverCadence = { note: "db_unavailable", dbError };
  }

  const perBotCooldownEffective = cooldownDiagnostics.perBot.map((p) => ({
    botType: p.botType,
    effectiveCooldownHours: p.effectiveCooldownHours,
    effectiveCooldownMarketHours: p.effectiveCooldownMarketHours,
    baseProfileCooldownHours: p.baseProfileCooldownHours,
    baseProfileCooldownMarketHours: p.baseProfileCooldownMarketHours,
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    dbAvailable,
    configLoadError: configLoadError ?? undefined,
    effectivePaperConfig: effectiveConfig,
    paperHoldHorizonDiagnostics: paperHoldHorizon,
    cooldownMergeOrderNote: COOLDOWN_MERGE_ORDER,
    optimizerCooldownOverrideBots:
      optimizerCooldownOverrideBots.length > 0 ? optimizerCooldownOverrideBots : null,
    perBotCooldownEffective,
    perBotOpenCapUtilization:
      perBotOpenCapUtilization.length > 0 ? perBotOpenCapUtilization : dbAvailable ? [] : null,
    cooldownDiagnostics,
    latestOpenTickSummary: openTickSummary,
    latestCloseSummary: closeSummary,
    openBookSnapshot: openBook,
    turnoverCadence,
    diagnosis,
  };

  await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper throughput tuning snapshot");
  md.push("");
  md.push(`Generated: \`${report.generatedAt}\``);
  md.push(`DB available: **${dbAvailable}**${dbError ? ` — ${dbError}` : ""}`);
  md.push("");
  md.push("## Effective paper config");
  md.push("");
  md.push("| Key | Value |");
  md.push("|-----|-------|");
  md.push(`| maxOpenTotal | ${effectiveConfig.maxOpenTotal} |`);
  md.push(`| cooldownHours | ${effectiveConfig.cooldownHours} |`);
  md.push(`| maxHoldHours (parsed env) | ${effectiveConfig.maxHoldHours ?? "null"} |`);
  md.push(`| maxHoldHoursEnv (raw) | ${effectiveConfig.maxHoldHoursEnv ?? "null"} |`);
  if (effectiveConfig.configLoadError) {
    md.push(`| configLoadError | ${effectiveConfig.configLoadError} |`);
  }
  md.push(
    `| perBotEffectiveMaxHoldHours | ${JSON.stringify(effectiveConfig.perBotEffectiveMaxHoldHours)} |`
  );
  md.push(`| maxSpreadBps | ${effectiveConfig.maxSpreadBps} |`);
  md.push(`| maxEstimatedSlippageBps | ${effectiveConfig.maxEstimatedSlippageBps} |`);
  md.push(`| maxDailyNewTrades | ${effectiveConfig.maxDailyNewTrades} |`);
  md.push(`| budgetAllocatorEnabled | ${effectiveConfig.budgetAllocatorEnabled} |`);
  md.push("");
  md.push(`_${effectiveConfig.note}_`);
  md.push("");
  md.push("## Per-bot effective cooldown (from diagnostics)");
  md.push("");
  md.push(COOLDOWN_MERGE_ORDER);
  md.push("");
  md.push(
    `**Optimizer file overrides cooldown for:** ${report.optimizerCooldownOverrideBots?.join(", ") ?? "(none)"}`
  );
  md.push("");
  md.push("| bot | effective asset (h) | effective market (h) | profile base asset | profile base market |");
  md.push("|-----|---------------------|----------------------|--------------------|--------------------|");
  for (const row of perBotCooldownEffective) {
    md.push(
      `| ${row.botType} | ${row.effectiveCooldownHours} | ${row.effectiveCooldownMarketHours} | ${row.baseProfileCooldownHours ?? "—"} | ${row.baseProfileCooldownMarketHours ?? "—"} |`
    );
  }
  md.push("");
  md.push("## Cooldown (full diagnostics JSON)");
  md.push("");
  md.push(JSON.stringify(cooldownDiagnostics, null, 2));
  md.push("");
  md.push("## Latest open tick");
  md.push("");
  md.push(JSON.stringify(openTickSummary, null, 2));
  md.push("");
  md.push("## Latest close tick");
  md.push("");
  md.push(JSON.stringify(closeSummary, null, 2));
  md.push("");
  md.push("## Open book");
  md.push("");
  md.push(JSON.stringify(openBook, null, 2));
  md.push("");
  md.push("## Per-bot maxOpenTotal caps and utilization");
  md.push("");
  md.push("| bot | effectiveEnabled | cap (maxOpenTotal) | open | utilization % |");
  md.push("|-----|------------------|--------------------|------|----------------|");
  for (const row of perBotOpenCapUtilization) {
    const pct = row.utilizationPct != null ? String(row.utilizationPct) : "—";
    md.push(
      `| ${row.botType} | ${row.effectiveEnabled} | ${row.maxOpenTotalCap} | ${row.openCount} | ${pct} |`
    );
  }
  if (perBotOpenCapUtilization.length === 0) {
    md.push("| _n/a_ | — | — | — | — |");
  } else {
    const sumCaps = perBotOpenCapUtilization.reduce((s, r) => s + r.maxOpenTotalCap, 0);
    md.push("");
    md.push(
      `**Sum of per-bot caps:** ${sumCaps} · **Global maxOpenTotal:** ${cfg.maxOpenTotal}`
    );
  }
  md.push("");
  md.push("## Turnover cadence (diagnostic)");
  md.push("");
  md.push(JSON.stringify(report.turnoverCadence, null, 2));
  md.push("");
  md.push("## Diagnosis");
  md.push("");
  md.push(JSON.stringify(diagnosis, null, 2));
  md.push("");

  await fs.writeFile(MD_PATH, md.join("\n"), "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch(async (e) => {
  console.error(e);
  const msg = e instanceof Error ? e.message : String(e);
  try {
    await fs.mkdir(DUMP_DIR, { recursive: true });
    const fallback = {
      generatedAt: new Date().toISOString(),
      fatalError: msg,
      effectivePaperConfig: null,
      note: "Snapshot incomplete — main() threw before normal report assembly.",
    };
    await fs.writeFile(JSON_PATH, JSON.stringify(fallback, null, 2), "utf8");
    await fs.writeFile(
      MD_PATH,
      ["# Paper throughput tuning snapshot", "", `**Fatal error:** ${msg}`, ""].join("\n"),
      "utf8"
    );
  } catch {
    /* ignore secondary write failure */
  }
  process.exit(1);
});
