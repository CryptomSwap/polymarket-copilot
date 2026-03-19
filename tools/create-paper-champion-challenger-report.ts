/**
 * Paper champion/challenger report.
 * Outputs: dump/paper-champion-challenger-report.json, dump/paper-champion-challenger-report.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score";
import { enableMlChampionChallenger } from "../lib/ml/config";

const DUMP_DIR = path.join(process.cwd(), "dump");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const timestamp = new Date().toISOString();

  const featureFlag = enableMlChampionChallenger();
  const active = await getActiveOrApprovedShadowModel();
  const championModelRunId = active?.run.id ?? null;

  let challengerModelRunId: string | null = null;
  if (championModelRunId) {
    const challenger = await prisma.mlModelRun.findFirst({
      where: {
        modelType: "logistic_regression_shadow",
        targetLabel: active?.run.targetLabel,
        status: { in: ["APPROVED", "VALIDATED"] },
        NOT: { id: championModelRunId },
      },
      orderBy: { updatedAt: "desc" },
    });
    challengerModelRunId = challenger?.id ?? null;
  }

  const withChallenger = await prisma.paperTrade.count({
    where: { challengerAvailable: true },
  });

  const totalTrades = await prisma.paperTrade.count();

  const deltas = await prisma.paperTrade.findMany({
    where: { challengerAvailable: true },
    select: { challengerScoreDelta: true },
  });

  const deltaValues = deltas
    .map((d) => d.challengerScoreDelta)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const deltaSummary =
    deltaValues.length === 0
      ? null
      : {
          count: deltaValues.length,
          min: Math.min(...deltaValues),
          max: Math.max(...deltaValues),
          avg: deltaValues.reduce((a, b) => a + b, 0) / deltaValues.length,
        };

  const tradesByBot = await prisma.paperTrade.groupBy({
    by: ["botType"],
    _count: { _all: true },
  });

  const tradesWithChallengerByBot = await prisma.paperTrade.groupBy({
    by: ["botType"],
    where: { challengerAvailable: true },
    _count: { _all: true },
  });

  const coverageByBot: Record<
    string,
    { totalTrades: number; tradesWithChallenger: number; coveragePct: number | null }
  > = {};

  for (const row of tradesByBot) {
    const bot = row.botType ?? "default";
    const total = row._count._all;
    const withChallengerRow = tradesWithChallengerByBot.find(
      (r) => (r.botType ?? "default") === bot
    );
    const withChallengerCount = withChallengerRow?._count._all ?? 0;
    coverageByBot[bot] = {
      totalTrades: total,
      tradesWithChallenger: withChallengerCount,
      coveragePct: total > 0 ? withChallengerCount / total : null,
    };
  }

  const report = {
    generatedAt: timestamp,
    featureFlagEnabled: featureFlag,
    championModelRunId,
    challengerModelRunId,
    totalTrades,
    tradesWithChallenger: withChallenger,
    deltaSummary,
    coverageByBot,
  };

  const jsonPath = path.join(DUMP_DIR, "paper-champion-challenger-report.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const md: string[] = [];
  md.push("# Paper champion / challenger report");
  md.push("");
  md.push(`Generated: ${timestamp}`);
  md.push("");
  md.push("## Summary");
  md.push("");
  md.push(`- Feature flag ENABLE_ML_CHAMPION_CHALLENGER: ${featureFlag ? "enabled" : "disabled"}`);
  md.push(`- Champion model run id: ${championModelRunId ?? "none"}`);
  md.push(`- Challenger model run id (selection rule): ${challengerModelRunId ?? "none"}`);
  md.push(`- Total paper trades: ${totalTrades}`);
  md.push(`- Trades with challenger data: ${withChallenger}`);
  md.push("");
  md.push("## Score delta summary (challenger - champion)");
  md.push("");
  if (!deltaSummary) {
    md.push("No trades with challengerScoreDelta yet.");
  } else {
    md.push(`- Count: ${deltaSummary.count}`);
    md.push(`- Min: ${deltaSummary.min}`);
    md.push(`- Max: ${deltaSummary.max}`);
    md.push(`- Avg: ${deltaSummary.avg}`);
  }
  md.push("");
  md.push("## Per-bot challenger coverage");
  md.push("");
  md.push("| botType | totalTrades | tradesWithChallenger | coveragePct |");
  md.push("|---------|-------------|----------------------|-------------|");
  for (const [bot, row] of Object.entries(coverageByBot)) {
    md.push(
      `| ${bot} | ${row.totalTrades} | ${row.tradesWithChallenger} | ${
        row.coveragePct != null ? row.coveragePct.toFixed(3) : "-"
      } |`
    );
  }

  const mdPath = path.join(DUMP_DIR, "paper-champion-challenger-report.md");
  await fs.writeFile(mdPath, md.join("\n"), "utf8");

  console.log("Wrote", jsonPath);
  console.log("Wrote", mdPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

