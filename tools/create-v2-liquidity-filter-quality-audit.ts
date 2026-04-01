import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";
import { getPaperTradingConfig } from "../lib/paper-trading/config";

type SampleRow = {
  recommendationId: string;
  candidateId: string | null;
  marketId: string | null;
  band: string | null;
  scoreUsed: number | null;
  rejectReason: string | null;
  admitted: boolean;
  spreadBps: number | null;
  slippageBps: number | null;
  proxyOutcome: number | null;
  proxySource: "shadow_candidate" | "paper_market_proxy" | "paper_band_proxy" | null;
};

const BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function pct(n: number | null): string {
  return n == null ? "-" : `${(n * 100).toFixed(2)}%`;
}
function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}
function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function parseExecutionQuality(raw: string | null | undefined): { spreadBps: number | null; slippageBps: number | null } {
  if (!raw) return { spreadBps: null, slippageBps: null };
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      spreadBps: parseNum(j.spreadBps),
      slippageBps: parseNum(j.estimatedSlippageBps),
    };
  } catch {
    return { spreadBps: null, slippageBps: null };
  }
}
function winRate(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.filter((x) => x > 0).length / nums.length;
}

async function main(): Promise<void> {
  const cfg = getPaperTradingConfig();
  const ticks = Math.max(1, parseInt(process.env.PAPER_LIQ_AUDIT_TICKS ?? "12", 10));
  const cadenceMs = Math.max(0, parseInt(process.env.PAPER_LIQ_AUDIT_CADENCE_MS ?? "500", 10));
  const generatedAt = new Date().toISOString();

  const sampled: SampleRow[] = [];
  for (let i = 0; i < ticks; i++) {
    const tick = await runPaperTradingTickV2({ dryRun: true });
    const byRec = new Map<string, { candidateId: string | null; band: string | null; score: number | null }>();
    for (const p of tick.scoreProvenanceSample ?? []) {
      byRec.set(p.recommendationId, {
        candidateId: null,
        band: p.shadowBand ?? null,
        score: p.actualScoreUsedForOrdering ?? null,
      });
    }
    for (const t of tick.trace) {
      const m = byRec.get(t.recommendationId) ?? { candidateId: null, band: null, score: t.score };
      m.candidateId = t.candidateId ?? m.candidateId;
      if (m.score == null) m.score = t.score;
      byRec.set(t.recommendationId, m);
      const row: SampleRow = {
        recommendationId: t.recommendationId,
        candidateId: m.candidateId,
        marketId: null,
        band: m.band,
        scoreUsed: m.score,
        rejectReason: t.rejectReason ?? null,
        admitted: t.admitted,
        spreadBps: null,
        slippageBps: null,
        proxyOutcome: null,
        proxySource: null,
      };
      sampled.push(row);
    }
    if (i < ticks - 1 && cadenceMs > 0) {
      await new Promise((r) => setTimeout(r, cadenceMs));
    }
  }

  const candidateIds = [...new Set(sampled.map((r) => r.candidateId).filter((x): x is string => !!x))];
  const shadowRows = candidateIds.length
    ? await prisma.shadowCandidate.findMany({
        where: { id: { in: candidateIds } },
        select: {
          id: true,
          marketId: true,
          executionQualitySnapshotJson: true,
          markout1h: true,
          markout6h: true,
          markout24h: true,
        },
      })
    : [];
  const shadowById = new Map(shadowRows.map((r) => [r.id, r]));
  for (const r of sampled) {
    if (!r.candidateId) continue;
    const s = shadowById.get(r.candidateId);
    if (!s) continue;
    const eq = parseExecutionQuality(s.executionQualitySnapshotJson);
    r.spreadBps = eq.spreadBps;
    r.slippageBps = eq.slippageBps;
    r.marketId = s.marketId ?? null;
    r.proxyOutcome = parseNum(s.markout6h) ?? parseNum(s.markout24h) ?? parseNum(s.markout1h);
    if (r.proxyOutcome != null) r.proxySource = "shadow_candidate";
  }

  const closedTrades = await prisma.paperTrade.findMany({
    where: {
      status: "closed",
      markout12h: { not: null },
    },
    select: {
      marketId: true,
      entryPriceBand: true,
      markout12h: true,
      metadataJson: true,
    },
    take: 20000,
    orderBy: { createdAt: "desc" },
  });
  const marketMarkoutMap = new Map<string, number[]>();
  const bandMarkoutMap = new Map<string, number[]>();
  const overlayClosed: number[] = [];
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
    try {
      const meta = t.metadataJson ? (JSON.parse(t.metadataJson) as Record<string, unknown>) : null;
      const sp = meta?.scoreProvenance as Record<string, unknown> | undefined;
      if (sp && typeof sp.finalBandAwareScore === "number") overlayClosed.push(m);
    } catch {
      // ignore malformed metadataJson
    }
  }
  for (const r of sampled) {
    if (r.proxyOutcome != null) continue;
    if (r.marketId) {
      const mm = marketMarkoutMap.get(r.marketId);
      if (mm?.length) {
        r.proxyOutcome = avg(mm);
        r.proxySource = "paper_market_proxy";
        continue;
      }
    }
    if (r.band) {
      const bm = bandMarkoutMap.get(r.band);
      if (bm?.length) {
        r.proxyOutcome = avg(bm);
        r.proxySource = "paper_band_proxy";
      }
    }
  }

  const admittedRows = sampled.filter((r) => r.admitted);
  const admittedScores = admittedRows.map((r) => r.scoreUsed).filter((x): x is number => x != null);
  const admittedProxy = admittedRows.map((r) => r.proxyOutcome).filter((x): x is number => x != null);

  const spreadRejected = sampled.filter((r) => r.rejectReason === "liquidity_spread");
  const slipRejected = sampled.filter((r) => r.rejectReason === "liquidity_slippage");
  const liqRejected = sampled.filter((r) => r.rejectReason === "liquidity_spread" || r.rejectReason === "liquidity_slippage");
  const liqProxy = liqRejected.map((r) => r.proxyOutcome).filter((x): x is number => x != null);
  const proxyCoverage = {
    admitted: admittedRows.filter((r) => r.proxyOutcome != null).length,
    filtered: liqRejected.filter((r) => r.proxyOutcome != null).length,
  };
  const proxySourceCounts = sampled.reduce<Record<string, number>>((acc, r) => {
    const k = r.proxySource ?? "none";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  const bandBreakdown = BANDS.map((band) => {
    const bandAdmitted = admittedRows.filter((r) => r.band === band);
    const bandFiltered = liqRejected.filter((r) => r.band === band);
    const bandAdmittedProxy = bandAdmitted.map((r) => r.proxyOutcome).filter((x): x is number => x != null);
    return {
      band,
      filtered: bandFiltered.length,
      admitted: bandAdmitted.length,
      admittedAvgProxy: avg(bandAdmittedProxy),
      admittedWinRateProxy: winRate(bandAdmittedProxy),
    };
  });

  const allSpreads = sampled.map((r) => r.spreadBps).filter((x): x is number => x != null);
  const allSlips = sampled.map((r) => r.slippageBps).filter((x): x is number => x != null);
  const spreadCut = cfg.paperMaxSpreadBps;
  const slipCut = cfg.paperMaxEstimatedSlippageBps;

  const nearSpread = spreadRejected.filter((r) => {
    if (r.spreadBps == null) return false;
    return r.spreadBps > spreadCut && r.spreadBps <= spreadCut * 1.2;
  });
  const nearSlip = slipRejected.filter((r) => {
    if (slipCut == null || r.slippageBps == null) return false;
    return r.slippageBps > slipCut && r.slippageBps <= slipCut * 1.2;
  });
  const nearSpreadProxy = nearSpread.map((r) => r.proxyOutcome).filter((x): x is number => x != null);
  const nearSlipProxy = nearSlip.map((r) => r.proxyOutcome).filter((x): x is number => x != null);

  const lines: string[] = [];
  lines.push("# V2 Liquidity Filter Quality Audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Data source: repeated dry-run sampling (${ticks} ticks, cadence ${cadenceMs}ms), plus ShadowCandidate execution-quality/markout proxies`);
  lines.push(`- Liquidity thresholds: spread <= ${spreadCut} bps, slippage <= ${slipCut == null ? "off" : `${slipCut} bps`}`);
  lines.push("");
  lines.push("## A. Admitted trades performance (sampled)");
  lines.push(`- count (trace admissions): ${admittedRows.length}`);
  lines.push(`- avg score used: ${fmt(avg(admittedScores))}`);
  lines.push(`- avg proxy markout: ${fmt(avg(admittedProxy))}`);
  lines.push(`- median proxy markout: ${fmt(median(admittedProxy))}`);
  lines.push(`- win rate proxy: ${pct(winRate(admittedProxy))}`);
  lines.push(`- proxy coverage (admitted): ${proxyCoverage.admitted} / ${admittedRows.length}`);
  lines.push(`- real closed overlay-era trades: ${overlayClosed.length}`);
  if (overlayClosed.length) {
    lines.push(`- real overlay avg markout12h: ${fmt(avg(overlayClosed))}`);
    lines.push(`- real overlay median markout12h: ${fmt(median(overlayClosed))}`);
    lines.push(`- real overlay win rate: ${pct(winRate(overlayClosed))}`);
  }
  lines.push("");
  lines.push("## B. Filtered candidates proxy analysis");
  lines.push(`- liquidity_spread rejects: ${spreadRejected.length}`);
  lines.push(`- liquidity_slippage rejects: ${slipRejected.length}`);
  lines.push(`- combined liquidity rejects: ${liqRejected.length}`);
  lines.push(`- combined avg proxy markout: ${fmt(avg(liqProxy))}`);
  lines.push(`- combined median proxy markout: ${fmt(median(liqProxy))}`);
  lines.push(`- combined win rate proxy: ${pct(winRate(liqProxy))}`);
  lines.push(
    `- admitted-vs-filtered proxy delta (avg markout): ${fmt((avg(admittedProxy) ?? 0) - (avg(liqProxy) ?? 0))}`
  );
  lines.push(`- proxy coverage (filtered): ${proxyCoverage.filtered} / ${liqRejected.length}`);
  lines.push(`- proxy source counts: ${Object.entries(proxySourceCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push("");
  lines.push("## C. Band-level breakdown");
  lines.push("| band | filtered(liquidity) | admitted | admitted avg proxy markout | admitted proxy win rate |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const b of bandBreakdown) {
    lines.push(
      `| ${b.band} | ${b.filtered} | ${b.admitted} | ${fmt(b.admittedAvgProxy)} | ${pct(b.admittedWinRateProxy)} |`
    );
  }
  lines.push("");
  lines.push("## D. Spread/slippage distribution");
  const spreadSorted = [...allSpreads].sort((a, b) => a - b);
  const slipSorted = [...allSlips].sort((a, b) => a - b);
  const q = (arr: number[], p: number): number | null => {
    if (!arr.length) return null;
    const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * p)));
    return arr[idx] ?? null;
  };
  lines.push(
    `- spread bps min/p25/median/p75/max: ${fmt(q(spreadSorted, 0))}/${fmt(q(spreadSorted, 0.25))}/${fmt(
      q(spreadSorted, 0.5)
    )}/${fmt(q(spreadSorted, 0.75))}/${fmt(q(spreadSorted, 1))}`
  );
  lines.push(
    `- slippage bps min/p25/median/p75/max: ${fmt(q(slipSorted, 0))}/${fmt(q(slipSorted, 0.25))}/${fmt(
      q(slipSorted, 0.5)
    )}/${fmt(q(slipSorted, 0.75))}/${fmt(q(slipSorted, 1))}`
  );
  lines.push(`- spread cutoff percentile location (approx): ${allSpreads.length ? pct(allSpreads.filter((x) => x <= spreadCut).length / allSpreads.length) : "-"}`);
  if (slipCut != null) {
    lines.push(`- slippage cutoff percentile location (approx): ${allSlips.length ? pct(allSlips.filter((x) => x <= slipCut).length / allSlips.length) : "-"}`);
  }
  lines.push(
    `- near-miss spread rejects (within +20% cutoff): ${nearSpread.length} / ${spreadRejected.length}`
  );
  if (slipCut != null) {
    lines.push(
      `- near-miss slippage rejects (within +20% cutoff): ${nearSlip.length} / ${slipRejected.length}`
    );
  }
  lines.push("");
  lines.push("## E. Near-threshold analysis");
  lines.push(`- near-spread avg proxy markout: ${fmt(avg(nearSpreadProxy))}`);
  lines.push(`- near-spread win rate proxy: ${pct(winRate(nearSpreadProxy))}`);
  if (slipCut != null) {
    lines.push(`- near-slippage avg proxy markout: ${fmt(avg(nearSlipProxy))}`);
    lines.push(`- near-slippage win rate proxy: ${pct(winRate(nearSlipProxy))}`);
  }
  lines.push(
    `- near-miss vs admitted avg proxy delta: ${fmt((avg(nearSpreadProxy.concat(nearSlipProxy)) ?? 0) - (avg(admittedProxy) ?? 0))}`
  );
  lines.push("");
  lines.push("## F. Blunt conclusion");
  const conclusion = (() => {
    if (admittedProxy.length < 15 || liqProxy.length < 15) return "evidence insufficient";
    const delta = (avg(admittedProxy) ?? 0) - (avg(liqProxy) ?? 0);
    const nearDelta = (avg(admittedProxy) ?? 0) - (avg(nearSpreadProxy.concat(nearSlipProxy)) ?? 0);
    if (delta > 0.003 && nearDelta > 0.001) return "filters correctly remove bad trades";
    if (delta > 0 && nearDelta <= 0.001) return "filters slightly too strict (high-value near misses)";
    if (delta <= 0) return "filters too strict (blocking edge)";
    return "evidence insufficient";
  })();
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-liquidity-filter-quality-audit.md");
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

