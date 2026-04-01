import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { ClobClient, Side, type OrderBookSummary } from "@polymarket/clob-client";
import { getClobChainId, getClobHost } from "../lib/polymarket/client";

type GroupLeg = {
  marketId: string;
  title: string;
  category: string | null;
  yesAssetId: string;
};

type BookTop = {
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  midpoint: number | null;
  timestamp: string | null;
};

type GroupOpportunity = {
  groupKey: string;
  category: string | null;
  outcomes: number;
  checkType: "yes_ask_under_sum" | "yes_bid_over_sum" | "yes_mid_under_sum";
  sumValue: number;
  grossDeviation: number;
  netDeviation: number | null;
  minExecutableSize: number | null;
  estimatedCapacity: number | null;
  thinNoise: boolean;
};

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function fmt(n: number | null, d = 6): string {
  return n == null ? "-" : n.toFixed(d);
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function isYesLabel(outcome: string): boolean {
  const t = outcome.trim().toLowerCase();
  return t === "yes" || t === "y";
}

function isNoLabel(outcome: string): boolean {
  const t = outcome.trim().toLowerCase();
  return t === "no" || t === "n";
}

function feeRateFromEnv(): { feeRate: number; source: string } {
  const rateCandidates = [
    process.env.POLYMARKET_TAKER_FEE_RATE,
    process.env.POLYMARKET_FEE_RATE,
    process.env.CLOB_TAKER_FEE_RATE,
    process.env.GROUP_PARITY_AUDIT_FEE_RATE,
  ];
  for (const raw of rateCandidates) {
    const n = parseNum(raw);
    if (n != null && n >= 0) return { feeRate: n, source: "env_fee_rate" };
  }
  const bpsCandidates = [
    process.env.POLYMARKET_TAKER_FEE_BPS,
    process.env.POLYMARKET_FEE_BPS,
    process.env.CLOB_TAKER_FEE_BPS,
    process.env.GROUP_PARITY_AUDIT_FEE_BPS,
  ];
  for (const raw of bpsCandidates) {
    const bps = parseNum(raw);
    if (bps != null && bps >= 0) return { feeRate: bps / 10_000, source: "env_fee_bps" };
  }
  return { feeRate: 0, source: "missing_config_assumed_zero" };
}

function extractGroupKey(raw: string | null, slug: string, title: string): string | null {
  if (raw) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      const directKeys = ["eventId", "event_id", "parentEventId", "parent_event_id", "seriesId", "series_id", "groupId", "group_id"];
      for (const k of directKeys) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) return `raw:${k}:${v.trim()}`;
        if (typeof v === "number" && Number.isFinite(v)) return `raw:${k}:${String(v)}`;
      }
      const eventObj = o.event as Record<string, unknown> | undefined;
      if (eventObj && typeof eventObj.id === "string" && eventObj.id.trim()) return `raw:event.id:${eventObj.id.trim()}`;
    } catch {
      // best effort
    }
  }
  const slugParts = slug.split("-").filter(Boolean);
  if (slugParts.length >= 3) return `slug-prefix:${slugParts.slice(0, slugParts.length - 1).join("-")}`;
  const stem = title.trim().toLowerCase().split("?")[0]?.slice(0, 48) ?? "";
  if (stem.length >= 18) return `title-stem:${stem}`;
  return null;
}

function topFromBook(b: OrderBookSummary | null | undefined): BookTop {
  if (!b) return { bid: null, ask: null, bidSize: null, askSize: null, midpoint: null, timestamp: null };
  const bid0 = Array.isArray(b.bids) && b.bids.length > 0 ? b.bids[0] : null;
  const ask0 = Array.isArray(b.asks) && b.asks.length > 0 ? b.asks[0] : null;
  const bid = parseNum(bid0?.price);
  const ask = parseNum(ask0?.price);
  const midpoint = bid != null && ask != null && ask > bid ? (bid + ask) / 2 : null;
  return {
    bid,
    ask,
    bidSize: parseNum(bid0?.size),
    askSize: parseNum(ask0?.size),
    midpoint,
    timestamp: typeof b.timestamp === "string" ? b.timestamp : null,
  };
}

