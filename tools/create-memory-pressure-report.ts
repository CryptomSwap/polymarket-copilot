import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";

const DUMP_DIR = path.join(process.cwd(), "dump");
const JSON_PATH = path.join(DUMP_DIR, "memory-pressure-report.json");
const MD_PATH = path.join(DUMP_DIR, "memory-pressure-report.md");

type Hotspot = {
  path: string;
  category:
    | "oversized_result_sets"
    | "retained_references"
    | "cache_growth"
    | "duplicate_prisma_clients"
    | "long_lived_job_artifacts"
    | "logging_or_report_overhead";
  risk: "high" | "medium" | "low";
  reason: string;
  suggestedFix: string;
};

async function fileContains(p: string, checks: string[]): Promise<boolean> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return checks.every((c) => raw.includes(c));
  } catch {
    return false;
  }
}

function formatMb(v: number): number {
  return Number((v / (1024 * 1024)).toFixed(2));
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const role = process.argv.includes("--worker")
    ? "worker"
    : process.argv.includes("--app")
      ? "app"
      : "unknown";
  const mem = process.memoryUsage();
  const prismaSingleton = await fileContains(path.join(process.cwd(), "lib", "db.ts"), [
    "globalThis",
    "globalForPrisma",
    "new PrismaClient",
  ]);

  // Lightweight DB snapshots useful for sizing query pressure.
  let scheduledRuns24h: number | null = null;
  let shadowRows: number | null = null;
  let paperTrades7d: number | null = null;
  let dbSnapshotError: string | null = null;
  try {
    [scheduledRuns24h, shadowRows, paperTrades7d] = await Promise.all([
      prisma.scheduledJobRun.count({
        where: { startedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
      prisma.mlShadowTrainingExample.count(),
      prisma.paperTrade.count({
        where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      }),
    ]);
  } catch (e) {
    dbSnapshotError = e instanceof Error ? e.message : String(e);
  }

  const cacheInventory = [
    {
      name: "InMemoryOrderLifecycleStore.byClientId/byExternalId",
      file: "lib/runtime/order-manager/order-lifecycle-store.ts",
      approximateSize: "in-process dynamic (orders seen since boot)",
      bounded: true,
      bounds: {
        terminalTtlMs: process.env.RUNTIME_ORDER_TERMINAL_TTL_MS ?? "21600000",
        terminalMax: process.env.RUNTIME_ORDER_TERMINAL_MAX ?? "4000",
      },
    },
    {
      name: "InMemoryMarketStateStore.byAssetId",
      file: "lib/runtime/market-state/market-state-store.ts",
      approximateSize: "in-process dynamic (tracked + recently seen assets)",
      bounded: true,
      bounds: {
        maxAssets: process.env.RUNTIME_MARKET_STATE_MAX_ASSETS ?? "5000",
        inactiveEvictMs: process.env.RUNTIME_MARKET_STATE_INACTIVE_EVICT_MS ?? "21600000",
      },
    },
    {
      name: "InMemoryRuntimePositionStore.byKey",
      file: "lib/runtime/positions/runtime-position-store.ts",
      approximateSize: "in-process dynamic (active + recent zero positions)",
      bounded: true,
      bounds: {
        maxPositions: process.env.RUNTIME_POSITION_STORE_MAX_POSITIONS ?? "5000",
        zeroTtlMs: process.env.RUNTIME_POSITION_ZERO_TTL_MS ?? "21600000",
      },
    },
  ];

  const hotspots: Hotspot[] = [
    {
      path: "lib/ml/dataset.ts",
      category: "oversized_result_sets",
      risk: "high",
      reason: "N+1 pattern in recommendation loop and potentially wide materialization for training arrays.",
      suggestedFix: "Batch asset/position lookups and cap training windows/chunk processing.",
    },
    {
      path: "lib/ml/score-live.ts",
      category: "oversized_result_sets",
      risk: "high",
      reason: "Per-recommendation asset/position lookups in scoring path can create DB + heap pressure.",
      suggestedFix: "Prefetch by market/outcome and assetId maps before scoring loop.",
    },
    {
      path: "lib/ml/shadow-dataset/build.ts",
      category: "oversized_result_sets",
      risk: "high",
      reason: "Dataset build can hold large row batches and perform many per-row snapshot fetches.",
      suggestedFix: "Chunk candidate reads/dedupe checks/persistence and cap page size.",
    },
    {
      path: "app/api/paper-trading/summary/route.ts",
      category: "logging_or_report_overhead",
      risk: "medium",
      reason: "Route aggregates multiple large populations in memory for summary calculations.",
      suggestedFix: "Use DB-side groupBy/count/avg for aggregates and paginate raw samples.",
    },
    {
      path: "tools/create-*.ts report generators",
      category: "long_lived_job_artifacts",
      risk: "medium",
      reason: "Frequent large dump generation can increase storage churn and transient heap usage.",
      suggestedFix: "Bound sample sizes and keep latest+retained-history policy.",
    },
    {
      path: "lib/db.ts",
      category: "duplicate_prisma_clients",
      risk: prismaSingleton ? "low" : "high",
      reason: prismaSingleton
        ? "Global singleton pattern appears present."
        : "Could not confirm singleton pattern from file scan.",
      suggestedFix: "Ensure all modules import shared prisma singleton from lib/db.ts.",
    },
  ];

  const recommendations = [
    {
      rank: 1,
      impact: "high",
      safety: "high",
      item: "Keep runtime stores bounded with TTL/max-size pruning (orders/market-state/positions).",
    },
    {
      rank: 2,
      impact: "high",
      safety: "high",
      item: "Use batched reads/writes for shadow dataset build; avoid one-shot candidate/result sets.",
    },
    {
      rank: 3,
      impact: "medium",
      safety: "high",
      item: "Push report/API aggregates into SQL groupBy/count/avg where possible.",
    },
    {
      rank: 4,
      impact: "medium",
      safety: "high",
      item: "Cap scheduled-report sample sizes and use bounded dump retention.",
    },
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    context: { role, pid: process.pid, node: process.version },
    processMemoryUsage: {
      rssMb: formatMb(mem.rss),
      heapTotalMb: formatMb(mem.heapTotal),
      heapUsedMb: formatMb(mem.heapUsed),
      externalMb: formatMb(mem.external),
      arrayBuffersMb: formatMb(mem.arrayBuffers),
    },
    prisma: {
      singletonDetectedByCodeScan: prismaSingleton,
      notes: prismaSingleton
        ? "Prisma singleton pattern detected in lib/db.ts."
        : "Could not verify singleton pattern; inspect lib/db.ts.",
      pressureSignals: {
        scheduledJobRuns24h: scheduledRuns24h,
        mlShadowTrainingExampleRows: shadowRows,
        paperTradesCreated7d: paperTrades7d,
        dbSnapshotError,
      },
    },
    cacheInventory,
    hotspots,
    recommendations,
  };

  await fs.writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");

  const md = [
    "# Memory Pressure Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Role: ${role}`,
    "",
    "## Process memory snapshot",
    "",
    `- rss: ${report.processMemoryUsage.rssMb} MB`,
    `- heapTotal: ${report.processMemoryUsage.heapTotalMb} MB`,
    `- heapUsed: ${report.processMemoryUsage.heapUsedMb} MB`,
    `- external: ${report.processMemoryUsage.externalMb} MB`,
    `- arrayBuffers: ${report.processMemoryUsage.arrayBuffersMb} MB`,
    "",
    "## Prisma notes",
    "",
    `- Singleton detected: ${report.prisma.singletonDetectedByCodeScan ? "yes" : "no"}`,
    `- ScheduledJobRun rows (24h): ${scheduledRuns24h ?? "n/a"}`,
    `- MlShadowTrainingExample rows: ${shadowRows ?? "n/a"}`,
    `- PaperTrade rows (7d): ${paperTrades7d ?? "n/a"}`,
    ...(dbSnapshotError ? [`- DB snapshot error: ${dbSnapshotError}`] : []),
    "",
    "## Cache inventory",
    "",
    ...cacheInventory.map(
      (c) => `- ${c.name} (${c.file}) bounded=${c.bounded ? "yes" : "no"} bounds=${JSON.stringify(c.bounds)}`
    ),
    "",
    "## Top hotspots",
    "",
    ...hotspots.map(
      (h) => `- [${h.risk}] ${h.path} :: ${h.category} :: ${h.reason} -> ${h.suggestedFix}`
    ),
    "",
    "## Recommendations (ranked)",
    "",
    ...recommendations.map(
      (r) => `${r.rank}. (${r.impact} impact, ${r.safety} safety) ${r.item}`
    ),
    "",
  ].join("\n");
  await fs.writeFile(MD_PATH, md, "utf8");

  console.log(`Wrote ${JSON_PATH}`);
  console.log(`Wrote ${MD_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

