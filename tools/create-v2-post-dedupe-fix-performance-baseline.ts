import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

type Band = "<0.1" | "0.1-0.2" | "0.2-0.3" | "0.3-0.4" | "0.4-0.6" | "0.6-0.8" | "0.8-0.9" | ">=0.9";
const BANDS: Band[] = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"];

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
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
function winRate(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.filter((x) => x > 0).length / nums.length;
}
function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}
function pct(n: number | null): string {
  return n == null ? "-" : `${(n * 100).toFixed(2)}%`;
}
function classifyBand(entryPrice: string | null, fallbackBand: string | null): Band | null {
  const fb = (fallbackBand ?? "").trim();
  if (BANDS.includes(fb as Band)) return fb as Band;
  const p = parseNum(entryPrice);
  if (p == null) return null;
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
  let regimeStart: Date | null = null;
  let regimeRule = "";
  const explicitStartRaw = process.env.PAPER_POST_DEDUPE_FIX_START?.trim();
  if (explicitStartRaw) {
    const d = new Date(explicitStartRaw);
    if (!Number.isNaN(d.getTime())) {
      regimeStart = d;
      regimeRule = "explicit deployment/fix start timestamp via env:PAPER_POST_DEDUPE_FIX_START";
    }
  }
  if (!regimeStart) {
    try {
      const st = await fs.stat(path.join(process.cwd(), "lib", "paper-trading", "engine_v2_minimal.ts"));
      regimeStart = st.mtime;
      regimeRule = "engine file mtime fallback (lib/paper-trading/engine_v2_minimal.ts)";
    } catch {
      regimeStart = null;
      regimeRule = "no explicit fix timestamp and no reliable fallback";
    }
  }

  const explicitCandidateRaw = process.env.PAPER_POST_DEDUPE_FIX_START?.trim() || null;
  const explicitCandidate = explicitCandidateRaw ? new Date(explicitCandidateRaw) : null;
  const explicitCandidateValid =
    explicitCandidate != null && !Number.isNaN(explicitCandidate.getTime());

  const allV2 = await prisma.paperTrade.findMany({
    where: { dedupeKey: { contains: "|v2|" } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      createdAt: true,
      entryTime: true,
      status: true,
      score: true,
      entryPrice: true,
      entryPriceBand: true,
      markout12h: true,
      dedupeKey: true,
      metadataJson: true,
    },
  });

  const nearestAfterExplicit = explicitCandidateValid
    ? allV2.find((t) => t.createdAt >= (explicitCandidate as Date)) ?? null
    : null;
  const allWithScoreProv = allV2.filter((t) =>
    (t as any).metadataJson ? String((t as any).metadataJson).includes('"scoreProvenance"') : false
  ).length;
  const allAfterExplicit = explicitCandidateValid
    ? allV2.filter((t) => t.createdAt >= (explicitCandidate as Date))
    : [];
  const afterExplicitWithScoreProv = allAfterExplicit.filter((t) =>
    (t as any).metadataJson ? String((t as any).metadataJson).includes('"scoreProvenance"') : false
  ).length;

  const closedV2 = allV2.filter((t) => t.status === "closed");
  const marketProxyByBand = new Map<Band, number[]>();
  for (const t of closedV2) {
    const band = classifyBand(t.entryPrice, t.entryPriceBand);
    const m = parseNum(t.markout12h);
    if (!band || m == null) continue;
    const arr = marketProxyByBand.get(band) ?? [];
    arr.push(m);
    marketProxyByBand.set(band, arr);
  }
  const bandProxyMean = new Map<Band, number>();
  for (const b of BANDS) {
    const a = marketProxyByBand.get(b) ?? [];
    if (a.length) bandProxyMean.set(b, avg(a)!);
  }

  const postFix = regimeStart ? allV2.filter((t) => t.createdAt >= regimeStart!) : [];
  const postFixOpenCount = postFix.length;
  const postFixClosed = postFix.filter((t) => t.status === "closed");

  const preFixPool = regimeStart ? allV2.filter((t) => t.createdAt < regimeStart) : [];
  const preFixSizeMatched = preFixPool.slice(Math.max(0, preFixPool.length - postFixOpenCount));
  const preFixClosed = preFixSizeMatched.filter((t) => t.status === "closed");

  const outcome = (t: (typeof allV2)[number]): number | null => {
    const m = parseNum(t.markout12h);
    if (m != null) return m;
    const b = classifyBand(t.entryPrice, t.entryPriceBand);
    if (!b) return null;
    return bandProxyMean.get(b) ?? null;
  };

  const byBand = BANDS.map((b) => {
    const rows = postFix.filter((t) => classifyBand(t.entryPrice, t.entryPriceBand) === b);
    const scores = rows.map((r) => r.score).filter((x): x is number => x != null);
    const outs = rows.map(outcome).filter((x): x is number => x != null);
    return {
      band: b,
      count: rows.length,
      avgScore: avg(scores),
      avgOutcome: avg(outs),
      medOutcome: median(outs),
      win: winRate(outs),
      closed: rows.filter((r) => r.status === "closed").length,
    };
  });

  const totalOutcome = postFix.map(outcome).filter((x): x is number => x != null).reduce((a, b) => a + b, 0);
  const contributionRows = BANDS.map((b) => {
    const rows = postFix.filter((t) => classifyBand(t.entryPrice, t.entryPriceBand) === b);
    const outs = rows.map(outcome).filter((x): x is number => x != null);
    const sum = outs.reduce((a, c) => a + c, 0);
    return {
      band: b,
      openShare: postFix.length ? rows.length / postFix.length : null,
      closedShare: postFixClosed.length ? rows.filter((r) => r.status === "closed").length / postFixClosed.length : null,
      pnlShare: totalOutcome !== 0 ? sum / totalOutcome : null,
    };
  });

  // admitted per tick proxy from entryTime buckets
  const opensPerMinute = new Map<string, number>();
  for (const t of postFix) {
    const key = new Date(t.entryTime).toISOString().slice(0, 16);
    opensPerMinute.set(key, (opensPerMinute.get(key) ?? 0) + 1);
  }
  const opensPerMinuteVals = [...opensPerMinute.values()];

  const postOuts = postFix.map(outcome).filter((x): x is number => x != null);
  const preOuts = preFixSizeMatched.map(outcome).filter((x): x is number => x != null);

  const lines: string[] = [];
  lines.push("# V2 Post-Dedupe-Fix Performance Baseline");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push("");
  lines.push("## A. Regime definition");
  lines.push(`- start point: ${regimeStart ? regimeStart.toISOString() : "not detected"}`);
  lines.push(`- detection rule: ${regimeRule}`);
  lines.push(
    `- reliability note: ${
      explicitStartRaw
        ? "high (explicit timestamp)"
        : regimeStart
        ? "medium (code deployment-time proxy)"
        : "low (no reliable persisted anchor)"
    }`
  );
  if (explicitCandidateRaw) {
    lines.push(
      `- explicit candidate start supplied: ${explicitCandidateRaw} (${explicitCandidateValid ? "valid" : "invalid"})`
    );
  }
  lines.push("");
  lines.push("## B. Flow summary");
  lines.push(`- opens (post-fix): ${postFix.length}`);
  lines.push(`- closed (post-fix): ${postFixClosed.length}`);
  lines.push(`- close rate: ${pct(postFix.length ? postFixClosed.length / postFix.length : null)}`);
  lines.push(`- admitted per tick proxy (per-minute opens) avg/median/max: ${fmt(avg(opensPerMinuteVals), 3)} / ${fmt(median(opensPerMinuteVals), 3)} / ${fmt(opensPerMinuteVals.length ? Math.max(...opensPerMinuteVals) : null, 3)}`);
  lines.push(`- sample size note: ${postFix.length < 30 ? "small sample; interpret cautiously" : "sample size moderate"}`);
  lines.push("");
  lines.push("## C. Performance by band (post-fix opens)");
  lines.push("| band | count | avg score used | avg markout/proxy | median | win rate |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const r of byBand) {
    lines.push(`| ${r.band} | ${r.count} | ${fmt(r.avgScore)} | ${fmt(r.avgOutcome)} | ${fmt(r.medOutcome)} | ${pct(r.win)} |`);
  }
  lines.push("");
  lines.push("## D. Contribution by band");
  lines.push("| band | share of opens | share of closed | share of markout/proxy PnL |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const r of contributionRows) {
    lines.push(`| ${r.band} | ${pct(r.openShare)} | ${pct(r.closedShare)} | ${pct(r.pnlShare)} |`);
  }
  lines.push("");
  lines.push("## E. Size-matched immediate pre-fix comparison");
  lines.push(`- pre-fix window size-matched opens: ${preFixSizeMatched.length}`);
  lines.push(`- pre-fix closed: ${preFixClosed.length}`);
  lines.push(`- pre-fix close rate: ${pct(preFixSizeMatched.length ? preFixClosed.length / preFixSizeMatched.length : null)}`);
  lines.push(`- pre-fix avg markout/proxy: ${fmt(avg(preOuts))}`);
  lines.push(`- post-fix avg markout/proxy: ${fmt(avg(postOuts))}`);
  lines.push(`- delta post-minus-pre: ${fmt((avg(postOuts) ?? 0) - (avg(preOuts) ?? 0))}`);
  if (postFix.length === 0) {
    lines.push("");
    lines.push("## E2. Empty-cohort diagnostics (temporary)");
    if (explicitCandidateValid) {
      lines.push("- 30-minute buckets around supplied start (V2 row counts):");
      const startMs = (explicitCandidate as Date).getTime();
      for (let i = -4; i <= 4; i++) {
        const bStart = new Date(startMs + i * 30 * 60 * 1000);
        const bEnd = new Date(bStart.getTime() + 30 * 60 * 1000);
        const c = allV2.filter((t) => t.createdAt >= bStart && t.createdAt < bEnd).length;
        lines.push(`  - ${bStart.toISOString()} to ${bEnd.toISOString()}: ${c}`);
      }
      lines.push(
        `- earliest row after supplied start: ${nearestAfterExplicit ? nearestAfterExplicit.createdAt.toISOString() : "none"}`
      );
      lines.push(
        `- latest row after supplied start: ${allAfterExplicit.length ? allAfterExplicit[allAfterExplicit.length - 1]!.createdAt.toISOString() : "none"}`
      );
      lines.push(`- rows with metadataJson.scoreProvenance after supplied start: ${afterExplicitWithScoreProv}`);
    } else {
      lines.push("- no valid explicit supplied timestamp; cannot compute around-start buckets.");
    }
    lines.push(`- rows with metadataJson.scoreProvenance across all V2 rows: ${allWithScoreProv}`);
  }
  lines.push("");
  lines.push("## F. Blunt conclusion");
  let conclusion = "evidence insufficient";
  if (postFix.length >= 10 && postFix.length > preFixSizeMatched.length * 0.8) {
    if ((avg(postOuts) ?? 0) >= (avg(preOuts) ?? 0) - 0.001) {
      conclusion = "dedupe fix successfully restored usable flow and preserved quality";
    } else {
      conclusion = "dedupe fix restored flow but quality deteriorated";
    }
  } else if (postFix.length >= 5) {
    conclusion = "dedupe fix restored flow but quality is unclear";
  }
  lines.push(`- ${conclusion}`);

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-post-dedupe-fix-performance-baseline.md");
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

