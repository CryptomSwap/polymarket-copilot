/**
 * Database storage + retention classification report (report-only; no deletes).
 *
 * Creates:
 * - dump/db-storage-retention-report.json
 * - dump/db-storage-retention-report.md
 *
 * Uses PostgreSQL catalog stats (pg_stat_user_tables + sizes). Row counts are
 * estimate-based (n_live_tup) unless you run ANALYZE — good enough for planning.
 *
 * Usage:
 *   npx tsx tools/create-db-storage-retention-report.ts
 */

import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_OUT = path.join(DUMP_DIR, "db-storage-retention-report.json");
const MD_OUT = path.join(DUMP_DIR, "db-storage-retention-report.md");

/** Typical size ranking when high-volume features are enabled (for policy doc if live stats unavailable). */
const EXPECTED_LARGEST_TABLES_ORDER: string[] = [
  "MarketPriceSnapshot",
  "ShadowCandidate",
  "MlShadowTrainingExample",
  "NewsItem",
  "OrderLifecycleJournalEntry",
  "MarketSignal",
  "Recommendation",
  "LiveEvent",
  "EventSignal",
  "MarketEventLink",
  "OrderIntentEvent",
  "ExecutedOrderEvent",
  "RecommendationEvaluation",
  "DecisionPolicySnapshot",
  "MlTrainingExample",
  "PaperTrade",
  "PortfolioSnapshot",
  "CopilotAlert",
  "FillLedgerEntry",
  "ExecutedOrder",
  "OrderIntent",
  "SyncedMarket",
  "BotQueueExecutionLog",
  "ScheduledJobRun",
  "SyncJobStatus",
];

export type RetentionClass = "must_keep_long_term" | "compact_archive" | "prune_candidate";

export type TableRetentionMeta = {
  classification: RetentionClass;
  retentionValue: "critical" | "high" | "medium" | "low";
  /** Why this table matters for paper / ML / live readiness / audit */
  rationale: string;
  /** Human-readable default policy suggestion */
  recommendedPolicy: string;
  /** e.g. "90d completed rows" or "24–48h dense, then weekly aggregates" */
  suggestedRetentionWindow: string | null;
  safeFirstPruneHint: string | null;
};

