import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { getFunderForPaperTradingTick } from "../lib/decision/recompute";
import {
  getSubmittedShadowCandidatesForTickWithDiagnostics,
  loadShadowCandidatesForPaperTick,
  normalizePreferredFunderForShadowLoad,
  type PaperTradingCandidate,
} from "../lib/paper-trading/candidates";
import { getPaperTradingConfig } from "../lib/paper-trading/config";
import { getActiveBotProfiles, type EffectiveBotProfile } from "../lib/paper-trading/bot-profiles";
import { evaluatePaperLiquidityGuards } from "../lib/paper-trading/paper-roi-admission";
import { buildStructuredScoringModel, scoreStructuredCandidates } from "../lib/paper-trading/structured_scorer";
import { buildExternalSignalFeatureVectors } from "../lib/paper-trading/features/external_signal_features";
import { getActiveOrApprovedShadowModel } from "../lib/ml/shadow-score";

type RejectDetail = {
  recommendationId: string;
  assetId: string;
  botType: string;
  dedupeKey: string;
  matchingPaperTradeId: string | null;
  matchingStatus: string | null;
  matchingEntryTimeIso: string | null;
  matchingBotType: string | null;
  cause: "open_trade" | "recent_closed_same_bucket" | "other";
  priceBand: string;
  spreadQuartile: string;
  cooldownHours: number;
};

