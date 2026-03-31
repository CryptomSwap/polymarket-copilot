/**
 * Read-only report: schema + code map + live DB stats for paper auto-close v1 readiness.
 * Writes dump/paper-exit-readiness-dump.{json,md}
 *
 * Run: npx tsx tools/create-paper-exit-readiness-dump.ts
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "paper-exit-readiness-dump.json");
const OUT_MD = path.join(DUMP_DIR, "paper-exit-readiness-dump.md");
const SCHEMA_PATH = path.join(process.cwd(), "prisma", "schema.prisma");
const SCAN_ROOTS = ["lib", "app", "tools", "worker"] as const;
const SCAN_EXT = new Set([".ts", ".tsx"]);
const IGNORE_DIR = new Set([
  "node_modules",
  ".next",
  "dist",
  "coverage",
  "__tests__",
  ".git",
]);

const HOLD_HOURS = [6, 12, 24, 48] as const;

const SCAN_PATTERNS: { id: string; re: RegExp; description: string }[] = [
  { id: "prisma.paperTrade", re: /\bprisma\.paperTrade\b/, description: "Prisma client access" },
  { id: 'status: "open"', re: /status:\s*["']open["']/, description: "Explicit open status filter" },
  { id: "closedAt", re: /\bclosedAt\b/, description: "closedAt identifier" },
  { id: "exitReason", re: /\bexitReason\b/, description: "exitReason identifier" },
  { id: "closeReason", re: /\bcloseReason\b/, description: "closeReason identifier" },
  { id: "settle", re: /\bsettle\w*\b/i, description: "settle* tokens (broad)" },
  { id: "finalize", re: /\bfinalize\w*\b/i, description: "finalize* tokens (broad)" },
  { id: "runPaperTradingTick", re: /\brunPaperTradingTick\b/, description: "Paper open tick entry" },
  { id: "closePaperTradesAt12h", re: /\bclosePaperTradesAt12h\b/, description: "Paper 12h close job" },
  { id: "paper_trading_tick", re: /paper_trading_tick/, description: "Scheduler job name" },
  { id: "paper_trading_close_due", re: /paper_trading_close_due/, description: "Close-due scheduler job" },
];

function extractPaperTradeModelBlock(schemaText: string): string | null {
  const re = /model\s+PaperTrade\s*\{/m;
  const m = schemaText.match(re);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < schemaText.length && depth > 0) {
    const c = schemaText[i]!;
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  if (depth !== 0) return null;
  return schemaText.slice(start, i - 1);
}

function parsePaperTradeFields(block: string): {
  fields: { name: string; prismaType: string }[];
  lifecycleFields: string[];
  indexes: string[];
} {
  const lines = block.split(/\r?\n/);
  const fields: { name: string; prismaType: string }[] = [];
  const indexes: string[] = [];
  const lifecycleHints =
    /^(id|status|entryTime|exitTime|entryPrice|exitPrice|markout|pnl|metadata|createdAt|updatedAt|dedupe|botType|side|score|threshold|intendedSize|modelRun)/i;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("///")) continue;
    if (line.startsWith("@@")) {
      indexes.push(line);
      continue;
    }
    const m = line.match(/^(\w+)\s+(\S+)/);
    if (m?.[1] && m[1] !== "model") fields.push({ name: m[1], prismaType: m[2]! });
  }

  const seen = new Set<string>();
  const uniq: { name: string; prismaType: string }[] = [];
  for (const f of fields) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    uniq.push(f);
  }
  const lifecycleFields = uniq.filter((f) => lifecycleHints.test(f.name)).map((f) => f.name);

  return { fields: uniq, lifecycleFields, indexes };
}

function walkFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (IGNORE_DIR.has(ent.name)) continue;
      walkFiles(p, out);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name);
      if (SCAN_EXT.has(ext)) out.push(p);
    }
  }
}

type Hit = { file: string; line: number; text: string; patternId: string };

function scanRepo(repoRoot: string): Hit[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    walkFiles(path.join(repoRoot, root), files);
  }
  const hits: Hit[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";
    for (const p of SCAN_PATTERNS) {
      if (p.re.test(lineText)) {
        hits.push({ file: rel, line: i + 1, text: lineText.trim().slice(0, 200), patternId: p.id });
      }
    }
    }
  }
  return hits;
}

function aggregateHits(hits: Hit[]): Record<string, { file: string; hits: number }[]> {
  const byPattern: Record<string, Map<string, number>> = {};
  for (const p of SCAN_PATTERNS) byPattern[p.id] = new Map();
  for (const h of hits) {
    const m = byPattern[h.patternId];
    if (!m) continue;
    m.set(h.file, (m.get(h.file) ?? 0) + 1);
  }
  const out: Record<string, { file: string; hits: number }[]> = {};
  for (const [pid, map] of Object.entries(byPattern)) {
    out[pid] = [...map.entries()]
      .map(([file, n]) => ({ file, hits: n }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 20);
  }
  return out;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const repoRoot = process.cwd();

  fs.mkdirSync(DUMP_DIR, { recursive: true });

  let schemaText = "";
  try {
    schemaText = fs.readFileSync(SCHEMA_PATH, "utf8");
  } catch {
    schemaText = "";
  }
  const ptBlock = schemaText ? extractPaperTradeModelBlock(schemaText) : null;
  const parsed = ptBlock ? parsePaperTradeFields(ptBlock) : { fields: [], lifecycleFields: [], indexes: [] };

  const absentLifecycleColumns = [
    "openedAt",
    "closedAt",
    "exitedAt",
    "settledAt",
    "resolvedAt",
    "closeReason (dedicated column)",
    "exitReason (dedicated column)",
    "isOpen (boolean)",
  ];

  const hits = scanRepo(repoRoot);
  const hitSummary = aggregateHits(hits);

  const emptyAgeHours = {
    min: null as number | null,
    p25: null as number | null,
    p50: null as number | null,
    p75: null as number | null,
    p90: null as number | null,
    p95: null as number | null,
    max: null as number | null,
  };

  function emptyEligibleByHold(): Record<string, { total: number; byBot: Record<string, number> }> {
    const o: Record<string, { total: number; byBot: Record<string, number> }> = {};
    for (const h of HOLD_HOURS) o[String(h)] = { total: 0, byBot: {} };
    return o;
  }

  const openTradeDefinitionCandidates = [
    {
      name: "canonical_open_row",
      source: "schema + engine + cooldown",
      definition: '`status === "open"` (string column, default "open" in Prisma schema).',
      prismaWhere: '{ status: "open" }',
      codeRefs: [
        "lib/paper-trading/engine.ts — capacity, dedupe, closePaperTradesAt12h openTotalCount",
        "lib/paper-trading/paper-cooldown.ts — paperCooldownWhereOpenForAsset / paperCooldownWhereOpenForMarket",
      ],
    },
    {
      name: "due_for_scheduled_12h_close",
      source: "closePaperTradesAt12h",
      definition:
        'Open rows whose entryTime is at or before `paperCloseDueBefore(now, PAPER_CLOSE_HORIZON_MS)` (i.e. entryTime <= now - 12h). Subset of open book.',
      prismaWhere:
        '{ status: "open", entryTime: { lte: horizonEnd } } per lib/paper-trading/paper-close-due-selection-audit.ts',
      codeRefs: ["lib/paper-trading/engine.ts — closePaperTradesAt12h", "lib/paper-trading/paper-close-helpers.ts"],
    },
  ];

  type OpenRow = {
    id: string;
    botType: string;
    status: string;
    createdAt: Date;
    entryTime: Date | null;
    side: string;
    score: number;
    marketId: string;
    metadataJson: string | null;
  };

  let dbError: string | null = null;
  let openRows: OpenRow[] = [];
  try {
    openRows = await prisma.paperTrade.findMany({
      where: { status: "open" },
      select: {
        id: true,
        botType: true,
        status: true,
        createdAt: true,
        entryTime: true,
        side: true,
        score: true,
        marketId: true,
        metadataJson: true,
      },
    });
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  const now = Date.now();
  let openedAtCount = 0;
  let createdAtFallbackCount = 0;
  const ageHoursList: number[] = [];

  for (const r of openRows) {
    let basis: Date;
    if (r.entryTime != null) {
      basis = r.entryTime;
      openedAtCount++;
    } else {
      basis = r.createdAt;
      createdAtFallbackCount++;
    }
    ageHoursList.push((now - basis.getTime()) / (60 * 60 * 1000));
  }
  ageHoursList.sort((a, b) => a - b);

  const ageStats = {
    min: ageHoursList.length ? round4(ageHoursList[0]!) : null,
    p25: ageHoursList.length ? round4(percentile(ageHoursList, 25)!) : null,
    p50: ageHoursList.length ? round4(percentile(ageHoursList, 50)!) : null,
    p75: ageHoursList.length ? round4(percentile(ageHoursList, 75)!) : null,
    p90: ageHoursList.length ? round4(percentile(ageHoursList, 90)!) : null,
    p95: ageHoursList.length ? round4(percentile(ageHoursList, 95)!) : null,
    max: ageHoursList.length ? round4(ageHoursList[ageHoursList.length - 1]!) : null,
  };

  function eligibleByHold(hours: number): { total: number; byBot: Record<string, number> } {
    const byBot: Record<string, number> = {};
    let total = 0;
    for (const r of openRows) {
      const basis = r.entryTime ?? r.createdAt;
      const ageH = (now - basis.getTime()) / (60 * 60 * 1000);
      if (ageH >= hours) {
        total++;
        const bt = r.botType || "default";
        byBot[bt] = (byBot[bt] ?? 0) + 1;
      }
    }
    return { total, byBot };
  }

  const eligibleByHoldHours: Record<
    string,
    { total: number; byBot: Record<string, number> }
  > = {};
  for (const h of HOLD_HOURS) {
    eligibleByHoldHours[String(h)] = eligibleByHold(h);
  }

  const oldestSorted = [...openRows].sort((a, b) => {
    const ta = (a.entryTime ?? a.createdAt).getTime();
    const tb = (b.entryTime ?? b.createdAt).getTime();
    return ta - tb;
  });
  const oldest15 = oldestSorted.slice(0, 15);

  const marketIds = [...new Set(oldest15.map((r) => r.marketId))];
  const marketMeta = new Map<string, { marketTitle: string | null; slug: string | null }>();
  if (marketIds.length > 0 && !dbError) {
    for (const mid of marketIds) {
      try {
        const sig = await prisma.marketSignal.findFirst({
          where: { marketId: mid },
          orderBy: { createdAt: "desc" },
          select: { marketTitle: true, slug: true },
        });
        marketMeta.set(mid, { marketTitle: sig?.marketTitle ?? null, slug: sig?.slug ?? null });
      } catch {
        marketMeta.set(mid, { marketTitle: null, slug: null });
      }
    }
  }

  const oldestOpenTradesSample = oldest15.map((r) => {
    const basis = r.entryTime ?? r.createdAt;
    const ageHours = round4((now - basis.getTime()) / (60 * 60 * 1000));
    const meta = marketMeta.get(r.marketId);
    return {
      id: r.id,
      botType: r.botType,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      openedAtProxy: r.entryTime?.toISOString() ?? null,
      ageHours,
      ageBasis: r.entryTime != null ? "entryTime" : "createdAt_fallback",
      marketId: r.marketId,
      marketTitle: meta?.marketTitle ?? null,
      marketSlug: meta?.slug ?? null,
      side: r.side,
      score: r.score,
    };
  });

  const candidateCloseHelpers = [
    {
      file: "lib/paper-trading/engine.ts",
      function: "closePaperTradesAt12h",
      does: "Loads open trades due by 12h entryTime rule; resolves exit via resolvePaperTradeCloseExitPrice; updates status closed, exitTime, exitPrice/markout/metadataJson.paperClose; persists PaperTradingState lastCloseTick*.",
      reusableForTimeBasedAutoClose:
        "Yes — extend or parameterize horizon (today fixed PAPER_CLOSE_HORIZON_MS) and reuse same update + metadata merge pattern.",
    },
    {
      file: "lib/paper-trading/paper-close-helpers.ts",
      function: "mergePaperCloseMetadata, paperCloseDueBefore, isPaperTradeDueForClose",
      does: "Pure helpers for due cutoff and JSON metadata patch under paperClose key.",
      reusableForTimeBasedAutoClose: "Yes — core building blocks for any horizon.",
    },
    {
      file: "lib/polymarket/market-price-snapshot-lookup.ts",
      function: "resolvePaperTradeCloseExitPrice",
      does: "Resolves exit price from MarketPriceSnapshot for paper close.",
      reusableForTimeBasedAutoClose: "Yes — already used by closePaperTradesAt12h.",
    },
    {
      file: "tools/run-paper-relaxed-close-and-report.ts",
      function: "main (script)",
      does: "Invokes closePaperTradesAt12h then regenerates reports — not a library helper.",
      reusableForTimeBasedAutoClose: "No (operational script, mutates DB + runs other tools).",
    },
  ];

  const paperTickEntryPoints = [
    {
      file: "app/api/paper-trading/tick/route.ts",
      exportOrHandler: "POST handler",
      calls: "runPaperTradingTick(funder?)",
    },
    {
      file: "lib/ops/scheduled-jobs.ts",
      exportOrHandler: 'case "paper_trading_tick"',
      calls: "runPaperTradingTick(await getFunderForPaperTradingTick())",
    },
    {
      file: "lib/ops/scheduled-jobs.ts",
      exportOrHandler: 'case "paper_trading_close_due"',
      calls: "closePaperTradesAt12h() — separate scheduled job from open tick; not chained inside runPaperTradingTick today.",
    },
    {
      file: "lib/paper-trading/engine.ts",
      exportOrHandler: "runPaperTradingTick",
      calls: "Main orchestration; first prisma.paperTrade.count for capacity at ~line 601 (legacy) / analogous multi-bot paths after shadow pool load.",
    },
  ];

  const recommendedAutoCloseInsertionPoint = {
    file: "lib/paper-trading/engine.ts",
    function: "runPaperTradingTick",
    lineHint: "Immediately after `const now = new Date();` and before `loadShadowCandidatesForPaperTick` — first open-count/capacity queries occur later in the same function.",
    reason:
      "Runs inside the same scheduled job / API route as admission, uses the same `now`, frees capacity before any `prisma.paperTrade.count` / per-market open checks for new entries. Does not require shadow model scoring. (Calling before the active-model early-return would also close when scoring is blocked — product decision.)",
  };

  const sideEffects = {
    confirmed: [
      {
        effect:
          "closePaperTradesAt12h issues prisma.paperTrade.update per due row (status, exitTime, exitPrice, markout12h, pnlPct, metadataJson.paperClose patch).",
        evidence: "lib/paper-trading/engine.ts closePaperTradesAt12h",
      },
      {
        effect:
          "closePaperTradesAt12h upserts PaperTradingState (lastCloseTickAt, lastCloseTickResultJson, lastCloseTickError).",
        evidence: "lib/paper-trading/engine.ts end of closePaperTradesAt12h",
      },
      {
        effect: "runPaperTradingTick upserts PaperTradingState open-tick fields on completion / error paths.",
        evidence: "lib/paper-trading/engine.ts persistOpenTickState",
      },
    ],
    possibleInferred: [
      {
        effect:
          "Jobs that aggregate closed PaperTrade rows (e.g. paper_config_optimize, self-improvement rollback guard) would see updated cohort on subsequent runs — not invoked inside closePaperTradesAt12h.",
        evidence: "lib/ops/self-improvement-loop.ts prisma.paperTrade.findMany on status closed",
        label: "inference",
      },
      {
        effect:
          "Shadow / label tooling joins PaperTrade to MlShadowTrainingExample; closing changes status but does not by itself write training rows (dataset build is separate pipeline).",
        evidence: "lib/ml/audits/shadow-label-pipeline-debugger.ts comments + queries",
        label: "inference",
      },
    ],
  };

  const needsSchemaChange = false;
  const hasLifecycleFieldsNeededNow = true;
  const minimalV1Plan = [
    "Reuse closePaperTradesAt12h pattern: status closed, entryTime-based horizon, exit snapshot via resolvePaperTradeCloseExitPrice, mergePaperCloseMetadata for reasons.",
    "Parameterize hold duration (env or config) or add parallel auto-close helper; avoid duplicating snapshot logic.",
    "Insert auto-close at start of runPaperTradingTick after `const now = new Date()` so capacity checks see reduced open count.",
    "Encode auto-close reason in metadataJson.paperClose (e.g. closeReason: max_hold_12h) to distinguish from 12h markout job if both exist.",
    "Optional: unify with scheduled paper_trading_close_due to prevent double-close races (idempotent updates or single writer).",
  ];

  const implementationReadiness = {
    hasLifecycleFieldsNeededNow,
    needsSchemaChange,
    minimalV1Plan,
    notes:
      "Dedicated columns for openedAt/closedAt/exitReason are absent; entryTime/exitTime + metadataJson.paperClose carry lifecycle today.",
  };

  const fieldNames = parsed.fields.map((f) => f.name);

  const currentOpenTrades = dbError
    ? {
        count: 0,
        error: dbError,
        timestampBasis: {
          openedAt: 0,
          createdAtFallback: 0,
          note: "Database unreachable — no rows sampled. When healthy, openedAt = count aged by entryTime; createdAtFallback = rows with null entryTime (unexpected).",
        },
        ageHours: emptyAgeHours,
        eligibleByHoldHours: emptyEligibleByHold(),
        oldestOpenTradesSample: [] as Array<(typeof oldestOpenTradesSample)[number]>,
      }
    : {
        count: openRows.length,
        timestampBasis: {
          openedAt: openedAtCount,
          createdAtFallback: createdAtFallbackCount,
          note:
            "openedAt = rows aged using entryTime (proxy for requested openedAt). createdAtFallback = rows where entryTime was null (unexpected given schema).",
        },
        ageHours: ageStats,
        eligibleByHoldHours,
        oldestOpenTradesSample,
      };

  const payload = {
    generatedAt,
    paperTradeModel: {
      schemaPath: "prisma/schema.prisma",
      fields: parsed.fields,
      fieldNames,
      lifecycleFields: parsed.lifecycleFields,
      openTradeDefinitionCandidates,
      indexesForOpenLookup: parsed.indexes.filter(
        (l) => l.includes("status") || l.includes("entryTime") || l.includes("createdAt") || l.includes("botType")
      ),
      allIndexes: parsed.indexes,
      absentColumnsUserAsked: absentLifecycleColumns,
      commentary: {
        openedAt: "Not in schema; entryTime is set to tick `now` at paperTrade.create (semantic open instant).",
        closedAt: "Not in schema; exitTime used when closing.",
        exitedAt_settledAt_resolvedAt: "Not present on PaperTrade model.",
        closeReason_exitReason:
          "Not dedicated columns; closePaperTradesAt12h writes nested object under metadataJson.paperClose (e.g. closeReason, horizonAtIso).",
        isOpen: "No boolean; derived from status === \"open\".",
        priceOutcomeFields:
          "entryPrice, exitPrice?, markout12h?, pnlPct?, pnlDollars? — see fields[] for full schema list.",
      },
    },
    currentOpenTrades,
    codeMap: {
      scanRoots: [...SCAN_ROOTS],
      patternDescriptions: SCAN_PATTERNS.map((p) => ({ id: p.id, description: p.description })),
      hitsByPatternTopFiles: hitSummary,
      paperTickEntryPoints,
      paperTradeReadPaths: hitSummary["prisma.paperTrade"] ?? [],
      paperTradeWritePaths: [
        { file: "lib/paper-trading/engine.ts", note: "create (open) + update (closePaperTradesAt12h)" },
        { file: "tools/run-paper-relaxed-close-and-report.ts", note: "calls closePaperTradesAt12h (mutating tool)" },
      ],
      candidateCloseHelpers,
    },
    sideEffects,
    recommendedAutoCloseInsertionPoint,
    implementationReadiness,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2), "utf8");

  const md: string[] = [];
  md.push(`# Paper exit readiness (auto-close v1)`);
  md.push("");
  md.push(`Generated: **${generatedAt}**`);
  md.push("");
  md.push(`## Executive summary`);
  md.push("");
  md.push(
    `- **Open definition:** \`status === "open"\` everywhere; scheduled close uses additional \`entryTime\` cutoff (12h).`
  );
  md.push(
    `- **Dedicated exit columns:** Use \`exitTime\`, \`exitPrice\`, \`markout12h\`, \`pnlPct\`; reasons live in \`metadataJson.paperClose\`. No \`openedAt\` / \`closedAt\` / \`exitReason\` columns.`
  );
  md.push(
    `- **Reuse:** \`closePaperTradesAt12h\` + \`paper-close-helpers\` + \`resolvePaperTradeCloseExitPrice\` are the right building blocks.`
  );
  md.push(
    `- **Insertion:** Start of \`runPaperTradingTick\` in \`engine.ts\` right after \`const now = new Date()\`, before shadow candidate load / capacity counts.`
  );
  md.push(`- **Schema change for v1:** **${needsSchemaChange ? "Yes" : "No"}** (optional later for first-class reason/horizon fields).`);
  md.push("");
  if (dbError) {
    md.push(`## Database`);
    md.push("");
    md.push(`**Error:** ${dbError}`);
    md.push("");
  }
  md.push(`## Current open-book stats`);
  md.push("");
  md.push(`- **Open count:** ${currentOpenTrades.count}`);
  if (!dbError) {
    md.push(`- **Age basis:** entryTime for ${openedAtCount} rows; createdAt fallback for ${createdAtFallbackCount}.`);
    md.push(
      `- **Age (hours):** min ${ageStats.min ?? "—"} | p25 ${ageStats.p25 ?? "—"} | p50 ${ageStats.p50 ?? "—"} | p75 ${ageStats.p75 ?? "—"} | p90 ${ageStats.p90 ?? "—"} | p95 ${ageStats.p95 ?? "—"} | max ${ageStats.max ?? "—"}`
    );
  } else {
    md.push(`- **Age basis:** not computed (DB error).`);
  }
  md.push("");
  md.push(`## Hold-window simulation (eligible = age ≥ window)`);
  md.push("");
  md.push("| Hold (h) | Total | By bot |");
  md.push("|---:|---:|---|");
  for (const h of HOLD_HOURS) {
    const e = currentOpenTrades.eligibleByHoldHours[String(h)]!;
    md.push(`| ${h} | ${e.total} | ${JSON.stringify(e.byBot)} |`);
  }
  md.push("");
  md.push(`## 15 oldest open trades (compact)`);
  md.push("");
  md.push("```json");
  md.push(JSON.stringify(currentOpenTrades.oldestOpenTradesSample, null, 2));
  md.push("```");
  md.push("");
  md.push(`## Lifecycle field readiness`);
  md.push("");
  md.push(`- Parsed Prisma fields: \`${fieldNames.join(", ")}\``);
  md.push(`- Indexed for status/bot/entry: see JSON \`paperTradeModel.indexesForOpenLookup\`.`);
  md.push("");
  md.push(`## Close / settle helpers`);
  md.push("");
  for (const h of candidateCloseHelpers) {
    md.push(`- **${h.function}** (\`${h.file}\`): ${h.does} — reusable: ${h.reusableForTimeBasedAutoClose}`);
  }
  md.push("");
  md.push(`## Recommended insertion point`);
  md.push("");
  md.push(
    `- **${recommendedAutoCloseInsertionPoint.file}** → **${recommendedAutoCloseInsertionPoint.function}** — ${recommendedAutoCloseInsertionPoint.reason}`
  );
  md.push("");
  md.push(`## Side effects (evidence-based)`);
  md.push("");
  md.push("**Confirmed:**");
  for (const s of sideEffects.confirmed) {
    md.push(`- ${s.effect} (*${s.evidence}*)`);
  }
  md.push("");
  md.push("**Possible / inferred:**");
  for (const s of sideEffects.possibleInferred) {
    md.push(`- ${s.effect} (*${s.evidence}*)`);
  }
  md.push("");
  md.push(`## Minimal v1 recommendation`);
  md.push("");
  for (const step of minimalV1Plan) {
    md.push(`1. ${step}`);
  }
  md.push("");

  fs.writeFileSync(OUT_MD, md.join("\n"), "utf8");

  const elig12 = currentOpenTrades.eligibleByHoldHours["12"]!.total;
  console.log("--- paper-exit-readiness (summary) ---");
  console.log(`openCount: ${currentOpenTrades.count}${dbError ? " (DB error)" : ""}`);
  console.log(`eligibleAt12h: ${dbError ? "n/a (DB error)" : elig12}`);
  console.log(`insertion: ${recommendedAutoCloseInsertionPoint.file} → ${recommendedAutoCloseInsertionPoint.function} (after now, before candidate load)`);
  console.log(`schemaChangeNeeded: ${needsSchemaChange}`);
  console.log(`wrote: ${OUT_JSON}`);
  console.log(`wrote: ${OUT_MD}`);

  await prisma.$disconnect();
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
