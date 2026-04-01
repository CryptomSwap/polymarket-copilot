import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";

const BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;
type Band = (typeof BANDS)[number];

type CandidateObs = {
  recommendationId: string;
  marketId: string | null;
  band: Band | null;
  score: number | null;
  admitted: boolean;
  thresholdPass: boolean;
  rejected: boolean;
  proxyMarkout: number | null;
};

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
function asBand(v: string | null | undefined): Band | null {
  if (!v) return null;
  return (BANDS as readonly string[]).includes(v) ? (v as Band) : null;
}

async function main(): Promise<void> {
  const ticks = Math.max(1, parseInt(process.env.PAPER_BAND_ALLOC_AUDIT_TICKS ?? "60", 10));
  const cadenceMs = Math.max(0, parseInt(process.env.PAPER_BAND_ALLOC_AUDIT_CADENCE_MS ?? "500", 10));
  const generatedAt = new Date().toISOString();

  const observations: CandidateObs[] = [];
  for (let i = 0; i < ticks; i++) {
    const tick = await runPaperTradingTickV2({ dryRun: true });
    const byRec = new Map<
      string,
      {
        marketId: string | null;
        band: Band | null;
        score: number | null;
        admitted: boolean;
        thresholdPass: boolean;
      }
    >();
    for (const p of tick.scoreProvenanceSample ?? []) {
      byRec.set(p.recommendationId, {
        marketId: null,
        band: asBand(p.shadowBand),
        score: p.actualScoreUsedForOrdering ?? null,
        admitted: false,
        thresholdPass: false,
      });
    }
    for (const t of tick.trace) {
      const e = byRec.get(t.recommendationId) ?? {
        marketId: null,
        band: null,
        score: t.score ?? null,
        admitted: false,
        thresholdPass: false,
      };
      e.marketId = t.marketId ?? e.marketId;
      if (e.score == null) e.score = t.score ?? null;
      e.admitted = e.admitted || t.admitted;
      const passThisTrace = t.admitted || (t.rejectReason !== "score_failed" && t.rejectReason !== "below_threshold");
      e.thresholdPass = e.thresholdPass || passThisTrace;
      byRec.set(t.recommendationId, e);
    }
    for (const [recommendationId, e] of byRec) {
      observations.push({
        recommendationId,
        marketId: e.marketId,
        band: e.band,
        score: e.score,
        admitted: e.admitted,
        thresholdPass: e.thresholdPass,
        rejected: !e.admitted,
        proxyMarkout: null,
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
  for (const o of observations) {
    if (o.marketId) {
      const mm = marketMarkoutMap.get(o.marketId);
      if (mm?.length) {
        o.proxyMarkout = avg(mm);
        continue;
      }
    }
    if (o.band) {
      const bm = bandMarkoutMap.get(o.band);
      if (bm?.length) o.proxyMarkout = avg(bm);
    }
  }

  const admitted = observations.filter((o) => o.admitted);
  const thresholdPass = observations.filter((o) => o.thresholdPass);
  const scored = observations.filter((o) => o.score != null);

  const byBandRows = BANDS.map((band) => {
    const admittedBand = admitted.filter((o) => o.band === band);
    const admittedScore = admittedBand.map((o) => o.score).filter((x): x is number => x != null);
    const admittedProxy = admittedBand.map((o) => o.proxyMarkout).filter((x): x is number => x != null);
    const thresholdBand = thresholdPass.filter((o) => o.band === band);
    const scoredBand = scored.filter((o) => o.band === band);
    const contribution = admittedProxy.reduce((a, b) => a + b, 0);
    return {
      band,
      admittedCount: admittedBand.length,
      admittedAvgScore: avg(admittedScore),
      admittedAvgProxy: avg(admittedProxy),
      admittedMedianProxy: median(admittedProxy),
      admittedWinRateProxy: winRate(admittedProxy),
      admittedShare: admitted.length ? admittedBand.length / admitted.length : null,
      thresholdPassShare: thresholdPass.length ? thresholdBand.length / thresholdPass.length : null,
      scoredShare: scored.length ? scoredBand.length / scored.length : null,
      contribution,
      contributionPerTrade: admittedBand.length ? contribution / admittedBand.length : null,
    };
  });

  const totalContribution = byBandRows.reduce((a, b) => a + b.contribution, 0);
  const admittedAvgProxyGlobal = avg(admitted.map((o) => o.proxyMarkout).filter((x): x is number => x != null));

  const overRep = (share: number | null, quality: number | null): string => {
    if (share == null || quality == null || admittedAvgProxyGlobal == null) return "unknown";
    if (share >= 0.15 && quality < admittedAvgProxyGlobal - 0.001) return "yes";
    if (share >= 0.15 && quality >= admittedAvgProxyGlobal - 0.001) return "no";
    return "neutral";
  };

  const bandContributionRows = byBandRows.map((r) => ({
    ...r,
    contributionShare: totalContribution !== 0 ? r.contribution / totalContribution : null,
    overrepresentedVsQuality: overRep(r.admittedShare, r.admittedAvgProxy),
  }));

  const deepBand = "0.1-0.2" as Band;
  const deepAll = observations.filter((o) => o.band === deepBand);
  const deepAdmitted = deepAll.filter((o) => o.admitted);
  const deepRejected = deepAll.filter((o) => o.rejected);
  const deepScore = deepAll.map((o) => o.score).filter((x): x is number => x != null);
  const deepProxy = deepAll.map((o) => o.proxyMarkout).filter((x): x is number => x != null);
  const otherProxy = observations
    .filter((o) => o.band !== deepBand)
    .map((o) => o.proxyMarkout)
    .filter((x): x is number => x != null);
  const deepAvgProxy = avg(deepProxy);
  const otherAvgProxy = avg(otherProxy);
  const deepVerdict =
    deepAll.length < 30
      ? "insufficient_sample"
      : deepAvgProxy != null && otherAvgProxy != null && deepAvgProxy < otherAvgProxy - 0.002
      ? "drag"
      : "not_clear_drag";

  const lines: string[] = [];
  lines.push("# V2 Band Allocation Quality Audit");
  lines.push("");
  lines.push(`- generated: ${generatedAt}`);
  lines.push(`- data source: repeated dry-run V2 ticks (${ticks} ticks, cadence ${cadenceMs}ms) + closed PaperTrade market/band proxy markouts`);
  lines.push(`- sampled candidate observations: ${observations.length}`);
  lines.push("");
  lines.push("## A. Overlay-era admitted performance by band");
  lines.push("| band | count | avg score used | avg proxy markout | median proxy markout | win-rate proxy |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const r of byBandRows) {
    lines.push(
      `| ${r.band} | ${r.admittedCount} | ${fmt(r.admittedAvgScore)} | ${fmt(r.admittedAvgProxy)} | ${fmt(r.admittedMedianProxy)} | ${pct(r.admittedWinRateProxy)} |`
    );
  }
  lines.push("");
  lines.push("## B. Allocation share by band");
  lines.push("| band | admitted share | threshold-pass share | scored share |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const r of byBandRows) {
    lines.push(`| ${r.band} | ${pct(r.admittedShare)} | ${pct(r.thresholdPassShare)} | ${pct(r.scoredShare)} |`);
  }
  lines.push("");
  lines.push("## C. Relative contribution");
  lines.push("| band | contribution to total proxy PnL | contribution per admitted trade | overrepresented vs quality |");
  lines.push("| --- | ---: | ---: | --- |");
  for (const r of bandContributionRows) {
    lines.push(
      `| ${r.band} | ${pct(r.contributionShare)} | ${fmt(r.contributionPerTrade)} | ${r.overrepresentedVsQuality} |`
    );
  }
  lines.push("");
  lines.push("## D. 0.1-0.2 deep dive");
  lines.push(`- admitted count: ${deepAdmitted.length}`);
  lines.push(`- rejected count: ${deepRejected.length}`);
  lines.push(`- avg score: ${fmt(avg(deepScore))}`);
  lines.push(`- avg proxy markout: ${fmt(deepAvgProxy)}`);
  lines.push(`- avg proxy markout (other bands): ${fmt(otherAvgProxy)}`);
  lines.push(
    `- explicit drag verdict: ${
      deepVerdict === "drag"
        ? "0.1-0.2 currently looks like a drag"
        : deepVerdict === "not_clear_drag"
        ? "0.1-0.2 not clearly harmful"
        : "insufficient sample for drag verdict"
    }`
  );
  lines.push("");
  lines.push("## E. Blunt conclusion");
  let conclusion = "evidence insufficient";
  if (deepVerdict === "drag") conclusion = "0.1-0.2 is a clear drag and should be deprioritized";
  else if (deepVerdict === "not_clear_drag" && deepAdmitted.length >= 20) conclusion = "0.1-0.2 is mixed but not clearly harmful";
  else if (deepVerdict === "not_clear_drag" && deepAdmitted.length >= 50 && (deepAvgProxy ?? -1) >= (otherAvgProxy ?? 1) - 0.001) conclusion = "0.1-0.2 is still useful";
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-band-allocation-quality-audit.md");
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