/** Key = PostgreSQL relname (Prisma default table names) */
export const TABLE_RETENTION_META: Record<string, TableRetentionMeta> = {
  MarketPriceSnapshot: {
    classification: "compact_archive",
    retentionValue: "high",
    rationale:
      "Dominant disk risk; feeds markouts, path features, and shadow/paper price lookups. ML path code loads ~24h before decision through forward horizons.",
    recommendedPolicy:
      "Time-based retention or downsampling: keep dense snapshots around decision windows; drop or aggregate very old ticks for inactive marketIds.",
    suggestedRetentionWindow:
      "Hot: 14–30d full resolution for active markets; cold: downsample >30d to e.g. hourly; optional drop snapshots for resolved/archived markets after labels frozen.",
    safeFirstPruneHint:
      "Do not bulk-delete until you confirm no active backfills; prefer DELETE ... WHERE capturedAt < $cutoff AND marketId NOT IN (recent paper/shadow markets). Start with dry-run counts.",
  },
  ShadowCandidate: {
    classification: "compact_archive",
    retentionValue: "high",
    rationale:
      "Shadow telemetry + large JSON snapshots; core for blocked-vs-allowed analysis and shadow ML labels.",
    recommendedPolicy:
      "Keep evaluated rows long-term; for unevaluated backlog consider evaluation job first. Archive JSON columns to cold storage or strip redundant snapshots for rows > N months.",
    suggestedRetentionWindow:
      "Evaluated: 12–24m+ for research; unevaluated: complete evaluation then prune stale unevaluated >90d if business-safe.",
    safeFirstPruneHint:
      "Prune last: require explicit policy. Optional: null out large snapshot JSON for rows with outcomeClassification set and age > window (report-only until approved).",
  },
  MlShadowTrainingExample: {
    classification: "must_keep_long_term",
    retentionValue: "critical",
    rationale: "Materialized training features/labels for shadow/bot-improvement ML; overlaps with ShadowCandidate.",
    recommendedPolicy: "Treat like training corpus; archive old runs to file/warehouse before DB delete.",
    suggestedRetentionWindow: "Keep while models in use; archive >12m to object storage if DB pressure.",
    safeFirstPruneHint: "Do not prune until exported; lowest priority for deletion.",
  },
  MlTrainingExample: {
    classification: "must_keep_long_term",
    retentionValue: "critical",
    rationale: "Recommendation-centric labeled examples for ML calibration and score alignment.",
    recommendedPolicy: "Retain with model lineage; export before delete.",
    suggestedRetentionWindow: "12–24m typical research window unless exported.",
    safeFirstPruneHint: "Never first target without export.",
  },
  PaperTrade: {
    classification: "must_keep_long_term",
    retentionValue: "critical",
    rationale: "Paper PnL, calibration, ROI, bot profiles — core product evidence.",
    recommendedPolicy: "Keep closed trades indefinitely in DB or export yearly snapshots.",
    suggestedRetentionWindow: "Long-term; optional archive closed >24m.",
    safeFirstPruneHint: "Not a first cleanup target.",
  },
  Recommendation: {
    classification: "must_keep_long_term",
    retentionValue: "high",
    rationale: "Decision lineage linking signals, policy, execution, and ML scores.",
    recommendedPolicy: "Retain 12m+ minimum for forensics; consider summarization not deletion.",
    suggestedRetentionWindow: "12–24m+ for active development.",
    safeFirstPruneHint: "Prune only with cascading policy explicitly designed (not implemented here).",
  },
  MarketSignal: {
    classification: "must_keep_long_term",
    retentionValue: "high",
    rationale: "Upstream of recommendations; needed for replay and score alignment.",
    recommendedPolicy: "Align retention with Recommendation.",
    suggestedRetentionWindow: "Match Recommendation policy.",
    safeFirstPruneHint: null,
  },
  OrderLifecycleJournalEntry: {
    classification: "must_keep_long_term",
    retentionValue: "critical",
    rationale: "Append-only audit/replay for order state — live readiness and incident forensics.",
    recommendedPolicy: "No routine delete; legal/compliance style retention.",
    suggestedRetentionWindow: "Years, or export-to-immutable store.",
    safeFirstPruneHint: "Never auto-prune in local scripts without legal/ops signoff.",
  },
  FillLedgerEntry: {
    classification: "must_keep_long_term",
    retentionValue: "critical",
    rationale: "Source of truth for fills and position replay.",
    recommendedPolicy: "Never prune in product DB; archive externally if needed.",
    suggestedRetentionWindow: "Indefinite.",
    safeFirstPruneHint: null,
  },
  ExecutedOrder: {
    classification: "must_keep_long_term",
    retentionValue: "critical",
    rationale: "Venue orders + linkage to intents and fills.",
    recommendedPolicy: "Retain; compress rawJson only if proven redundant.",
    suggestedRetentionWindow: "Indefinite for production accounts.",
    safeFirstPruneHint: null,
  },
  ExecutedOrderEvent: {
    classification: "must_keep_long_term",
    retentionValue: "high",
    rationale: "Per-order audit trail.",
    recommendedPolicy: "Align with ExecutedOrder; optional archival of old payloadJson.",
    suggestedRetentionWindow: "Match ExecutedOrder.",
    safeFirstPruneHint: null,
  },
  OrderIntent: {
    classification: "must_keep_long_term",
    retentionValue: "critical",
    rationale: "Durable intent + idempotency and decision linkage.",
    recommendedPolicy: "No bulk delete.",
    suggestedRetentionWindow: "Indefinite.",
    safeFirstPruneHint: null,
  },
  OrderIntentEvent: {
    classification: "must_keep_long_term",
    retentionValue: "high",
    rationale: "Intent lifecycle audit.",
    recommendedPolicy: "Archive old payloads if needed; keep row skeletons.",
    suggestedRetentionWindow: "12–24m+ typical.",
    safeFirstPruneHint: "Optional: truncate payloadJson for rows >18m after export.",
  },
  MlModelRun: {
    classification: "must_keep_long_term",
    retentionValue: "high",
    rationale: "Model lineage, metrics, linkage to scores and paper trades.",
    recommendedPolicy: "Keep rows; large metricsJson could move to object storage.",
    suggestedRetentionWindow: "Life of project.",
    safeFirstPruneHint: null,
  },
  RecommendationMlScore: {
    classification: "must_keep_long_term",
    retentionValue: "high",
    rationale: "Binds recommendations to model runs for calibration analysis.",
    recommendedPolicy: "Retain with MlModelRun.",
    suggestedRetentionWindow: "Match model retention.",
    safeFirstPruneHint: null,
  },
  NewsItem: {
    classification: "compact_archive",
    retentionValue: "medium",
    rationale: "News corpus; body can be large.",
    recommendedPolicy: "Truncate body/summary for old items; keep metadata and links.",
    suggestedRetentionWindow: "Full text 90–180d; metadata longer.",
    safeFirstPruneHint: "Optional: clear body for items older than N days (report + approval).",
  },
  EventSignal: {
    classification: "compact_archive",
    retentionValue: "medium",
    rationale: "Structured extractions from news.",
    recommendedPolicy: "Align with NewsItem retention.",
    suggestedRetentionWindow: "180d–12m depending on news policy.",
    safeFirstPruneHint: null,
  },
  MarketEventLink: {
    classification: "compact_archive",
    retentionValue: "high",
    rationale: "Calibration targets for event impact — useful for ML quality.",
    recommendedPolicy: "Keep longer than raw news if space allows.",
    suggestedRetentionWindow: "12–24m.",
    safeFirstPruneHint: null,
  },
  LiveEvent: {
    classification: "prune_candidate",
    retentionValue: "medium",
    rationale: "Operational stream of UI/runtime events; valuable short-term for debugging.",
    recommendedPolicy: "Time-based prune after N days.",
    suggestedRetentionWindow: "30–90d.",
    safeFirstPruneHint: "Good early target after reporting counts (use dedicated prune script with cutoff).",
  },
  CopilotAlert: {
    classification: "prune_candidate",
    retentionValue: "low",
    rationale: "Operator notifications; lower long-term value than trades.",
    recommendedPolicy: "Delete read + old unread beyond window.",
    suggestedRetentionWindow: "60–180d.",
    safeFirstPruneHint: "Can prune old isRead=true first.",
  },
  DriftAlert: {
    classification: "prune_candidate",
    retentionValue: "medium",
    rationale: "Reconciliation drift; keep medium term for forensics.",
    recommendedPolicy: "Prune resolved older than N days.",
    suggestedRetentionWindow: "90–180d resolved.",
    safeFirstPruneHint: "After LiveEvent cleanup priority.",
  },
  PortfolioSnapshot: {
    classification: "compact_archive",
    retentionValue: "medium",
    rationale: "Time series of portfolio metrics.",
    recommendedPolicy: "Downsample to daily after 30d.",
    suggestedRetentionWindow: "Raw 30–90d; aggregates longer.",
    safeFirstPruneHint: "Aggregate then delete dense old rows.",
  },
  RecommendationEvaluation: {
    classification: "compact_archive",
    retentionValue: "medium",
    rationale: "Forward return checks on recommendations.",
    recommendedPolicy: "Keep aligned with Recommendation or 12m.",
    suggestedRetentionWindow: "12m typical.",
    safeFirstPruneHint: null,
  },
  DecisionPolicySnapshot: {
    classification: "compact_archive",
    retentionValue: "high",
    rationale: "Policy state at decision time.",
    recommendedPolicy: "Keep with Recommendation lifecycle.",
    suggestedRetentionWindow: "12–24m.",
    safeFirstPruneHint: null,
  },
  RecommendationLifecycleEvent: {
    classification: "must_keep_long_term",
    retentionValue: "high",
    rationale: "State machine audit for recommendations.",
    recommendedPolicy: "Retain with Recommendation.",
    suggestedRetentionWindow: "12–24m+.",
    safeFirstPruneHint: null,
  },
  RecommendationExecutionOutcome: {
    classification: "must_keep_long_term",
    retentionValue: "high",
    rationale: "Acted vs ignored and forward returns — score alignment / ROI.",
    recommendedPolicy: "Retain long-term.",
    suggestedRetentionWindow: "24m+.",
    safeFirstPruneHint: null,
  },
  SyncJobStatus: {
    classification: "prune_candidate",
    retentionValue: "low",
    rationale: "Sync job diagnostics.",
    recommendedPolicy: "Delete finished/error rows older than N days.",
    suggestedRetentionWindow: "14–60d.",
    safeFirstPruneHint: "Safest early bulk delete family (see tools/prune-db-operational-logs.ts).",
  },
  ScheduledJobRun: {
    classification: "prune_candidate",
    retentionValue: "low",
    rationale: "Scheduler history; zombies handled by cleanup-stale-job-runs.",
    recommendedPolicy: "Delete terminal runs older than N days (never delete running without stale logic).",
    suggestedRetentionWindow: "30–90d completed/failed.",
    safeFirstPruneHint: "Safest early bulk delete family (opt-in script).",
  },
  BotQueueExecutionLog: {
    classification: "prune_candidate",
    retentionValue: "low",
    rationale: "Verbose bot queue traces.",
    recommendedPolicy: "Short TTL.",
    suggestedRetentionWindow: "7–30d.",
    safeFirstPruneHint: "Good second target after job tables.",
  },
  TradePreflightCheck: {
    classification: "prune_candidate",
    retentionValue: "low",
    rationale: "Pre-trade diagnostics.",
    recommendedPolicy: "Short TTL.",
    suggestedRetentionWindow: "14–60d.",
    safeFirstPruneHint: null,
  },
  OrderReconciliationSnapshot: {
    classification: "prune_candidate",
    retentionValue: "low",
    rationale: "Point-in-time reconcile snapshots.",
    recommendedPolicy: "Prune when mismatch=false and age > N days.",
    suggestedRetentionWindow: "30–90d.",
    safeFirstPruneHint: "Only after confirming no open incidents.",
  },
  BehaviorFlag: {
    classification: "compact_archive",
    retentionValue: "medium",
    rationale: "Automation / portfolio behavior audit trail.",
    recommendedPolicy: "Prune very old low-severity after export.",
    suggestedRetentionWindow: "180d–24m depending on compliance appetite.",
    safeFirstPruneHint: null,
  },
  SyncedMarket: {
    classification: "must_keep_long_term",
    retentionValue: "high",
    rationale: "Market catalog; raw Gamma JSON can be large.",
    recommendedPolicy: "Null or shorten raw for closed markets; keep core columns.",
    suggestedRetentionWindow: "Catalog indefinite; raw field 90–180d after close.",
    safeFirstPruneHint: "Compaction: UPDATE raw = NULL WHERE status resolved and old (manual SQL after report).",
  },
  UserFill: {
    classification: "must_keep_long_term",
    retentionValue: "critical",
    rationale: "Exchange truth for fills.",
    recommendedPolicy: "No prune.",
    suggestedRetentionWindow: "Indefinite.",
    safeFirstPruneHint: null,
  },
  UserOrder: {
    classification: "must_keep_long_term",
    retentionValue: "critical",
    rationale: "Exchange truth for orders.",
    recommendedPolicy: "No prune.",
    suggestedRetentionWindow: "Indefinite.",
    safeFirstPruneHint: null,
  },
  UserPosition: {
    classification: "must_keep_long_term",
    retentionValue: "high",
    rationale: "Current position cache from venue.",
    recommendedPolicy: "No historical pruning — small cardinality.",
    suggestedRetentionWindow: "N/A",
    safeFirstPruneHint: null,
  },
  Placeholder: {
    classification: "prune_candidate",
    retentionValue: "low",
    rationale: "Test / stray table.",
    recommendedPolicy: "Truncate if unused.",
    suggestedRetentionWindow: "N/A",
    safeFirstPruneHint: "TRUNCATE if confirmed unused.",
  },
  stream_sync_state: {
    classification: "must_keep_long_term",
    retentionValue: "high",
    rationale: "Stream cursor state.",
    recommendedPolicy: "Single row; do not delete.",
    suggestedRetentionWindow: "N/A",
    safeFirstPruneHint: null,
  },
};

