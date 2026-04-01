import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

type SyncedRow = {
  id: string;
  slug: string;
  title: string;
  conditionId: string | null;
};

type GammaRow = {
  eventId: string | null;
  eventTitle: string | null;
  marketId: string | null;
  marketSlug: string | null;
  marketTitle: string | null;
  conditionId: string | null;
};

type MatchPair = {
  strategy: string;
  syncedConditionId: string;
  syncedSlug: string;
  gammaConditionId: string;
  gammaSlug: string | null;
};

function asStr(v: unknown): string {
  return String(v ?? "");
}

function trim(v: unknown): string {
  return asStr(v).trim();
}

function lower(v: unknown): string {
  return trim(v).toLowerCase();
}

function strip0x(v: unknown): string {
  const s = lower(v);
  return s.startsWith("0x") ? s.slice(2) : s;
}

function ensure0x(v: unknown): string {
  const s = strip0x(v);
  if (!s) return "";
  return `0x${s}`;
}

function suffix64(v: unknown): string {
  const s = strip0x(v);
  if (!s) return "";
  return s.length <= 64 ? s : s.slice(s.length - 64);
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

async function fetchGammaEvents(limit: number, maxPages: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let p = 0; p < maxPages; p++) {
    const offset = p * limit;
    const url = `https://gamma-api.polymarket.com/events?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Gamma events fetch failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const rows = Array.isArray(data)
      ? data
      : (data as { data?: unknown[]; events?: unknown[] }).data ?? (data as { events?: unknown[] }).events ?? [];
    const events = rows.filter((r): r is Record<string, unknown> => r != null && typeof r === "object");
    out.push(...events);
    if (events.length < limit) break;
  }
  return out;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const syncedSampleSize = 20;
  const gammaLimit = Math.max(1, Number.parseInt(process.env.CONDID_DEBUG_GAMMA_LIMIT ?? "200", 10));
  const gammaPages = Math.max(1, Number.parseInt(process.env.CONDID_DEBUG_GAMMA_MAX_PAGES ?? "10", 10));

  const syncedRows = (await prisma.syncedMarket.findMany({
    select: { id: true, slug: true, title: true, conditionId: true },
    take: 5000,
    orderBy: { updatedAt: "desc" },
  })) as SyncedRow[];

  const gammaEvents = await fetchGammaEvents(gammaLimit, gammaPages);
  const gammaRows: GammaRow[] = [];
  for (const ev of gammaEvents) {
    const eventId = pickString(ev, "id");
    const eventTitle = pickString(ev, "title");
    const markets = Array.isArray(ev.markets) ? ev.markets : [];
    for (const m of markets) {
      if (!m || typeof m !== "object") continue;
      const mm = m as Record<string, unknown>;
      gammaRows.push({
        eventId,
        eventTitle,
        marketId: pickString(mm, "id"),
        marketSlug: pickString(mm, "slug"),
        marketTitle: pickString(mm, "question") ?? pickString(mm, "title"),
        conditionId: pickString(mm, "conditionId") ?? pickString(mm, "condition_id"),
      });
    }
  }

  const syncedCond = uniqueNonEmpty(syncedRows.map((r) => r.conditionId ?? ""));
  const gammaCond = uniqueNonEmpty(gammaRows.map((r) => r.conditionId ?? ""));

  const syncedByExact = new Map(syncedRows.filter((r) => !!r.conditionId).map((r) => [r.conditionId as string, r]));
  const syncedByTrim = new Map(syncedRows.filter((r) => !!r.conditionId).map((r) => [trim(r.conditionId), r]));
  const syncedByLower = new Map(syncedRows.filter((r) => !!r.conditionId).map((r) => [lower(r.conditionId), r]));
  const syncedByStrip = new Map(syncedRows.filter((r) => !!r.conditionId).map((r) => [strip0x(r.conditionId), r]));
  const syncedByEnsure = new Map(syncedRows.filter((r) => !!r.conditionId).map((r) => [ensure0x(r.conditionId), r]));
  const syncedBySuffix64 = new Map(syncedRows.filter((r) => !!r.conditionId).map((r) => [suffix64(r.conditionId), r]));

  const strategies: Array<{ name: string; hits: number; pairs: MatchPair[] }> = [];

  function runStrategy(name: string, keyFn: (v: string) => string, index: Map<string, SyncedRow>) {
    let hits = 0;
    const pairs: MatchPair[] = [];
    for (const g of gammaRows) {
      if (!g.conditionId) continue;
      const k = keyFn(g.conditionId);
      const s = index.get(k);
      if (!s) continue;
      hits++;
      if (pairs.length < 20) {
        pairs.push({
          strategy: name,
          syncedConditionId: s.conditionId ?? "",
          syncedSlug: s.slug,
          gammaConditionId: g.conditionId,
          gammaSlug: g.marketSlug ?? null,
        });
      }
    }
    strategies.push({ name, hits, pairs });
  }

  runStrategy("exact", (v) => v, syncedByExact);
  runStrategy("trim", (v) => trim(v), syncedByTrim);
  runStrategy("lowercase", (v) => lower(v), syncedByLower);
  runStrategy("strip_0x_both", (v) => strip0x(v), syncedByStrip);
  runStrategy("ensure_0x_lower", (v) => ensure0x(v), syncedByEnsure);
  runStrategy("suffix_64_hex", (v) => suffix64(v), syncedBySuffix64);

  // Substring/contains diagnostic (expensive but small enough for debug)
  let containsHits = 0;
  const containsPairs: MatchPair[] = [];
  const syncedNonNull = syncedRows.filter((s) => !!s.conditionId);
  for (const g of gammaRows) {
    const gc = strip0x(g.conditionId ?? "");
    if (!gc) continue;
    const s = syncedNonNull.find((x) => {
      const sc = strip0x(x.conditionId ?? "");
      return sc.includes(gc) || gc.includes(sc);
    });
    if (!s) continue;
    containsHits++;
    if (containsPairs.length < 20) {
      containsPairs.push({
        strategy: "substring_contains",
        syncedConditionId: s.conditionId ?? "",
        syncedSlug: s.slug,
        gammaConditionId: g.conditionId ?? "",
        gammaSlug: g.marketSlug ?? null,
      });
    }
  }
  strategies.push({ name: "substring_contains", hits: containsHits, pairs: containsPairs });

  const best = [...strategies].sort((a, b) => b.hits - a.hits)[0];

  let conclusion = "still zero matches → deeper ingestion bug";
  if (best && best.hits > 0) conclusion = "conditionId matches after normalization -> FIXABLE";
  if (best && best.hits === 0 && (syncedCond.length > 0 || gammaCond.length > 0)) {
    conclusion = "conditionId fundamentally different -> needs mapping layer";
  }

  const lines: string[] = [];
  lines.push("# Polymarket conditionId normalization debug");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Synced markets scanned: ${syncedRows.length}`);
  lines.push(`- Gamma markets scanned: ${gammaRows.length}`);
  lines.push(`- Unique synced conditionIds: ${syncedCond.length}`);
  lines.push(`- Unique gamma conditionIds: ${gammaCond.length}`);
  lines.push("");

  lines.push("## 1) SyncedMarket.conditionId sample (20)");
  lines.push("| syncedMarketId | slug | conditionId raw | typeof | length |");
  lines.push("| --- | --- | --- | --- | ---: |");
  for (const s of syncedRows.slice(0, syncedSampleSize)) {
    const raw = s.conditionId;
    lines.push(
      `| ${s.id} | ${s.slug.replace(/\|/g, "/")} | ${(raw ?? "-").replace(/\|/g, "/")} | ${typeof raw} | ${raw ? raw.length : 0} |`
    );
  }
  lines.push("");

  lines.push("## 2) Join match counts by normalization strategy");
  lines.push("| strategy | match count |");
  lines.push("| --- | ---: |");
  for (const s of strategies) lines.push(`| ${s.name} | ${s.hits} |`);
  lines.push("");

  lines.push("## 3) Correct normalization rule");
  lines.push(`- ${best && best.hits > 0 ? `${best.name}` : "none found"}`);
  lines.push("");

  lines.push("## 4) Example matched pairs (Gamma ↔ SyncedMarket)");
  if (best && best.hits > 0) {
    lines.push("| strategy | synced conditionId | synced slug | gamma conditionId | gamma slug |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const p of best.pairs.slice(0, 15)) {
      lines.push(
        `| ${p.strategy} | ${p.syncedConditionId} | ${p.syncedSlug.replace(/\|/g, "/")} | ${p.gammaConditionId} | ${(p.gammaSlug ?? "-").replace(/\|/g, "/")} |`
      );
    }
  } else {
    lines.push("- No matched pairs found.");
  }
  lines.push("");

  lines.push("## 5) Blunt conclusion");
  lines.push(`- ${conclusion}`);

  const outPath = path.join(process.cwd(), "diagnostics", "polymarket-conditionid-normalization-debug.md");
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