async function fetchBooks(client: ClobClient, tokenIds: string[]): Promise<Map<string, OrderBookSummary>> {
  const byToken = new Map<string, OrderBookSummary>();
  const chunk = Math.max(1, Number.parseInt(process.env.GROUP_PARITY_AUDIT_BOOK_CHUNK ?? "120", 10));
  for (let i = 0; i < tokenIds.length; i += chunk) {
    const ids = tokenIds.slice(i, i + chunk);
    const params = ids.map((id) => ({ token_id: id, side: Side.BUY }));
    let books: OrderBookSummary[] = [];
    try {
      books = (await client.getOrderBooks(params)) as OrderBookSummary[];
    } catch {
      books = [];
    }
    for (const b of books) {
      if (b?.asset_id) byToken.set(String(b.asset_id), b);
    }
  }
  return byToken;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const feeModel = feeRateFromEnv();
  const thinCapacityNotionalCutoff = parseNum(process.env.GROUP_PARITY_AUDIT_THIN_NOTIONAL_CUTOFF) ?? 30;
  const minGroupOutcomes = Math.max(2, Number.parseInt(process.env.GROUP_PARITY_AUDIT_MIN_OUTCOMES ?? "2", 10));
  const flagAbs = parseNum(process.env.GROUP_PARITY_AUDIT_FLAG_ABS) ?? 0.03;

  const markets = await prisma.syncedMarket.findMany({
    where: { status: { not: "closed" } },
    select: {
      id: true,
      slug: true,
      title: true,
      category: true,
      raw: true,
      assets: { select: { tokenId: true, outcome: true } },
    },
    take: 5000,
  });

  const groups = new Map<string, GroupLeg[]>();
  let ambiguousGroupingCandidates = 0;
  for (const m of markets) {
    const yes = m.assets.find((a) => isYesLabel(a.outcome));
    const no = m.assets.find((a) => isNoLabel(a.outcome));
    if (!yes || !no) continue; // grouped parity built from binary YES legs per related market
    const key = extractGroupKey(m.raw, m.slug, m.title);
    if (!key) {
      ambiguousGroupingCandidates++;
      continue;
    }
    const arr = groups.get(key) ?? [];
    arr.push({
      marketId: m.id,
      title: m.title,
      category: m.category ?? null,
      yesAssetId: yes.tokenId,
    });
    groups.set(key, arr);
  }

  const grouped = [...groups.entries()]
    .map(([k, legs]) => ({ key: k, legs }))
    .filter((g) => g.legs.length >= minGroupOutcomes);

  const allYesTokens = [...new Set(grouped.flatMap((g) => g.legs.map((l) => l.yesAssetId)))];
  const clob = new ClobClient(getClobHost(), getClobChainId());
  const booksByToken = await fetchBooks(clob, allYesTokens);

  let usableGroups = 0;
  const opportunities: GroupOpportunity[] = [];

  for (const g of grouped) {
    const tops = g.legs.map((l) => ({ leg: l, top: topFromBook(booksByToken.get(l.yesAssetId)) }));
    const asks = tops.map((x) => x.top.ask).filter((x): x is number => x != null);
    const bids = tops.map((x) => x.top.bid).filter((x): x is number => x != null);
    const mids = tops.map((x) => x.top.midpoint).filter((x): x is number => x != null);
    if (asks.length !== g.legs.length && bids.length !== g.legs.length && mids.length !== g.legs.length) continue;
    usableGroups++;

    if (asks.length === g.legs.length) {
      const sumAsk = asks.reduce((a, b) => a + b, 0);
      const gross = 1 - sumAsk;
      if (Math.abs(gross) >= flagAbs && gross > 0) {
        const minSize = tops.map((x) => x.top.askSize).filter((x): x is number => x != null).reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
        const minExec = Number.isFinite(minSize) ? minSize : null;
        const cap = minExec != null ? minExec * sumAsk : null;
        const net = gross - feeModel.feeRate * sumAsk;
        opportunities.push({
          groupKey: g.key,
          category: g.legs[0]?.category ?? null,
          outcomes: g.legs.length,
          checkType: "yes_ask_under_sum",
          sumValue: sumAsk,
          grossDeviation: gross,
          netDeviation: net,
          minExecutableSize: minExec,
          estimatedCapacity: cap,
          thinNoise: cap != null ? cap < thinCapacityNotionalCutoff : true,
        });
      }
    }

    if (bids.length === g.legs.length) {
      const sumBid = bids.reduce((a, b) => a + b, 0);
      const gross = sumBid - 1;
      if (Math.abs(gross) >= flagAbs && gross > 0) {
        const minSize = tops.map((x) => x.top.bidSize).filter((x): x is number => x != null).reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
        const minExec = Number.isFinite(minSize) ? minSize : null;
        const cap = minExec != null ? minExec * sumBid : null;
        const net = gross - feeModel.feeRate * sumBid;
        opportunities.push({
          groupKey: g.key,
          category: g.legs[0]?.category ?? null,
          outcomes: g.legs.length,
          checkType: "yes_bid_over_sum",
          sumValue: sumBid,
          grossDeviation: gross,
          netDeviation: net,
          minExecutableSize: minExec,
          estimatedCapacity: cap,
          thinNoise: cap != null ? cap < thinCapacityNotionalCutoff : true,
        });
      }
    }

    if (mids.length === g.legs.length) {
      const sumMid = mids.reduce((a, b) => a + b, 0);
      const gross = 1 - sumMid;
      if (Math.abs(gross) >= flagAbs && gross > 0) {
        opportunities.push({
          groupKey: g.key,
          category: g.legs[0]?.category ?? null,
          outcomes: g.legs.length,
          checkType: "yes_mid_under_sum",
          sumValue: sumMid,
          grossDeviation: gross,
          netDeviation: null,
          minExecutableSize: null,
          estimatedCapacity: null,
          thinNoise: true,
        });
      }
    }
  }

  opportunities.sort((a, b) => b.grossDeviation - a.grossDeviation);
  const caps = opportunities.map((o) => o.estimatedCapacity).filter((x): x is number => x != null);
  const thinCount = opportunities.filter((o) => o.thinNoise).length;

  let conclusion = "none detected";
  if (grouped.length === 0 || usableGroups < Math.max(3, Math.floor(grouped.length * 0.2)) || ambiguousGroupingCandidates > grouped.length * 3) {
    conclusion = "evidence insufficient due to grouping ambiguity";
  } else if (opportunities.length > 0 && thinCount / opportunities.length > 0.6) {
    conclusion = "exists but thin/noisy";
  } else if (opportunities.length > 0) {
    conclusion = "grouped structural edge exists";
  }

  const lines: string[] = [];
  lines.push("# Polymarket Group Parity Audit");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Data source: SyncedMarket/SyncedAsset grouping + fresh CLOB books (/books) for all group legs in this run`);
  lines.push(`- Fee model for net deviation: feeRate=${feeModel.feeRate} (source=${feeModel.source})`);
  lines.push(`- Grouping: metadata keys (event/group/series in raw), fallback to slug/title stem heuristics`);
  lines.push(`- Partial-check mode: true (exact negative-risk conversion mechanics not encoded in repo metadata)`);
  lines.push("");

  lines.push("## A. Group build coverage");
  lines.push(`- Candidate grouped binary markets: ${[...groups.values()].reduce((a, b) => a + b.length, 0)}`);
  lines.push(`- Groups scanned (>=${minGroupOutcomes} outcomes): ${grouped.length}`);
  lines.push(`- Grouping-ambiguous markets skipped: ${ambiguousGroupingCandidates}`);
  lines.push("");

  lines.push("## B. Synchronized live book coverage");
  lines.push(`- YES-leg tokens requested from CLOB: ${allYesTokens.length}`);
  lines.push(`- Groups with usable synchronized books: ${usableGroups}`);
  lines.push("");

  lines.push("## C. Parity dislocations");
  lines.push(`- Opportunities found: ${opportunities.length}`);
  lines.push(`- Thin/noise flagged: ${thinCount}`);
  lines.push(`- Median estimated capacity: ${fmt(median(caps), 2)}`);
  lines.push("");
  lines.push("| group key | check | outcomes | sum | gross deviation | net deviation | min exec size | est capacity | thin/noise |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const o of opportunities.slice(0, 25)) {
    lines.push(
      `| ${o.groupKey.replace(/\|/g, "/")} | ${o.checkType} | ${o.outcomes} | ${fmt(o.sumValue, 4)} | ${fmt(o.grossDeviation, 5)} | ${fmt(
        o.netDeviation,
        5
      )} | ${fmt(o.minExecutableSize, 2)} | ${fmt(o.estimatedCapacity, 2)} | ${o.thinNoise ? "yes" : "no"} |`
    );
  }
  lines.push("");

  lines.push("## D. Liquidity realism");
  lines.push(`- Thin/noise cutoff (capacity): ${thinCapacityNotionalCutoff}`);
  lines.push("- Min executable size uses the smallest top-of-book size across relevant legs of the flagged check.");
  lines.push("- Capacity is approximate and point-in-time only.");
  lines.push("");

  lines.push("## E. Blunt conclusion");
  lines.push(`- ${conclusion}`);
  lines.push("");

  lines.push("## Limitations");
  lines.push("- Grouping is metadata/heuristic-driven; imperfect grouping can cause false positives/negatives.");
  lines.push("- Checks are partial parity checks (YES-sum variants), not guaranteed executable conversion paths.");
  lines.push("- Snapshot is point-in-time; dislocations may vanish quickly.");

  const outPath = path.join(process.cwd(), "diagnostics", "polymarket-group-parity-audit.md");
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