function parseNum(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function buildDedupeKeyV2(
  modelRunId: string,
  botType: string,
  assetId: string,
  side: string,
  cooldownHours: number
): string {
  const bucketMs = cooldownHours * 60 * 60 * 1000 || 60 * 60 * 1000;
  const timeBucket = Math.floor(Date.now() / bucketMs);
  return `${modelRunId}|v2|${botType}|${assetId}|${side}|${timeBucket}`;
}

function estimateSlippageBps(c: PaperTradingCandidate): number | null {
  const dec = parseNum(c.shadowInput.estimatedSlippage);
  return dec == null ? null : dec * 10_000;
}

async function main(): Promise<void> {
  const cfg = getPaperTradingConfig();
  const explicitFunder = process.argv[2]?.trim() || undefined;
  const preferred = normalizePreferredFunderForShadowLoad(
    explicitFunder ?? (await getFunderForPaperTradingTick())
  );

  const loaded = await loadShadowCandidatesForPaperTick({ preferredFunder: preferred });
  const candidatesAfter = loaded.candidates;
  const funderUsed = loaded.shadowDiagnostics.funderUsedForLoad ?? preferred ?? "";
  const lookbackMinutes = loaded.shadowDiagnostics.lookbackMinutes;
  const raw = funderUsed
    ? await getSubmittedShadowCandidatesForTickWithDiagnostics({
        funderAddress: funderUsed,
        lookbackMinutes,
      })
    : { candidates: [] as PaperTradingCandidate[] };
  const candidatesBeforeCount = raw.candidates.length;

  const model = await buildStructuredScoringModel(30);
  const activeModel = await getActiveOrApprovedShadowModel();
  const modelRunId = activeModel?.run.id ?? "unknown_model";
  const external = await buildExternalSignalFeatureVectors(candidatesAfter);
  const scored = scoreStructuredCandidates(candidatesAfter, model, external.byRecommendationId);

  const profiles = await getActiveBotProfiles();
  const effectiveProfiles: EffectiveBotProfile[] =
    profiles.length > 0
      ? profiles
      : [
          {
            botType: "default",
            displayName: "Default",
            enabled: true,
            targetLabel: null,
            botVersion: null,
            threshold: cfg.threshold,
            minScoreBuffer: cfg.minScoreBuffer,
            allowReviewRequired: true,
            allowPaperRelaxation: false,
            allowRelaxationReasons: null,
            allowedPolicyStates: null,
            allowedPriceBands: null,
            excludedThemes: [],
            excludedCategories: [],
            cooldownHours: cfg.cooldownHours,
            cooldownMarketHours: cfg.cooldownMarketHours,
            maxOpenTotal: cfg.maxOpenTotal,
            maxOpenPerMarket: cfg.maxOpenPerMarket,
            maxOpenPerTheme: cfg.maxOpenPerTheme,
            maxOpenPerCategory: cfg.maxOpenPerCategory,
            maxDailyNewTrades: cfg.maxDailyNewTrades,
            notes: "default",
            effectiveEnabled: true,
            overrideSource: null,
            explorationEnabled: false,
            explorationBandBelowMinScore: 0,
            explorationMaxPerTick: 0,
            explorationMaxPerDay: 0,
          },
        ];

  const totalCombos = candidatesAfter.length * effectiveProfiles.length;
  let openTotal = await prisma.paperTrade.count({ where: { status: "open" } });
  const openByBot = new Map<string, number>();
  for (const p of effectiveProfiles) {
    openByBot.set(
      p.botType,
      await prisma.paperTrade.count({ where: { status: "open", botType: p.botType } })
    );
  }

  const scoredById = new Map(scored.map((s) => [s.candidate.recommendationId, s] as const));
  const dedupeChecked = new Map<string, { id: string; status: string; entryTime: Date; botType: string } | null>();
  const tickDedupe = new Set<string>();
  const dedupeRejects: RejectDetail[] = [];

  for (const profile of effectiveProfiles) {
    const threshold = profile.threshold + profile.minScoreBuffer;
    const ranked = [...scored]
      .filter((s) => s.score >= threshold)
      .filter((s) => {
        const spreadBps = parseNum(s.candidate.shadowInput.spreadBps);
        const slippageBps = estimateSlippageBps(s.candidate);
        const liq = evaluatePaperLiquidityGuards(
          spreadBps,
          slippageBps,
          cfg.paperMaxSpreadBps,
          cfg.paperMaxEstimatedSlippageBps
        );
        return liq.ok;
      })
      .sort((a, b) =>
        b.score === a.score
          ? a.candidate.recommendationId.localeCompare(b.candidate.recommendationId)
          : b.score - a.score
      );

    for (const s of ranked) {
      const perBotOpen = openByBot.get(profile.botType) ?? 0;
      if (cfg.maxOpenTotal > 0 && openTotal >= cfg.maxOpenTotal) continue;
      if (profile.maxOpenTotal > 0 && perBotOpen >= profile.maxOpenTotal) continue;

      const c = s.candidate;
      const key = buildDedupeKeyV2(modelRunId, profile.botType, c.assetId, c.side, profile.cooldownHours);

      let matching = dedupeChecked.get(key);
      if (matching === undefined) {
        matching = await prisma.paperTrade.findUnique({
          where: { dedupeKey: key },
          select: { id: true, status: true, entryTime: true, botType: true },
        });
        dedupeChecked.set(key, matching);
      }

      if (tickDedupe.has(key) || matching) {
        const cause =
          matching?.status === "open"
            ? "open_trade"
            : matching?.status === "closed"
              ? "recent_closed_same_bucket"
              : "other";
        dedupeRejects.push({
          recommendationId: c.recommendationId,
          assetId: c.assetId,
          botType: profile.botType,
          dedupeKey: key,
          matchingPaperTradeId: matching?.id ?? null,
          matchingStatus: matching?.status ?? null,
          matchingEntryTimeIso: matching?.entryTime?.toISOString() ?? null,
          matchingBotType: matching?.botType ?? null,
          cause,
          priceBand: scoredById.get(c.recommendationId)?.priceBand ?? "unknown",
          spreadQuartile: scoredById.get(c.recommendationId)?.spreadQuartile ?? "unknown",
          cooldownHours: profile.cooldownHours,
        });
        continue;
      }

      tickDedupe.add(key);
      openTotal += 1;
      openByBot.set(profile.botType, perBotOpen + 1);
    }
  }

  const byBot = new Map<string, number>();
  const byBandQuartile = new Map<string, number>();
  let causedByOpen = 0;
  let causedByClosed = 0;
  for (const r of dedupeRejects) {
    byBot.set(r.botType, (byBot.get(r.botType) ?? 0) + 1);
    const k = `${r.priceBand}|${r.spreadQuartile}`;
    byBandQuartile.set(k, (byBandQuartile.get(k) ?? 0) + 1);
    if (r.cause === "open_trade") causedByOpen++;
    if (r.cause === "recent_closed_same_bucket") causedByClosed++;
  }

  // One-bucket-shorter what-if: halve bucket length (minimum 1h).
  const uniqueRejectKeys = new Set(dedupeRejects.map((r) => `${r.recommendationId}|${r.botType}|${r.assetId}`));
  let wouldBecomeAdmissible = 0;
  for (const key of uniqueRejectKeys) {
    const [recommendationId, botType, assetId] = key.split("|");
    const r = dedupeRejects.find((x) => x.recommendationId === recommendationId && x.botType === botType && x.assetId === assetId);
    if (!r) continue;
    const c = candidatesAfter.find((x) => x.recommendationId === recommendationId && x.assetId === assetId);
    if (!c) continue;
    const halfHours = Math.max(1, Math.floor(r.cooldownHours / 2));
    const shorterKey = buildDedupeKeyV2(modelRunId, botType, c.assetId, c.side, halfHours);
    const existsShorter = await prisma.paperTrade.findUnique({
      where: { dedupeKey: shorterKey },
      select: { id: true },
    });
    if (!existsShorter) wouldBecomeAdmissible++;
  }

  const outDir = path.join(process.cwd(), "dump", "repo-exploration-pack");
  const outPath = path.join(outDir, "12-v2-dedupe-pressure-report.md");
  await fs.mkdir(outDir, { recursive: true });

  const lines: string[] = [];
  lines.push("# V2 Structured Scorer Dedupe Pressure Report");
  lines.push("");
  lines.push("## Snapshot summary");
  lines.push(`- total candidates before mid-range filter: ${candidatesBeforeCount}`);
  lines.push(`- total candidates after mid-range filter: ${candidatesAfter.length}`);
  lines.push(`- total candidate×bot combinations considered: ${totalCombos}`);
  lines.push(`- total dedupe rejects: ${dedupeRejects.length}`);
  lines.push("");
  lines.push("## Per-dedupe reject details");
  lines.push("| recommendationId | assetId | botType | dedupeKey | matching row id | status | entryTime | matching botType |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of dedupeRejects) {
    lines.push(
      `| ${r.recommendationId} | ${r.assetId} | ${r.botType} | ${r.dedupeKey} | ${r.matchingPaperTradeId ?? "-"} | ${r.matchingStatus ?? "-"} | ${r.matchingEntryTimeIso ?? "-"} | ${r.matchingBotType ?? "-"} |`
    );
  }
  lines.push("");
  lines.push("## Aggregate summary");
  lines.push(`- dedupe rejects caused by same open trade: ${causedByOpen}`);
  lines.push(`- dedupe rejects caused by recent closed trade in same bucket: ${causedByClosed}`);
  lines.push("- dedupe rejects by botType:");
  for (const [bot, n] of [...byBot.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  - ${bot}: ${n}`);
  }
  lines.push("- dedupe rejects by price band / spread quartile:");
  for (const [k, n] of [...byBandQuartile.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  - ${k}: ${n}`);
  }
  lines.push("");
  lines.push("## Time-bucket analysis");
  lines.push("- Current dedupe logic in V2:");
  lines.push("  - `bucketMs = cooldownHours * 60 * 60 * 1000`");
  lines.push("  - `timeBucket = floor(nowMs / bucketMs)`");
  lines.push("  - `dedupeKey = modelRunId|v2|botType|assetId|side|timeBucket`");
  lines.push(
    `- Estimated candidates admissible with one-bucket-shorter window (simulated as cooldownHours/2, min 1h): ${wouldBecomeAdmissible}`
  );
  lines.push("");
  lines.push("## Final assessment");
  if (dedupeRejects.length === 0) {
    lines.push("- No dedupe pressure detected in this snapshot.");
  } else if (causedByOpen / dedupeRejects.length >= 0.7) {
    lines.push("- Dedupe is mostly preventing true duplicate opens against currently open positions.");
  } else {
    lines.push("- Dedupe is blocking some turnover via same-bucket collisions, including recently closed trades.");
  }

  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