function defaultMeta(relname: string): TableRetentionMeta {
  return {
    classification: "compact_archive",
    retentionValue: "medium",
    rationale: "Unclassified in TABLE_RETENTION_META; review before any prune.",
    recommendedPolicy: "Manual review; add metadata to create-db-storage-retention-report.ts when intent is clear.",
    suggestedRetentionWindow: null,
    safeFirstPruneHint: null,
  };
}

type PgStatRow = {
  schemaname: string;
  relname: string;
  total_bytes: bigint;
  heap_bytes: bigint;
  n_live_tup: bigint;
  n_dead_tup: bigint;
  last_vacuum: Date | null;
  last_autovacuum: Date | null;
};

function fmtBytes(n: bigint): string {
  const x = Number(n);
  if (x < 1024) return `${x} B`;
  const kb = x / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KiB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MiB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GiB`;
}

function bigintify<T extends Record<string, unknown>>(row: T): T {
  const o = { ...row } as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === "bigint") o[k] = v.toString();
  }
  return o as T;
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  let rows: PgStatRow[] = [];
  let dbError: string | null = null;

  try {
    rows = await prisma.$queryRaw<PgStatRow[]>`
      SELECT
        s.schemaname,
        s.relname,
        pg_total_relation_size(format('%I.%I', s.schemaname, s.relname)::regclass)::bigint AS total_bytes,
        pg_relation_size(format('%I.%I', s.schemaname, s.relname)::regclass)::bigint AS heap_bytes,
        s.n_live_tup::bigint AS n_live_tup,
        s.n_dead_tup::bigint AS n_dead_tup,
        s.last_vacuum,
        s.last_autovacuum
      FROM pg_stat_user_tables s
      WHERE s.schemaname = 'public'
      ORDER BY pg_total_relation_size(format('%I.%I', s.schemaname, s.relname)::regclass) DESC NULLS LAST
    `;
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  const tables = rows.map((r) => {
    const meta = TABLE_RETENTION_META[r.relname] ?? defaultMeta(r.relname);
    return bigintify({
      relname: r.relname,
      schemaname: r.schemaname,
      totalBytes: r.total_bytes,
      heapBytes: r.heap_bytes,
      estimatedLiveRows: r.n_live_tup,
      estimatedDeadRows: r.n_dead_tup,
      totalBytesHuman: fmtBytes(r.total_bytes),
      lastVacuum: r.last_vacuum,
      lastAutovacuum: r.last_autovacuum,
      ...meta,
    });
  });

  const totalDbBytes = rows.reduce((a, r) => a + r.total_bytes, 0n);
  const generatedAt = new Date().toISOString();

  const expectedRanking = EXPECTED_LARGEST_TABLES_ORDER.map((relname, i) => {
    const meta = TABLE_RETENTION_META[relname] ?? defaultMeta(relname);
    return { rank: i + 1, relname, ...meta };
  });

  const jsonPayload = {
    generatedAt,
    dbError,
    totalApproxBytes: totalDbBytes.toString(),
    totalApproxHuman: fmtBytes(totalDbBytes),
    tables,
    expectedLargestTablesWhenDbUnavailable: dbError ? expectedRanking : null,
    smallestSafeFirstCleanupStep:
      "Opt-in: run `npx tsx tools/prune-db-operational-logs.ts --dry-run` then `--apply` with conservative day thresholds — only touches ScheduledJobRun (non-running), SyncJobStatus, BotQueueExecutionLog. Does not touch MarketPriceSnapshot, trades, ML, or shadow training data.",
    policySummary: {
      rawMarketSnapshots: TABLE_RETENTION_META.MarketPriceSnapshot?.suggestedRetentionWindow,
      shadowCandidates: TABLE_RETENTION_META.ShadowCandidate?.suggestedRetentionWindow,
      diagnosticsJobRuns: TABLE_RETENTION_META.ScheduledJobRun?.suggestedRetentionWindow,
      paperTrades: TABLE_RETENTION_META.PaperTrade?.suggestedRetentionWindow,
      mlTrainingExamples: TABLE_RETENTION_META.MlTrainingExample?.suggestedRetentionWindow,
      mlModelRuns: TABLE_RETENTION_META.MlModelRun?.suggestedRetentionWindow,
    },
  };

  await fs.writeFile(JSON_OUT, JSON.stringify(jsonPayload, null, 2), "utf8");

  const top = tables.slice(0, 25);
  const biggestLine =
    top.length > 0
      ? `Largest table: **${top[0].relname}** (~${top[0].totalBytesHuman}, ~${top[0].estimatedLiveRows} live rows est.).`
      : "No live table stats (database unreachable from this run). See **Expected dominant tables** below for typical ranking.";

  const dbErrMd = dbError
    ? `**DB error:** ${dbError.replace(/`/g, "'").replace(/\s+/g, " ").trim()} — measured stats empty; policy sections still apply.`
    : "_Connected to database successfully._";

  const expectedMd =
    top.length === 0
      ? `## Expected dominant tables (architecture-based — run report with DB up for exact sizes)

In long-running stacks, **\`MarketPriceSnapshot\`** and **\`ShadowCandidate\`** usually dominate (high insert rate + wide JSON on shadow rows). Next tier often includes **\`MlShadowTrainingExample\`**, **\`NewsItem\`**, append-only journals (**\`OrderLifecycleJournalEntry\`**), and recommendation/signal history.

| Typical rank | Table | Class | Retention value |
|--------------|-------|-------|-----------------|
${EXPECTED_LARGEST_TABLES_ORDER.map((name, i) => {
  const m = TABLE_RETENTION_META[name] ?? defaultMeta(name);
  return `| ${i + 1} | ${name} | ${m.classification} | ${m.retentionValue} |`;
}).join("\n")}
`
      : "";

  const md = `# Database storage & retention report

Generated: **${generatedAt}**  
${dbErrMd}

## Executive summary

- ${biggestLine}
- **Total measured** (sum of user tables in \`public\`): **${fmtBytes(totalDbBytes)}** (indexes + TOAST included in per-table total).
- **Row counts** are from \`pg_stat_user_tables.n_live_tup\` (estimate). Run \`ANALYZE\` for fresher stats.
- **Smallest safe first cleanup step:** ${jsonPayload.smallestSafeFirstCleanupStep}

${expectedMd}
## Biggest tables (top 25)

| Rank | Table | Total size | Heap | Est. live rows | Class | Value |
|------|-------|------------|------|----------------|-------|-------|
${top
  .map(
    (t, i) =>
      `| ${i + 1} | ${t.relname} | ${t.totalBytesHuman} | ${fmtBytes(BigInt(t.heapBytes as string))} | ${t.estimatedLiveRows} | ${t.classification} | ${t.retentionValue} |`
  )
  .join("\n")}

## Classification legend

- **must_keep_long_term** — audit, trades, paper performance, ML lineage, fills/orders.
- **compact_archive** — valuable but can be downsized, summarized, or partially nullified (e.g. \`SyncedMarket.raw\`, old \`NewsItem.body\`).
- **prune_candidate** — operational noise; time-based delete is usually safe after review.

## Suggested retention windows (summary)

| Area | Suggested window |
|------|------------------|
| Raw market snapshots (\`MarketPriceSnapshot\`) | ${jsonPayload.policySummary.rawMarketSnapshots ?? "—"} |
| Shadow candidates | ${jsonPayload.policySummary.shadowCandidates ?? "—"} |
| Diagnostics / job runs | ${jsonPayload.policySummary.diagnosticsJobRuns ?? "—"} |
| Paper trades | ${jsonPayload.policySummary.paperTrades ?? "—"} |
| ML training examples | ${jsonPayload.policySummary.mlTrainingExamples ?? "—"} |
| ML model runs | ${jsonPayload.policySummary.mlModelRuns ?? "—"} |

## What to preserve (non-negotiable for paper optimization & live readiness)

- **Paper + calibration:** \`PaperTrade\`, \`MlModelRun\`, \`RecommendationMlScore\`, \`Recommendation\` / \`MarketSignal\` (and linked evaluation/outcome rows).
- **Shadow / bot ML:** \`ShadowCandidate\`, \`MlShadowTrainingExample\` (export before any aggressive delete).
- **Audit / replay:** \`FillLedgerEntry\`, \`OrderIntent\` (+ \`OrderIntentEvent\`), \`ExecutedOrder\` (+ \`ExecutedOrderEvent\`), \`OrderLifecycleJournalEntry\`.
- **Price history for labels:** \`MarketPriceSnapshot\` for horizons used by shadow/paper — do not blind-delete without a **report-first** cutoff query.

## Safe to prune first (after dry-run counts)

1. **Operational logs** — \`ScheduledJobRun\` (completed/failed, past retention), \`SyncJobStatus\`, \`BotQueueExecutionLog\` — use \`tools/prune-db-operational-logs.ts\` (\`--dry-run\` default).
2. **Alerts / events** — old \`LiveEvent\`, resolved \`DriftAlert\`, old read \`CopilotAlert\` — add explicit SQL or a future opt-in tool after counts.
3. **Large JSON / news** — compaction (\`NewsItem.body\`, \`ShadowCandidate\` snapshots) — **summarization / null columns**, not DELETE, until policy signed off.

## Operational commands

\`\`\`bash
npx tsx tools/create-db-storage-retention-report.ts
npx tsx tools/prune-db-operational-logs.ts --dry-run
\`\`\`

Machine-readable: \`${path.relative(process.cwd(), JSON_OUT)}\`
`;

  await fs.writeFile(MD_OUT, md, "utf8");
  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
  if (dbError) {
    console.error(`Warning: ${dbError}`);
    process.exitCode = 1;
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
