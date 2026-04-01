import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { getActiveBotProfiles, type EffectiveBotProfile } from "../lib/paper-trading/bot-profiles";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score";

type SampleRow = {
  recommendationId: string;
  botType: string;
  assetId: string;
  marketId: string;
  side: string;
  score: number | null;
  dedupeKey: string;
  openSameExposureCount: number;
  dedupeRowStatus: string | null;
  dedupeRowId: string | null;
  missedByEarlySuppression: boolean;
  blockedByFinalDedupe: boolean;
  whyMissed: string;
  whyBlocked: string;
};

function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}

function buildDedupeKeyV2(
  modelRunId: string,
  botType: string,
  assetId: string,
  side: string,
  cooldownHours: number,
  tickTime: Date
): string {
  const bucketMs = cooldownHours * 60 * 60 * 1000 || 60 * 60 * 1000;
  const timeBucket = Math.floor(tickTime.getTime() / bucketMs);
  return `${modelRunId}|v2|${botType}|${assetId}|${side}|${timeBucket}`;
}

function fallbackProfiles(cfg: ReturnType<typeof getPaperTradingConfig>): EffectiveBotProfile[] {
  return [
    {
      botType: "default",
      botVersion: "v2",
      enabled: true,
      modelRunId: null,
      threshold: cfg.scoreThreshold,
      minScoreBuffer: cfg.minScoreBuffer,
      maxOpenTotal: cfg.maxOpenTotal,
      maxOpenPerMarket: cfg.maxOpenPerMarket,
      maxOpenPerTheme: cfg.maxOpenPerTheme,
      maxOpenPerCategory: cfg.maxOpenPerCategory,
      maxDailyNewTrades: cfg.maxDailyNewTrades,
      cooldownHours: cfg.cooldownHours,
      cooldownMarketHours: cfg.cooldownMarketHours,
      allowPaperRelaxation: false,
      allowRelaxationReasons: null,
      allowedPolicyStates: null,
      allowedPriceBands: null,
      excludedThemes: [],
      excludedCategories: [],
      notes: "v2_minimal_fallback_profile",
      effectiveEnabled: true,
      overrideSource: null,
      explorationEnabled: false,
      explorationBandBelowMinScore: 0,
      explorationMaxPerTick: 0,
      explorationMaxPerDay: 0,
      profileSnapshot: null,
    },
  ];
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const ticks = Math.max(1, parseInt(process.env.PAPER_DEDUPE_MISMATCH_TICKS ?? "12", 10));
  const cadenceMs = Math.max(0, parseInt(process.env.PAPER_DEDUPE_MISMATCH_CADENCE_MS ?? "500", 10));
  const cfg = getPaperTradingConfig();

  const activeModel = await getActiveOrApprovedShadowModel();
  if (!activeModel) throw new Error("No ACTIVE/APPROVED shadow model.");
  const loadedProfiles = await getActiveBotProfiles();
  const profiles = loadedProfiles.length > 0 ? loadedProfiles : fallbackProfiles(cfg);
  const cooldownByBot = new Map(profiles.map((p) => [p.botType, p.cooldownHours] as const));

  const sampleRows: SampleRow[] = [];
  const taxonomy = {
    alreadyOpenSameBotAssetSide: 0,
    dedupeKeyTimeBucketCollision: 0,
    existingRowNotCaughtByOpenOnlyCheck: 0,
    uniqueConstraintCollision: 0,
    other: 0,
  };

  for (let i = 0; i < ticks; i++) {
    const tick = await runPaperTradingTickV2({ dryRun: true });
    const tickTime = new Date(tick.tickTime);

    const dedupeRejected = tick.trace.filter((t) => t.rejectReason === "dedupe");
    for (const t of dedupeRejected) {
      const cooldownHours = cooldownByBot.get(t.botType) ?? cfg.cooldownHours;
      const dedupeKey = buildDedupeKeyV2(
        activeModel.run.id,
        t.botType,
        t.assetId,
        t.side,
        cooldownHours,
        tickTime
      );
      const [openCount, dedupeRow] = await Promise.all([
        prisma.paperTrade.count({
          where: { status: "open", botType: t.botType, assetId: t.assetId, side: t.side },
        }),
        prisma.paperTrade.findUnique({
          where: { dedupeKey },
          select: { id: true, status: true },
        }),
      ]);
      const missedByEarly = openCount === 0;
      const blockedByFinal = !!dedupeRow || openCount > 0;

      let whyMissed = "-";
      let whyBlocked = "-";
      if (!missedByEarly) {
        whyMissed = "not missed; open exposure existed (would be suppressible by open-only predicate)";
        taxonomy.alreadyOpenSameBotAssetSide++;
      } else if (dedupeRow) {
        whyMissed = "missed because early predicate checks only open status; no open row";
        whyBlocked = "blocked by final dedupeKey collision with existing historical PaperTrade row";
        taxonomy.dedupeKeyTimeBucketCollision++;
        taxonomy.existingRowNotCaughtByOpenOnlyCheck++;
      } else {
        whyMissed = "missed by open-only predicate (no open row found)";
      }
      if (!whyBlocked || whyBlocked === "-") {
        if (openCount > 0) whyBlocked = "blocked by existing open exposure dedupe pressure";
        else if (dedupeRow) whyBlocked = "blocked by existing dedupeKey row";
        else {
          whyBlocked = "blocked by dedupe path, exact DB row not found in post-check (possible timing/path overlap)";
          taxonomy.other++;
        }
      }

      sampleRows.push({
        recommendationId: t.recommendationId,
        botType: t.botType,
        assetId: t.assetId,
        marketId: t.marketId,
        side: t.side,
        score: t.score,
        dedupeKey,
        openSameExposureCount: openCount,
        dedupeRowStatus: dedupeRow?.status ?? null,
        dedupeRowId: dedupeRow?.id ?? null,
        missedByEarlySuppression: missedByEarly,
        blockedByFinalDedupe: blockedByFinal,
        whyMissed,
        whyBlocked,
      });
    }
    taxonomy.uniqueConstraintCollision += tick.dedupeCollisionBreakdown?.uniqueConstraintCollision ?? 0;
    if (i < ticks - 1 && cadenceMs > 0) await new Promise((r) => setTimeout(r, cadenceMs));
  }

  const lines: string[] = [];
  lines.push("# V2 Dedupe Key Mismatch Audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Window: ${ticks} dry-run ticks, cadence ${cadenceMs}ms`);
  lines.push(`- Active modelRunId: ${activeModel.run.id}`);
  lines.push("");
  lines.push("## A. Early suppression rule");
  lines.push("- Source: `lib/paper-trading/engine_v2_minimal.ts` in `runPaperTradingTickV2`.");
  lines.push(
    "- Predicate (env-gated): suppress candidate when `PAPER_V2_SUPPRESS_ALREADY_OPEN_DUPLICATE_EXPOSURES` is enabled AND there is an **open** `PaperTrade` with same `botType + assetId + side`."
  );
  lines.push("- Fields used: `status=open`, `botType`, `assetId`, `side`.");
  lines.push("");
  lines.push("## B. Final dedupe rule");
  lines.push("- Source: `lib/paper-trading/engine_v2_minimal.ts` in `runPaperTradingTickV2`.");
  lines.push("- Final DB dedupe check uses `findUnique({ where: { dedupeKey } })`.");
  lines.push("- `dedupeKey` semantics: `${modelRunId}|v2|${botType}|${assetId}|${side}|${timeBucket(cooldownHours)}`.");
  lines.push("- This check is status-agnostic (open or closed row can collide if dedupeKey exists).");
  lines.push("");
  lines.push("## C. Side-by-side mismatch sample");
  lines.push("| recommendationId | botType | assetId | side | score | early(open same exposure count) | final dedupe key | final row status | missed early? | blocked final? | why missed early | why blocked final |");
  lines.push("| --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- |");
  for (const r of sampleRows.slice(0, 40)) {
    lines.push(
      `| ${r.recommendationId} | ${r.botType} | ${r.assetId} | ${r.side} | ${fmt(r.score)} | ${r.openSameExposureCount} | ${r.dedupeKey} | ${r.dedupeRowStatus ?? "-"} | ${r.missedByEarlySuppression ? "yes" : "no"} | ${r.blockedByFinalDedupe ? "yes" : "no"} | ${r.whyMissed} | ${r.whyBlocked} |`
    );
  }
  lines.push("");
  lines.push("## D. Collision taxonomy");
  lines.push(`- already-open same botType+assetId+side: ${taxonomy.alreadyOpenSameBotAssetSide}`);
  lines.push(`- dedupeKey/time-bucket collision: ${taxonomy.dedupeKeyTimeBucketCollision}`);
  lines.push(`- existing PaperTrade row missed by open-only early check: ${taxonomy.existingRowNotCaughtByOpenOnlyCheck}`);
  lines.push(`- unique constraint collision: ${taxonomy.uniqueConstraintCollision}`);
  lines.push(`- other: ${taxonomy.other}`);
  lines.push("");
  lines.push("## E. Blunt conclusion");
  const conclusion = (() => {
    if (taxonomy.existingRowNotCaughtByOpenOnlyCheck > taxonomy.alreadyOpenSameBotAssetSide) {
      return "early suppression predicate is too narrow";
    }
    if (taxonomy.dedupeKeyTimeBucketCollision > 0 && taxonomy.existingRowNotCaughtByOpenOnlyCheck > 0) {
      return "final dedupe semantics are broader than intended";
    }
    if (taxonomy.alreadyOpenSameBotAssetSide > 0 && taxonomy.dedupeKeyTimeBucketCollision === 0) {
      return "candidate generation has no novelty and keeps hitting historical dedupe keys";
    }
    return "mixed causes";
  })();
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-dedupe-key-mismatch-audit.md");
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

