import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";

const BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;

type Obs = {
  recommendationId: string;
  botType: string;
  assetId: string;
  side: string;
  band: string;
  score: number | null;
  eligible: boolean;
  duplicateVsOpen: boolean;
};

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}
function classifyBand(priceRaw: string | null, fallbackBand: string | null): string {
  const fb = (fallbackBand ?? "").trim();
  if (BANDS.includes(fb as any)) return fb;
  const p = parseNum(priceRaw);
  if (p == null) return "unknown";
  if (p < 0.1) return "<0.1";
  if (p < 0.2) return "0.1-0.2";
  if (p < 0.3) return "0.2-0.3";
  if (p < 0.4) return "0.3-0.4";
  if (p < 0.6) return "0.4-0.6";
  if (p < 0.8) return "0.6-0.8";
  if (p < 0.9) return "0.8-0.9";
  return ">=0.9";
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const ticks = Math.max(1, parseInt(process.env.PAPER_OPEN_NOVELTY_TICKS ?? "24", 10));
  const cadenceMs = Math.max(0, parseInt(process.env.PAPER_OPEN_NOVELTY_CADENCE_MS ?? "500", 10));

  const openRows = await prisma.paperTrade.findMany({
    where: { status: "open", dedupeKey: { contains: "|v2|" } },
    select: { botType: true, assetId: true, side: true, entryPrice: true, entryPriceBand: true },
  });
  const openByBot: Record<string, number> = {};
  const openByBand: Record<string, number> = {};
  const openKeyCounts: Record<string, number> = {};
  const openExposureSet = new Set<string>();
  for (const r of openRows) {
    openByBot[r.botType] = (openByBot[r.botType] ?? 0) + 1;
    const band = classifyBand(r.entryPrice, r.entryPriceBand);
    openByBand[band] = (openByBand[band] ?? 0) + 1;
    const key = `${r.botType}|${r.assetId}|${r.side}`;
    openKeyCounts[key] = (openKeyCounts[key] ?? 0) + 1;
    openExposureSet.add(key);
  }

  const closedRows = await prisma.paperTrade.findMany({
    where: { status: "closed", dedupeKey: { contains: "|v2|" }, markout12h: { not: null } },
    select: { entryPrice: true, entryPriceBand: true, markout12h: true },
    take: 5000,
    orderBy: { createdAt: "desc" },
  });
  const bandProxy = new Map<string, number>();
  for (const b of BANDS) {
    const vals = closedRows
      .filter((r) => classifyBand(r.entryPrice, r.entryPriceBand) === b)
      .map((r) => parseNum(r.markout12h))
      .filter((x): x is number => x != null);
    if (vals.length) bandProxy.set(b, avg(vals)!);
  }

  let totalRawCandidates = 0;
  let totalScoredUnique = 0;
  let totalEligibleUnique = 0;
  const observations: Obs[] = [];
  const repeatedCollisionCounts: Record<string, number> = {};

  for (let i = 0; i < ticks; i++) {
    const r = await runPaperTradingTickV2({ dryRun: true });
    totalRawCandidates += r.candidatesLoaded;

    const bandByRec = new Map((r.scoreProvenanceSample ?? []).map((p) => [p.recommendationId, p.shadowBand ?? "unknown"]));
    const scoreByRec = new Map((r.scoreProvenanceSample ?? []).map((p) => [p.recommendationId, p.actualScoreUsedForOrdering ?? null]));

    const byRec = new Map<string, typeof r.trace>();
    for (const t of r.trace ?? []) {
      const arr = byRec.get(t.recommendationId) ?? [];
      arr.push(t);
      byRec.set(t.recommendationId, arr);
    }
    totalScoredUnique += byRec.size;

    for (const [rec, rows] of byRec.entries()) {
      const eligible = rows.some(
        (x) =>
          x.admitted ||
          (x.rejectReason !== "below_threshold" &&
            x.rejectReason !== "score_failed" &&
            x.rejectReason !== "liquidity_spread" &&
            x.rejectReason !== "liquidity_slippage")
      );
      if (eligible) totalEligibleUnique++;

      for (const row of rows) {
        const key = `${row.botType}|${row.assetId}|${row.side}`;
        const dup = openExposureSet.has(key);
        observations.push({
          recommendationId: rec,
          botType: row.botType,
          assetId: row.assetId,
          side: row.side,
          band: bandByRec.get(rec) ?? "unknown",
          score: scoreByRec.get(rec) ?? row.score ?? null,
          eligible,
          duplicateVsOpen: dup,
        });
        if (dup) repeatedCollisionCounts[key] = (repeatedCollisionCounts[key] ?? 0) + 1;
      }
    }

    if (i < ticks - 1 && cadenceMs > 0) await new Promise((res) => setTimeout(res, cadenceMs));
  }

  const eligibleObs = observations.filter((o) => o.eligible);
  const dupObs = eligibleObs.filter((o) => o.duplicateVsOpen);
  const novelObs = eligibleObs.filter((o) => !o.duplicateVsOpen);

  const bandMix = (arr: Obs[]): Record<string, number> =>
    arr.reduce<Record<string, number>>((acc, o) => {
      acc[o.band] = (acc[o.band] ?? 0) + 1;
      return acc;
    }, {});
  const proxyAvg = (arr: Obs[]): number | null => {
    const vals = arr.map((o) => bandProxy.get(o.band)).filter((x): x is number => x != null);
    return avg(vals);
  };

  const eligibleByRec = new Map<string, { duplicate: boolean }>();
  for (const o of eligibleObs) {
    const cur = eligibleByRec.get(o.recommendationId) ?? { duplicate: false };
    cur.duplicate = cur.duplicate || o.duplicateVsOpen;
    eligibleByRec.set(o.recommendationId, cur);
  }
  let duplicateEligibleUnique = 0;
  let novelEligibleUnique = 0;
  for (const v of eligibleByRec.values()) {
    if (v.duplicate) duplicateEligibleUnique++;
    else novelEligibleUnique++;
  }
  const eligibleExposureUnique = new Set(eligibleObs.map((o) => `${o.recommendationId}|${o.botType}`)).size;
  const duplicateExposureUnique = new Set(dupObs.map((o) => `${o.recommendationId}|${o.botType}`)).size;
  const novelExposureUnique = new Set(novelObs.map((o) => `${o.recommendationId}|${o.botType}`)).size;

  const topCollisions = Object.entries(repeatedCollisionCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const totalCollisionEvents = Object.values(repeatedCollisionCounts).reduce((a, b) => a + b, 0);
  const top5Share =
    totalCollisionEvents > 0
      ? topCollisions.slice(0, 5).reduce((a, [, c]) => a + c, 0) / totalCollisionEvents
      : 0;

  const lines: string[] = [];
  lines.push("# V2 Open Exposure Novelty Audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Window: ${ticks} dry-run ticks, cadence ${cadenceMs}ms`);
  lines.push("");
  lines.push("## A. Open inventory snapshot");
  lines.push(`- currently open V2 positions: ${openRows.length}`);
  lines.push(`- by botType: ${JSON.stringify(openByBot)}`);
  lines.push(`- by band: ${JSON.stringify(openByBand)}`);
  lines.push(`- distinct open exposure keys (botType|assetId|side): ${openExposureSet.size}`);
  lines.push("");
  lines.push("## B. Candidate novelty breakdown");
  lines.push(`- total raw candidates: ${totalRawCandidates}`);
  lines.push(`- total scored unique candidates: ${totalScoredUnique}`);
  lines.push(`- total eligible unique candidates: ${totalEligibleUnique}`);
  lines.push(`- eligible unique candidates matching already-open exposure (recommendation-level): ${duplicateEligibleUnique}`);
  lines.push(`- eligible unique candidates novel (recommendation-level): ${novelEligibleUnique}`);
  lines.push(`- eligible unique candidate-bot exposures: ${eligibleExposureUnique}`);
  lines.push(`- eligible unique duplicate exposures (candidate-bot): ${duplicateExposureUnique}`);
  lines.push(`- eligible unique novel exposures (candidate-bot): ${novelExposureUnique}`);
  lines.push("");
  lines.push("## C. Quality of novel vs duplicate candidates");
  lines.push(`- duplicate eligible rows: ${dupObs.length}`);
  lines.push(`- duplicate avg score: ${fmt(avg(dupObs.map((o) => o.score).filter((x): x is number => x != null)))}`);
  lines.push(`- duplicate band mix: ${JSON.stringify(bandMix(dupObs))}`);
  lines.push(`- duplicate proxy quality (band-based): ${fmt(proxyAvg(dupObs))}`);
  lines.push(`- novel eligible rows: ${novelObs.length}`);
  lines.push(`- novel avg score: ${fmt(avg(novelObs.map((o) => o.score).filter((x): x is number => x != null)))}`);
  lines.push(`- novel band mix: ${JSON.stringify(bandMix(novelObs))}`);
  lines.push(`- novel proxy quality (band-based): ${fmt(proxyAvg(novelObs))}`);
  lines.push("");
  lines.push("## D. Opportunity concentration");
  lines.push(`- repeated collision events (eligible rows colliding with open exposures): ${totalCollisionEvents}`);
  lines.push(`- top-5 collision share: ${(top5Share * 100).toFixed(2)}%`);
  lines.push("| botType|assetId|side | collision events |");
  lines.push("| --- | ---: |");
  for (const [k, c] of topCollisions) lines.push(`| ${k} | ${c} |`);
  lines.push("");
  lines.push("## E. Blunt conclusion");
  let conclusion = "evidence insufficient";
  const novelExposureShare = eligibleExposureUnique > 0 ? novelExposureUnique / eligibleExposureUnique : 0;
  if (novelExposureShare < 0.1) {
    conclusion = "candidate set lacks novelty and needs broader opportunity generation";
  } else if (duplicateExposureUnique > 0 && novelExposureUnique > 0 && top5Share > 0.6) {
    conclusion = "collisions are concentrated in a few markets only";
  } else if (novelExposureUnique > 0 && duplicateExposureUnique > 0) {
    conclusion = "novelty exists but is being lost later in pipeline";
  }
  lines.push(`- ${conclusion}`);
  lines.push("");
  lines.push("## JSON summary");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        generatedAt,
        window: { ticks, cadenceMs },
        openInventory: {
          openCount: openRows.length,
          byBotType: openByBot,
          byBand: openByBand,
          distinctOpenExposureKeys: openExposureSet.size,
          topOpenExposureKeys: Object.entries(openKeyCounts).sort((a, b) => b[1] - a[1]).slice(0, 15),
        },
        noveltyBreakdown: {
          totalRawCandidates,
          totalScoredUnique,
          totalEligibleUnique,
          duplicateEligibleUniqueRecommendationLevel: duplicateEligibleUnique,
          novelEligibleUniqueRecommendationLevel: novelEligibleUnique,
          eligibleExposureUnique,
          duplicateExposureUnique,
          novelExposureUnique,
        },
        quality: {
          duplicate: {
            rows: dupObs.length,
            avgScore: avg(dupObs.map((o) => o.score).filter((x): x is number => x != null)),
            bandMix: bandMix(dupObs),
            proxyBandMarkoutAvg: proxyAvg(dupObs),
          },
          novel: {
            rows: novelObs.length,
            avgScore: avg(novelObs.map((o) => o.score).filter((x): x is number => x != null)),
            bandMix: bandMix(novelObs),
            proxyBandMarkoutAvg: proxyAvg(novelObs),
          },
        },
        opportunityConcentration: {
          collisionEvents: totalCollisionEvents,
          top5Share,
          topRepeatedCollisionKeys: topCollisions,
        },
        conclusion,
      },
      null,
      2
    )
  );
  lines.push("```");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-open-exposure-novelty-audit.md");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

