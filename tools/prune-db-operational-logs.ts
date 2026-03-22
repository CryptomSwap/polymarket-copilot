/**
 * Opt-in pruning of low-value operational rows (NOT trades, NOT snapshots, NOT ML).
 *
 * Touches only:
 * - ScheduledJobRun (never deletes status=running)
 * - SyncJobStatus (only rows with finishedAt set and older than cutoff)
 * - BotQueueExecutionLog (createdAt older than cutoff)
 *
 * Default: --dry-run (no deletes). Requires explicit --apply.
 *
 * Usage:
 *   npx tsx tools/prune-db-operational-logs.ts --dry-run
 *   npx tsx tools/prune-db-operational-logs.ts --apply --scheduled-job-days 60 --sync-job-days 30 --bot-queue-days 14
 */

import "dotenv/config";
import { prisma } from "../lib/db";

function parseArgs(argv: string[]): {
  apply: boolean;
  scheduledJobDays: number;
  syncJobDays: number;
  botQueueDays: number;
} {
  const apply = argv.includes("--apply");
  const num = (name: string, def: number): number => {
    const i = argv.indexOf(name);
    if (i === -1 || i + 1 >= argv.length) return def;
    const v = Number(argv[i + 1]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    apply,
    scheduledJobDays: num("--scheduled-job-days", 60),
    syncJobDays: num("--sync-job-days", 30),
    botQueueDays: num("--bot-queue-days", 14),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.apply && !process.argv.includes("--dry-run")) {
    console.log("[prune-db-operational-logs] No --apply: defaulting to dry-run.");
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[prune-db-operational-logs] Database unavailable:", msg.replace(/\s+/g, " ").trim());
    await prisma.$disconnect();
    process.exit(1);
  }

  const now = Date.now();
  const schedCut = new Date(now - args.scheduledJobDays * 86_400_000);
  const syncCut = new Date(now - args.syncJobDays * 86_400_000);
  const botCut = new Date(now - args.botQueueDays * 86_400_000);

  const dryRun = !args.apply;

  const schedWhere = {
    NOT: { status: "running" as const },
    startedAt: { lt: schedCut },
  };

  const [schedCount, syncCount, botCount] = await Promise.all([
    prisma.scheduledJobRun.count({ where: schedWhere }),
    prisma.syncJobStatus.count({
      where: { finishedAt: { not: null, lt: syncCut } },
    }),
    prisma.botQueueExecutionLog.count({ where: { createdAt: { lt: botCut } } }),
  ]);

  console.log(
    JSON.stringify(
      {
        dryRun,
        cutoffs: {
          scheduledJobRun_startedBefore: schedCut.toISOString(),
          syncJobStatus_finishedBefore: syncCut.toISOString(),
          botQueueExecutionLog_createdBefore: botCut.toISOString(),
        },
        wouldDelete: { scheduledJobRun: schedCount, syncJobStatus: syncCount, botQueueExecutionLog: botCount },
      },
      null,
      2
    )
  );

  if (dryRun) {
    console.log("[prune-db-operational-logs] Dry run complete. Pass --apply to execute deletes.");
    await prisma.$disconnect();
    return;
  }

  const [dSched, dSync, dBot] = await prisma.$transaction([
    prisma.scheduledJobRun.deleteMany({ where: schedWhere }),
    prisma.syncJobStatus.deleteMany({
      where: { finishedAt: { not: null, lt: syncCut } },
    }),
    prisma.botQueueExecutionLog.deleteMany({ where: { createdAt: { lt: botCut } } }),
  ]);

  console.log(
    "[prune-db-operational-logs] Deleted:",
    `ScheduledJobRun=${dSched.count}`,
    `SyncJobStatus=${dSync.count}`,
    `BotQueueExecutionLog=${dBot.count}`
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
