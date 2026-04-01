import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";
import { getPaperTradingConfig } from "../lib/paper-trading/config";

type Row = {
  recommendationId: string;
  marketId: string | null;
  band: string | null;
  scoreUsed: number | null;
  rejectReason: string | null;
  admitted: boolean;
  spreadBps: number | null;
  proxyMarkout: number | null;
  proxySource: "shadow_candidate" | "paper_market_proxy" | "paper_band_proxy" | null;
};

const BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function avg(vals: number[]): number | null {
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function median(vals: number[]): number | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function winRate(vals: number[]): number | null {
  if (!vals.length) return null;
  return vals.filter((x) => x > 0).length / vals.length;
}
function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}
function pct(n: number | null): string {
  return n == null ? "-" : `${(n * 100).toFixed(2)}%`;
}
function parseExecutionQuality(raw: string | null | undefined): { spreadBps: number | null } {
  if (!raw) return { spreadBps: null };
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    return { spreadBps: parseNum(j.spreadBps) };
  } catch {
    return { spreadBps: null };
  }
}

async function main(): Promise<void> {
  const cfg = getPaperTradingConfig();
  const ticks = Math.max(1, parseInt(process.env.PAPER_SPREAD_NEAR_MISS_TICKS ?? "60", 10));
  const cadenceMs = Math.max(0, parseInt(process.env.PAPER_SPREAD_NEAR_MISS_CADENCE_MS ?? "500", 10));
  const spreadCut = cfg.paperMaxSpreadBps;
  const nearUpper10 = spreadCut * 1.1;
  const nearUpper20 = spreadCut * 1.2;
  const generatedAt = new Date().toISOString();

  const sampled: Row[] = [];
  for (let i = 0; i < ticks; i++) {
    const tick = await runPaperTradingTickV2({ dryRun: true });
    const byRec = new Map<string, { band: string | null; score: number | null; candidateId: string | null }>();
    for (const p of tick.scoreProvenanceSample ?? []) {
      byRec.set(p.recommendationId, {
        band: p.shadowBand ?? null,
        score: p.actualScoreUsedForOrdering ?? null,
        candidateId: null,
      });
    }
    for (const t of tick.trace) {
      const m = byRec.get(t.recommendationId) ?? { band: null, score: t.score, candidateId: null };
      m.candidateId = t.candidateId ?? m.candidateId;
      if (m.score == null) m.score = t.score;
      byRec.set(t.recommendationId, m);
    }

    const candidateIds = [...new Set([...byRec.values()].map((v) => v.candidateId).filter((x): x is string => !!x))];
    const scRows = candidateIds.length
      ? await prisma.shadowCandidate.findMany({
          where: { id: { in: candidateIds } },
          select: {
            id: true,
            executionQualitySnapshotJson: true,
            markout1h: true,
            markout6h: true,
            markout24h: true,
          },
        })
      : [];
    const byId = new Map(scRows.map((r) => [r.id, r]));

    for (const t of tick.trace) {
      const m = byRec.get(t.recommendationId);
      const sc = m?.candidateId ? byId.get(m.candidateId) : null;
      const spreadBps = parseExecutionQuality(sc?.executionQualitySnapshotJson).spreadBps;
      const proxy = sc
        ? parseNum(sc.markout6h) ?? parseNum(sc.markout24h) ?? parseNum(sc.markout1h)
        : null;
      sampled.push({
        recommendationId: t.recommendationId,
        marketId: t.marketId ?? null,
        band: m?.band ?? null,
        scoreUsed: m?.score ?? t.score ?? null,
        rejectReason: t.rejectReason ?? null,
        admitted: t.admitted,
        spreadBps,
        proxyMarkout: proxy,
        proxySource: proxy != null ? "shadow_candidate" : null,
      });
    }
    if (i < ticks - 1 && cadenceMs > 0) await new Promise((r) => setTimeout(r, cadenceMs));
  }

  const closedTrades = await prisma.paperTrade.findMany({
    where: { status: "closed", markout12h: { not: null } },
    select: { marketId: true, entryPriceBand: true, markout12h: true },
    orderBy: { createdAt: "desc" },
    take: 20000,
  });
  const marketMarkoutMap = new Map<string, number[]>();
  const bandMarkoutMap = new Map<string, number[]>();
  for (const t of closedTrades) {
    const m = parseNum(t.markout12h);
    if (m == null) continue;
    const mm = marketMarkoutMap.get(t.marketId) ?? [];
    mm.push(m);
    marketMarkoutMap.set(t.marketId, mm);
    if (t.entryPriceBand) {
      const bm = bandMarkoutMap.get(t.entryPriceBand) ?? [];
      bm.push(m);
      bandMarkoutMap.set(t.entryPriceBand, bm);
    }
  }
  for (const r of sampled) {
    if (r.proxyMarkout != null) continue;
    if (r.marketId) {
      const mm = marketMarkoutMap.get(r.marketId);
      if (mm?.length) {
        r.proxyMarkout = avg(mm);
        r.proxySource = "paper_market_proxy";
        continue;
      }
    }
    if (r.band) {
      const bm = bandMarkoutMap.get(r.band);
      if (bm?.length) {
        r.proxyMarkout = avg(bm);
        r.proxySource = "paper_band_proxy";
      }
    }
  }

  const admitted = sampled.filter((r) => r.admitted);
  const spreadRejected = sampled.filter((r) => r.rejectReason === "liquidity_spread");
  const nearSpread = spreadRejected.filter((r) => r.spreadBps != null && r.spreadBps > spreadCut && r.spreadBps <= nearUpper10);
  const mediumSpread = spreadRejected.filter((r) => r.spreadBps != null && r.spreadBps > nearUpper10 && r.spreadBps <= nearUpper20);
  const farSpread = spreadRejected.filter((r) => r.spreadBps != null && r.spreadBps > nearUpper20);

  const toNums = (rows: Row[], key: "scoreUsed" | "proxyMarkout"): number[] =>
    rows.map((r) => r[key]).filter((x): x is number => x != null);
  const mix = (rows: Row[]): string =>
    BANDS.map((b) => `${b}:${rows.filter((r) => r.band === b).length}`).join(", ");
  const summarizeSegment = (name: string, rows: Row[]) => ({
    name,
    count: rows.length,
    avgScore: avg(toNums(rows, "scoreUsed")),
    avgProxy: avg(toNums(rows, "proxyMarkout")),
    winRateProxy: winRate(toNums(rows, "proxyMarkout")),
    bandMix: mix(rows),
  });
  const segments = [
    summarizeSegment("near (0% to +10%)", nearSpread),
    summarizeSegment("medium (+10% to +20%)", mediumSpread),
    summarizeSegment("far (>+20%)", farSpread),
  ];

  const bandNearVsAdmitted = BANDS.map((b) => {
    const near = nearSpread.filter((r) => r.band === b);
    const medium = mediumSpread.filter((r) => r.band === b);
    const far = farSpread.filter((r) => r.band === b);
    const adm = admitted.filter((r) => r.band === b);
    const nearProxy = toNums(near, "proxyMarkout");
    const mediumProxy = toNums(medium, "proxyMarkout");
    const farProxy = toNums(far, "proxyMarkout");
    const admProxy = toNums(adm, "proxyMarkout");
    return {
      band: b,
      nearCount: near.length,
      mediumCount: medium.length,
      farCount: far.length,
      nearAvgProxy: avg(nearProxy),
      mediumAvgProxy: avg(mediumProxy),
      farAvgProxy: avg(farProxy),
      admittedCount: adm.length,
      admittedAvgProxy: avg(admProxy),
      deltaNearMinusAdmitted: (avg(nearProxy) ?? 0) - (avg(admProxy) ?? 0),
      deltaMediumMinusAdmitted: (avg(mediumProxy) ?? 0) - (avg(admProxy) ?? 0),
      deltaFarMinusAdmitted: (avg(farProxy) ?? 0) - (avg(admProxy) ?? 0),
    };
  });

  const lines: string[] = [];
  lines.push("# V2 Spread Near-Miss Recovery Audit");
  lines.push("");
  lines.push("## A. Window / sample definition");
  lines.push(`- generated: ${generatedAt}`);
  lines.push(`- source: repeated dry-run V2 ticks (${ticks} ticks, cadence ${cadenceMs}ms) + ShadowCandidate spread/markout proxy`);
  lines.push(`- sampled trace rows: ${sampled.length}`);
  lines.push(`- spread cutoff: ${spreadCut} bps`);
  lines.push(`- segment definitions: near (${spreadCut}, ${nearUpper10.toFixed(3)}], medium (${nearUpper10.toFixed(3)}, ${nearUpper20.toFixed(3)}], far > ${nearUpper20.toFixed(3)} bps`);
  const proxySourceCounts = sampled.reduce<Record<string, number>>((acc, r) => {
    const k = r.proxySource ?? "none";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  lines.push(`- proxy source coverage: ${Object.entries(proxySourceCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push("");
  lines.push("## B. Near vs medium vs far spread rejects");
  lines.push("| segment | count | avg score used | avg proxy markout | win-rate proxy | price-band mix |");
  lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
  for (const s of segments) {
    lines.push(`| ${s.name} | ${s.count} | ${fmt(s.avgScore)} | ${fmt(s.avgProxy)} | ${pct(s.winRateProxy)} | ${s.bandMix} |`);
  }
  lines.push("");
  lines.push("## C. Compare against admitted cohort");
  const admittedAvgProxy = avg(toNums(admitted, "proxyMarkout"));
  lines.push(`- admitted count: ${admitted.length}`);
  lines.push(`- admitted avg score used: ${fmt(avg(toNums(admitted, "scoreUsed")))}`);
  lines.push(`- admitted avg proxy markout: ${fmt(admittedAvgProxy)}`);
  lines.push(`- admitted median proxy markout: ${fmt(median(toNums(admitted, "proxyMarkout")))}`);
  lines.push(`- admitted win-rate proxy: ${pct(winRate(toNums(admitted, "proxyMarkout")))}`);
  lines.push(`- admitted band mix: ${mix(admitted)}`);
  for (const s of segments) {
    lines.push(`- ${s.name} delta vs admitted (avg proxy): ${fmt((s.avgProxy ?? 0) - (admittedAvgProxy ?? 0))}`);
  }
  lines.push("");
  lines.push("## D. Near-vs-far differential");
  lines.push(`- near-minus-far avg proxy markout delta: ${fmt((avg(toNums(nearSpread, "proxyMarkout")) ?? 0) - (avg(toNums(farSpread, "proxyMarkout")) ?? 0))}`);
  lines.push(`- medium-minus-far avg proxy markout delta: ${fmt((avg(toNums(mediumSpread, "proxyMarkout")) ?? 0) - (avg(toNums(farSpread, "proxyMarkout")) ?? 0))}`);
  lines.push("");
  lines.push("## E. Band-level near-miss quality");
  lines.push("| band | near count | near avg | medium count | medium avg | far count | far avg | admitted count | admitted avg | near-admitted delta |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of bandNearVsAdmitted) {
    if (r.nearCount + r.mediumCount + r.farCount + r.admittedCount < 10) continue;
    lines.push(
      `| ${r.band} | ${r.nearCount} | ${fmt(r.nearAvgProxy)} | ${r.mediumCount} | ${fmt(r.mediumAvgProxy)} | ${r.farCount} | ${fmt(r.farAvgProxy)} | ${r.admittedCount} | ${fmt(r.admittedAvgProxy)} | ${fmt(r.deltaNearMinusAdmitted)} |`
    );
  }
  lines.push("");
  lines.push("## E2. Stability note");
  const segmentSignal = segments
    .map((s) => ({
      delta: (s.avgProxy ?? 0) - (admittedAvgProxy ?? 0),
      hasSample: s.count >= 20,
    }))
    .filter((x) => x.hasSample);
  let stability = "too sparse";
  if (segmentSignal.length >= 2) {
    const positives = segmentSignal.filter((x) => x.delta >= -0.001).length;
    const negatives = segmentSignal.filter((x) => x.delta < -0.001).length;
    if (positives > 0 && negatives > 0) stability = "mixed";
    else stability = "consistent";
  }
  lines.push(`- stability assessment: ${stability}`);
  lines.push("");
  lines.push("## F. Blunt conclusion");
  const nearProxy = toNums(nearSpread, "proxyMarkout");
  const mediumProxy = toNums(mediumSpread, "proxyMarkout");
  const farProxy = toNums(farSpread, "proxyMarkout");
  const admittedProxy = toNums(admitted, "proxyMarkout");
  let conclusion = "evidence insufficient";
  const nearAvg = avg(nearProxy) ?? 0;
  const admittedAvg = avg(admittedProxy) ?? 0;
  if (nearProxy.length >= 50 && admittedProxy.length >= 100 && nearAvg <= admittedAvg - 0.002) {
    conclusion = "spread near-misses do not look recoverable";
  }
  if (nearProxy.length >= 20 && mediumProxy.length >= 20 && farProxy.length >= 20 && admittedProxy.length >= 20) {
    const nearAvgMulti = avg(nearProxy) ?? 0;
    const mediumAvg = avg(mediumProxy) ?? 0;
    const farAvg = avg(farProxy) ?? 0;
    const admAvg = avg(admittedProxy) ?? 0;
    const strongNear = nearAvgMulti > farAvg + 0.001 && nearAvgMulti >= admAvg - 0.001;
    const bandRecoverable = bandNearVsAdmitted.some(
      (b) => b.nearCount >= 10 && b.admittedCount >= 10 && (b.nearAvgProxy ?? -1) >= (b.admittedAvgProxy ?? 1) - 0.001
    );
    if (strongNear && mediumAvg > farAvg + 0.0005) conclusion = "narrow spread near-misses look recoverable";
    else if (bandRecoverable) conclusion = "only certain bands look recoverable";
    else if (nearAvgMulti <= farAvg + 0.001) conclusion = "spread near-misses do not look recoverable";
  }
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-spread-near-miss-recovery-audit.md");
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

