import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

type TradeRow = {
  id: string;
  status: string;
  createdAt: Date;
  entryPrice: string;
  markout12h: string | null;
  pnlPct: string | null;
  metadataJson: string | null;
};

type OverlayMeta = {
  finalBandAwareScore: number | null;
};

const PRICE_BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).trim());
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
function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}
function pct(n: number | null): string {
  return n == null ? "-" : `${(n * 100).toFixed(2)}%`;
}
function bandOf(entryPrice: string): string {
  const p = parseNum(entryPrice);
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
function outcome(r: Pick<TradeRow, "markout12h" | "pnlPct">): number | null {
  return parseNum(r.markout12h) ?? parseNum(r.pnlPct);
}
function parseOverlayMeta(metadataJson: string | null): OverlayMeta {
  if (!metadataJson) return { finalBandAwareScore: null };
  try {
    const j = JSON.parse(metadataJson) as Record<string, unknown>;
    const sp = j.scoreProvenance as Record<string, unknown> | undefined;
    return {
      finalBandAwareScore: parseNum(sp?.finalBandAwareScore),
    };
  } catch {
    return { finalBandAwareScore: null };
  }
}
function scoreBucket(s: number): string {
  if (s < 0.2) return "[0.0,0.2)";
  if (s < 0.4) return "[0.2,0.4)";
  if (s < 0.6) return "[0.4,0.6)";
  if (s < 0.8) return "[0.6,0.8)";
  return "[0.8,1.0]";
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const v2Rows = (await prisma.paperTrade.findMany({
    where: { dedupeKey: { contains: "|v2|" } },
    select: {
      id: true,
      status: true,
      createdAt: true,
      entryPrice: true,
      markout12h: true,
      pnlPct: true,
      metadataJson: true,
    },
    orderBy: { createdAt: "asc" },
  })) as TradeRow[];

  const withOverlay = v2Rows
    .map((r) => ({ r, om: parseOverlayMeta(r.metadataJson) }))
    .filter((x) => x.om.finalBandAwareScore != null);
  const overlayStart = withOverlay.length ? withOverlay[0]!.r.createdAt : null;

  const overlayRows = v2Rows.filter((r) => {
    const om = parseOverlayMeta(r.metadataJson);
    if (om.finalBandAwareScore != null) return true;
    if (overlayStart != null && r.createdAt >= overlayStart) return true;
    return false;
  });

  const closed = overlayRows.filter((r) => r.status === "closed");
  const outcomes = closed.map(outcome).filter((x): x is number => x != null);
  const winners = outcomes.filter((x) => x > 0).length;

  const byBand = PRICE_BANDS.map((b) => {
    const rows = overlayRows.filter((r) => bandOf(r.entryPrice) === b);
    const c = rows.filter((r) => r.status === "closed");
    const os = c.map(outcome).filter((x): x is number => x != null);
    return {
      band: b,
      openCount: rows.length,
      closedCount: c.length,
      avgMarkout: avg(os),
      medianMarkout: median(os),
      winRate: os.length ? os.filter((x) => x > 0).length / os.length : null,
    };
  });

  const closedWithScore = closed
    .map((r) => ({ r, s: parseOverlayMeta(r.metadataJson).finalBandAwareScore }))
    .filter((x): x is { r: TradeRow; s: number } => x.s != null && Number.isFinite(x.s));
  const byScoreBucketMap = new Map<string, TradeRow[]>();
  for (const x of closedWithScore) {
    const b = scoreBucket(x.s);
    byScoreBucketMap.set(b, [...(byScoreBucketMap.get(b) ?? []), x.r]);
  }
  const byScoreBucket = [...byScoreBucketMap.entries()]
    .map(([bucket, rows]) => {
      const os = rows.map(outcome).filter((x): x is number => x != null);
      return {
        bucket,
        count: rows.length,
        avgMarkout: avg(os),
        medianMarkout: median(os),
        winRate: os.length ? os.filter((x) => x > 0).length / os.length : null,
      };
    })
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  const sorted = [...closedWithScore].sort((a, b) => a.s - b.s);
  const k = Math.max(1, Math.floor(sorted.length * 0.2));
  const low = sorted.slice(0, k).map((x) => x.r);
  const high = sorted.slice(sorted.length - k).map((x) => x.r);
  const stats = (rows: TradeRow[]) => {
    const os = rows.map(outcome).filter((x): x is number => x != null);
    return { n: rows.length, avg: avg(os), winRate: os.length ? os.filter((x) => x > 0).length / os.length : null };
  };
  const topBottom = { low: stats(low), high: stats(high), k };

  const inBand = PRICE_BANDS.map((band) => {
    const rows = closedWithScore.filter((x) => bandOf(x.r.entryPrice) === band);
    if (rows.length < 6) return { band, count: rows.length, note: "insufficient_sample" as const };
    const s = [...rows].sort((a, b) => a.s - b.s);
    const hk = Math.max(1, Math.floor(s.length / 2));
    const lo = s.slice(0, hk).map((x) => x.r);
    const hi = s.slice(s.length - hk).map((x) => x.r);
    const hiO = hi.map(outcome).filter((x): x is number => x != null);
    const loO = lo.map(outcome).filter((x): x is number => x != null);
    return {
      band,
      count: rows.length,
      highHalfAvgMarkout: avg(hiO),
      lowHalfAvgMarkout: avg(loO),
      highHalfWinRate: hiO.length ? hiO.filter((x) => x > 0).length / hiO.length : null,
      lowHalfWinRate: loO.length ? loO.filter((x) => x > 0).length / loO.length : null,
    };
  });

  // Trade flow (only latest tick available in current schema).
  const state = await prisma.paperTradingState.findUnique({
    where: { id: "default" },
    select: { lastOpenTickAt: true, lastOpenTickResultJson: true },
  });
  let tickFlow: Record<string, number | null | string> = {
    latestTickAt: state?.lastOpenTickAt?.toISOString() ?? null,
    candidatesLoaded: null,
    candidatesScored: null,
    tradesOpened: null,
    admissionRateOpenedOverScored: null,
    note: "Only latest tick is persisted (no historical tick table).",
  };
  if (state?.lastOpenTickResultJson) {
    try {
      const j = JSON.parse(state.lastOpenTickResultJson) as Record<string, unknown>;
      const loaded = parseNum(j.candidatesLoaded as string | number | null | undefined);
      const scored = parseNum(j.candidatesScored as string | number | null | undefined);
      const opened = parseNum((j.tradesOpened ?? j.opened) as string | number | null | undefined);
      tickFlow = {
        latestTickAt: state.lastOpenTickAt?.toISOString() ?? null,
        candidatesLoaded: loaded,
        candidatesScored: scored,
        tradesOpened: opened,
        admissionRateOpenedOverScored:
          opened != null && scored != null && scored > 0 ? opened / scored : null,
        note: "Only latest tick is persisted (no historical tick table).",
      };
    } catch {
      // keep defaults
    }
  }

  const lines: string[] = [];
  lines.push("# V2 Overlay-Only Performance");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Overlay start detection: first trade with metadataJson.scoreProvenance.finalBandAwareScore`);
  lines.push(`- Overlay start time: ${overlayStart ? overlayStart.toISOString() : "not_found"}`);
  lines.push(`- Cohort rule: include only trades with finalBandAwareScore present OR createdAt >= overlayStart`);
  lines.push("");
  lines.push("## A. Cohort summary");
  lines.push(`- total opens: ${overlayRows.length}`);
  lines.push(`- total closed: ${closed.length}`);
  lines.push(`- avg markout: ${fmt(avg(outcomes))}`);
  lines.push(`- median markout: ${fmt(median(outcomes))}`);
  lines.push(`- win rate: ${pct(outcomes.length ? winners / outcomes.length : null)}`);
  lines.push("");
  lines.push("## B. Performance by price band");
  lines.push("| band | open count | closed count | avg markout | median markout | win rate |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const r of byBand) {
    lines.push(`| ${r.band} | ${r.openCount} | ${r.closedCount} | ${fmt(r.avgMarkout)} | ${fmt(r.medianMarkout)} | ${pct(r.winRate)} |`);
  }
  lines.push("");
  lines.push("## C. Score bucket performance (finalBandAwareScore)");
  lines.push("| score bucket | count | avg markout | median markout | win rate |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const r of byScoreBucket) {
    lines.push(`| ${r.bucket} | ${r.count} | ${fmt(r.avgMarkout)} | ${fmt(r.medianMarkout)} | ${pct(r.winRate)} |`);
  }
  lines.push("");
  lines.push("## D. Top-vs-bottom comparison");
  lines.push(
    `- tails: ${topBottom.k} each; high avg markout=${fmt(topBottom.high.avg)}, low avg markout=${fmt(topBottom.low.avg)}, high win rate=${pct(topBottom.high.winRate)}, low win rate=${pct(topBottom.low.winRate)}`
  );
  lines.push("");
  lines.push("## E. In-band ranking check");
  lines.push("| band | count | high-half avg markout | low-half avg markout | high-half win rate | low-half win rate | note |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const r of inBand) {
    lines.push(
      `| ${r.band} | ${r.count} | ${"highHalfAvgMarkout" in r ? fmt(r.highHalfAvgMarkout ?? null) : "-"} | ${"lowHalfAvgMarkout" in r ? fmt(r.lowHalfAvgMarkout ?? null) : "-"} | ${"highHalfWinRate" in r ? pct(r.highHalfWinRate ?? null) : "-"} | ${"lowHalfWinRate" in r ? pct(r.lowHalfWinRate ?? null) : "-"} | ${"note" in r ? r.note : ""} |`
    );
  }
  lines.push("");
  lines.push("## F. Trade flow (available fields)");
  lines.push(`- latest tick at: ${String(tickFlow.latestTickAt)}`);
  lines.push(`- candidates loaded: ${String(tickFlow.candidatesLoaded)}`);
  lines.push(`- candidates scored: ${String(tickFlow.candidatesScored)}`);
  lines.push(`- trades opened: ${String(tickFlow.tradesOpened)}`);
  lines.push(`- admission rate (opened/scored): ${tickFlow.admissionRateOpenedOverScored == null ? "-" : pct(tickFlow.admissionRateOpenedOverScored as number)}`);
  lines.push(`- note: ${String(tickFlow.note)}`);
  lines.push("");
  lines.push("## Sample size note");
  lines.push(
    overlayRows.length < 30 || closed.length < 20
      ? `- Small sample (opens=${overlayRows.length}, closed=${closed.length}); not statistically meaningful yet.`
      : `- Sample size is moderate (opens=${overlayRows.length}, closed=${closed.length}); still treat as early evidence.`
  );
  lines.push("- Pre-overlay trades are excluded by cohort rule above.");

  const outDir = path.join(process.cwd(), "diagnostics");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "v2-overlay-only-performance.md");
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
