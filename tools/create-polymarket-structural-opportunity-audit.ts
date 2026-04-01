import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { ClobClient, Side, type OrderBookSummary } from "@polymarket/clob-client";
import { getClobChainId, getClobHost } from "../lib/polymarket/client";

type LiveTop = {
  bestAsk: number | null;
  askSize: number | null;
  timestamp: string | null;
};

type LivePair = {
  marketId: string;
  title: string;
  category: string | null;
  yesAssetId: string;
  noAssetId: string;
  yes: LiveTop;
  no: LiveTop;
};

type FullSetOpportunity = {
  marketId: string;
  title: string;
  category: string | null;
  yesAssetId: string;
  noAssetId: string;
  yesPrice: number;
  noPrice: number;
  grossEdge: number;
  netEdge: number;
  yesSize: number | null;
  noSize: number | null;
  pairCapacitySize: number | null;
  pairCapacityNotional: number | null;
  likelyThinNoise: boolean;
};

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function fmt(n: number | null, digits = 6): string {
  return n == null ? "-" : n.toFixed(digits);
}

function pct(n: number | null): string {
  return n == null ? "-" : `${(n * 100).toFixed(2)}%`;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function isYesLabel(outcome: string): boolean {
  const t = outcome.trim().toLowerCase();
  return t === "yes" || t === "y";
}

function isNoLabel(outcome: string): boolean {
  const t = outcome.trim().toLowerCase();
  return t === "no" || t === "n";
}

function minNonNull(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function feeRateFromEnv(): { feeRate: number; source: string } {
  const candidates = [
    process.env.POLYMARKET_TAKER_FEE_RATE,
    process.env.POLYMARKET_FEE_RATE,
    process.env.CLOB_TAKER_FEE_RATE,
    process.env.STRUCTURAL_AUDIT_FEE_RATE,
  ];
  for (const raw of candidates) {
    const n = parseNum(raw);
    if (n != null && n >= 0) return { feeRate: n, source: "env_fee_rate" };
  }
  const bpsCandidates = [
    process.env.POLYMARKET_TAKER_FEE_BPS,
    process.env.POLYMARKET_FEE_BPS,
    process.env.CLOB_TAKER_FEE_BPS,
    process.env.STRUCTURAL_AUDIT_FEE_BPS,
  ];
  for (const raw of bpsCandidates) {
    const bps = parseNum(raw);
    if (bps != null && bps >= 0) return { feeRate: bps / 10_000, source: "env_fee_bps" };
  }
  return { feeRate: 0, source: "missing_config_assumed_zero" };
}

function topAskFromBook(book: OrderBookSummary | null | undefined): LiveTop {
  if (!book) return { bestAsk: null, askSize: null, timestamp: null };
  const ask0 = Array.isArray(book.asks) && book.asks.length > 0 ? book.asks[0] : null;
  return {
    bestAsk: parseNum(ask0?.price),
    askSize: parseNum(ask0?.size),
    timestamp: typeof book.timestamp === "string" ? book.timestamp : null,
  };
}

async function fetchBooksForPairs(
  client: ClobClient,
  pairs: Array<{ marketId: string; yesAssetId: string; noAssetId: string }>
): Promise<Map<string, { yes: OrderBookSummary | null; no: OrderBookSummary | null }>> {
  const out = new Map<string, { yes: OrderBookSummary | null; no: OrderBookSummary | null }>();
  const chunkMarkets = Math.max(1, Number.parseInt(process.env.STRUCTURAL_AUDIT_BOOK_CHUNK_MARKETS ?? "40", 10));
  for (let i = 0; i < pairs.length; i += chunkMarkets) {
    const chunk = pairs.slice(i, i + chunkMarkets);
    const params = chunk.flatMap((p) => [
      { token_id: p.yesAssetId, side: Side.BUY },
      { token_id: p.noAssetId, side: Side.BUY },
    ]);
    let books: OrderBookSummary[] = [];
    try {
      books = (await client.getOrderBooks(params)) as OrderBookSummary[];
    } catch {
      books = [];
    }
    const byAsset = new Map<string, OrderBookSummary>();
    for (const b of books) {
      if (b?.asset_id) byAsset.set(String(b.asset_id), b);
    }
    for (const p of chunk) {
      out.set(p.marketId, {
        yes: byAsset.get(p.yesAssetId) ?? null,
        no: byAsset.get(p.noAssetId) ?? null,
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const thinCapacityNotionalCutoff = parseNum(process.env.STRUCTURAL_AUDIT_THIN_NOTIONAL_CUTOFF) ?? 25;
  const feeModel = feeRateFromEnv();

  const markets = await prisma.syncedMarket.findMany({
    where: { status: { not: "closed" } },
    select: {
      id: true,
      title: true,
      category: true,
      assets: { select: { tokenId: true, outcome: true } },
    },
    take: 5000,
  });

  const binaryMarketMeta = new Map<string, { title: string; category: string | null; yesAssetId: string; noAssetId: string }>();
  for (const m of markets) {
    const yes = m.assets.find((a) => isYesLabel(a.outcome));
    const no = m.assets.find((a) => isNoLabel(a.outcome));
    if (!yes || !no) continue;
    binaryMarketMeta.set(m.id, {
      title: m.title,
      category: m.category ?? null,
      yesAssetId: yes.tokenId,
      noAssetId: no.tokenId,
    });
  }

  const clob = new ClobClient(getClobHost(), getClobChainId());
  const metaPairs = [...binaryMarketMeta.entries()].map(([marketId, m]) => ({
    marketId,
    yesAssetId: m.yesAssetId,
    noAssetId: m.noAssetId,
  }));
  const booksByMarket = await fetchBooksForPairs(clob, metaPairs);

  const livePairs: LivePair[] = [];
  for (const [marketId, meta] of binaryMarketMeta.entries()) {
    const marketBooks = booksByMarket.get(marketId);
    if (!marketBooks) continue;
    const yes = topAskFromBook(marketBooks.yes);
    const no = topAskFromBook(marketBooks.no);
    livePairs.push({
      marketId,
      title: meta.title,
      category: meta.category,
      yesAssetId: meta.yesAssetId,
      noAssetId: meta.noAssetId,
      yes,
      no,
    });
  }

  const fullSetOps: FullSetOpportunity[] = [];
  let bothLegsPresentCount = 0;
  for (const p of livePairs) {
    if (p.yes.bestAsk == null || p.no.bestAsk == null) continue;
    bothLegsPresentCount++;
    const grossEdge = 1 - (p.yes.bestAsk + p.no.bestAsk);
    const feeCost = feeModel.feeRate * (p.yes.bestAsk + p.no.bestAsk);
    const netEdge = grossEdge - feeCost;
    if (grossEdge <= 0) continue;
    const sizeCap = minNonNull(p.yes.askSize, p.no.askSize);
    const pairNotional = sizeCap != null ? sizeCap * (p.yes.bestAsk + p.no.bestAsk) : null;
    fullSetOps.push({
      marketId: p.marketId,
      title: p.title,
      category: p.category,
      yesAssetId: p.yesAssetId,
      noAssetId: p.noAssetId,
      yesPrice: p.yes.bestAsk,
      noPrice: p.no.bestAsk,
      grossEdge,
      netEdge,
      yesSize: p.yes.askSize,
      noSize: p.no.askSize,
      pairCapacitySize: sizeCap,
      pairCapacityNotional: pairNotional,
      likelyThinNoise: pairNotional != null ? pairNotional < thinCapacityNotionalCutoff : true,
    });
  }

  const opportunities = fullSetOps.sort((a, b) => b.netEdge - a.netEdge);
  const byCategory = new Map<string, { count: number; gross: number[]; net: number[]; cap: number[] }>();
  for (const e of opportunities) {
    const cat = e.category ?? "uncategorized";
    const cur = byCategory.get(cat) ?? { count: 0, gross: [], net: [], cap: [] };
    cur.count += 1;
    cur.gross.push(e.grossEdge);
    cur.net.push(e.netEdge);
    if (e.pairCapacityNotional != null) cur.cap.push(e.pairCapacityNotional);
    byCategory.set(cat, cur);
  }

  const allGross = opportunities.map((x) => x.grossEdge);
  const allNet = opportunities.map((x) => x.netEdge);
  const allCap = opportunities.map((x) => x.pairCapacityNotional).filter((x): x is number => x != null);
  const thinCount = fullSetOps.filter((o) => o.likelyThinNoise).length;
  const opCount = fullSetOps.length;

  let bluntConclusion = "none detected";
  if (opCount > 0 && (thinCount / opCount > 0.6 || (median(allNet) ?? 0) <= 0)) bluntConclusion = "exists but thin";
  if (opCount > 0 && thinCount / opCount <= 0.6 && (median(allNet) ?? 0) > 0) bluntConclusion = "structural edge exists";

  const lines: string[] = [];
  lines.push("# Polymarket Structural Opportunity Audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Data source: fresh CLOB order books via @polymarket/clob-client getOrderBooks (/books), fetched during this run`);
  lines.push(
    `- Fee model for net edge: feeRate=${feeModel.feeRate} per leg (source=${feeModel.source}); net edge is conservative linear fee deduction`
  );
  lines.push(
    "- Scope: read-only measurement only; no strategy routing, thresholds, filters, scorers, or runtime execution behavior changed"
  );
  lines.push("");

  lines.push("## A. Market coverage and synchronized books");
  lines.push(`- Binary markets with both YES/NO metadata: ${binaryMarketMeta.size}`);
  lines.push(`- Markets fetched from CLOB in this run: ${livePairs.length}`);
  lines.push(`- Markets with BOTH YES+NO best ask present (same fetch batch): ${bothLegsPresentCount}`);
  lines.push(`- Full-set parity opportunities (YES ask + NO ask < 1): ${opportunities.length}`);
  lines.push("");
  lines.push("## B. Top parity opportunities (sorted by net edge)");
  lines.push("| market | yes ask | no ask | yes+no | gross edge | net edge | yes size | no size | min size | est capacity | thin/noise |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const o of opportunities.slice(0, 25)) {
    const totalCost = o.yesPrice + o.noPrice;
    lines.push(
      `| ${o.title.replace(/\|/g, "/")} | ${fmt(o.yesPrice, 4)} | ${fmt(o.noPrice, 4)} | ${fmt(totalCost, 4)} | ${fmt(
        o.grossEdge,
        5
      )} | ${fmt(o.netEdge, 5)} | ${fmt(o.yesSize, 2)} | ${fmt(o.noSize, 2)} | ${fmt(o.pairCapacitySize, 2)} | ${fmt(
        o.pairCapacityNotional,
        2
      )} | ${o.likelyThinNoise ? "yes" : "no"} |`
    );
  }
  lines.push("");

  lines.push("## C. Liquidity realism");
  lines.push(`- Flagged opportunities total: ${opCount}`);
  lines.push(`- Likely thin/noise (estimated cap notional < ${thinCapacityNotionalCutoff} or missing): ${thinCount}`);
  lines.push(`- Median estimated capacity notional: ${fmt(median(allCap), 2)}`);
  lines.push("");

  lines.push("## D. Opportunity stats");
  lines.push(`- Opportunities detected this run: ${opportunities.length}`);
  lines.push(`- Median gross edge: ${fmt(median(allGross), 5)}`);
  lines.push(`- Median net edge: ${fmt(median(allNet), 5)}`);
  lines.push(`- Median size-capacity (notional): ${fmt(median(allCap), 2)}`);
  lines.push("");
  lines.push("| category | opportunities | median gross edge | median net edge | median cap notional |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const [cat, agg] of [...byCategory.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12)) {
    lines.push(
      `| ${cat.replace(/\|/g, "/")} | ${agg.count} | ${fmt(median(agg.gross), 5)} | ${fmt(
        median(agg.net),
        5
      )} | ${fmt(median(agg.cap), 2)} |`
    );
  }
  lines.push("");

  lines.push("## E. Blunt conclusion");
  lines.push(`- ${bluntConclusion}`);
  lines.push("");
  lines.push("## Limitations");
  lines.push("- This report is a point-in-time live snapshot; opportunities can disappear quickly.");
  lines.push(
    "- If fee config is missing, net edge uses zero-fee assumption and may be optimistic; set `STRUCTURAL_AUDIT_FEE_RATE` or related env to harden."
  );
  lines.push("- This audit intentionally focuses on binary full-set parity and synchronized YES/NO asks.");

  const outPath = path.join(process.cwd(), "diagnostics", "polymarket-structural-opportunity-audit.md");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

