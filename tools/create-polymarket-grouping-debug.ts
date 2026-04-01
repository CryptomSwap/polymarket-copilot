import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

type MarketRow = {
  id: string;
  slug: string;
  title: string;
  category: string | null;
  raw: string | null;
};

type GroupStats = {
  method: string;
  marketsConsidered: number;
  groupsFormed: number;
  avgGroupSize: number;
  maxGroupSize: number;
  groupsGte2: number;
};

function parseRaw(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}

function readNestedString(obj: Record<string, unknown> | null, pathKeys: string[]): string | null {
  if (!obj) return null;
  let cur: unknown = obj;
  for (const k of pathKeys) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  if (typeof cur === "string" && cur.trim()) return cur.trim();
  if (typeof cur === "number" && Number.isFinite(cur)) return String(cur);
  return null;
}

function pickFirst(rawObj: Record<string, unknown> | null, keys: string[]): string | null {
  if (!rawObj) return null;
  for (const k of keys) {
    const v = rawObj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function slugPrefixKey(slug: string): string | null {
  const s = slug.trim().toLowerCase();
  if (!s) return null;
  const parts = s.split("-").filter(Boolean);
  if (parts.length < 3) return null;
  const suffixDrop = new Set(["yes", "no", "winner", "win", "wins", "over", "under"]);
  let end = parts.length;
  while (end > 2 && suffixDrop.has(parts[end - 1]!)) end--;
  if (end <= 2) return null;
  return parts.slice(0, end - 1).join("-");
}

function normalizeTitleKey(title: string): string | null {
  const t = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(yes|no|winner|wins|win|over|under)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  const words = t.split(" ").filter(Boolean);
  if (words.length < 4) return null;
  return words.slice(0, Math.min(8, words.length)).join(" ");
}

function computeStats(markets: MarketRow[], keyFn: (m: MarketRow) => string | null, method: string): GroupStats {
  const groups = new Map<string, number>();
  let considered = 0;
  for (const m of markets) {
    const key = keyFn(m);
    if (!key) continue;
    considered++;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const sizes = [...groups.values()];
  const groupsFormed = sizes.length;
  const totalInGroups = sizes.reduce((a, b) => a + b, 0);
  return {
    method,
    marketsConsidered: considered,
    groupsFormed,
    avgGroupSize: groupsFormed > 0 ? totalInGroups / groupsFormed : 0,
    maxGroupSize: sizes.length > 0 ? Math.max(...sizes) : 0,
    groupsGte2: sizes.filter((x) => x >= 2).length,
  };
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const sampleSize = Math.max(1, Number.parseInt(process.env.GROUPING_DEBUG_SAMPLE_SIZE ?? "50", 10));

  const markets = await prisma.syncedMarket.findMany({
    where: { status: { not: "closed" } },
    select: { id: true, slug: true, title: true, category: true, raw: true },
    orderBy: { updatedAt: "desc" },
    take: 5000,
  });

  const sample = markets.slice(0, Math.min(sampleSize, markets.length));

  const nestedFieldInventory = new Map<string, number>();
  for (const m of sample) {
    const rawObj = parseRaw(m.raw);
    if (!rawObj) continue;
    for (const k of Object.keys(rawObj)) {
      const v = rawObj[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        for (const sk of Object.keys(obj)) {
          nestedFieldInventory.set(`${k}.${sk}`, (nestedFieldInventory.get(`${k}.${sk}`) ?? 0) + 1);
        }
      }
    }
  }

  const stats: GroupStats[] = [
    computeStats(
      markets,
      (m) => pickFirst(parseRaw(m.raw), ["eventId", "event_id"]) ?? readNestedString(parseRaw(m.raw), ["event", "id"]),
      "eventId / event.id"
    ),
    computeStats(markets, (m) => pickFirst(parseRaw(m.raw), ["groupId", "group_id"]), "groupId"),
    computeStats(markets, (m) => pickFirst(parseRaw(m.raw), ["seriesId", "series_id"]), "seriesId"),
    computeStats(markets, (m) => slugPrefixKey(m.slug), "slug prefix"),
    computeStats(markets, (m) => normalizeTitleKey(m.title), "title normalization"),
  ];

  const knownMultiOutcomeQueries = [
    "democratic nominee",
    "republican nominee",
    "academy award best picture",
    "nba champion",
    "fifa world cup winner",
  ];

  const sanityRows: Array<{
    query: string;
    exists: boolean;
    matchCount: number;
    sample: Array<{ slug: string; title: string; eventId: string | null; groupId: string | null; seriesId: string | null }>;
  }> = [];

  for (const q of knownMultiOutcomeQueries) {
    const matches = await prisma.syncedMarket.findMany({
      where: {
        status: { not: "closed" },
        OR: [{ title: { contains: q, mode: "insensitive" } }, { slug: { contains: q.replace(/\s+/g, "-"), mode: "insensitive" } }],
      },
      select: { slug: true, title: true, raw: true },
      take: 10,
    });
    sanityRows.push({
      query: q,
      exists: matches.length > 0,
      matchCount: matches.length,
      sample: matches.slice(0, 5).map((m) => {
        const rawObj = parseRaw(m.raw);
        return {
          slug: m.slug,
          title: m.title,
          eventId: pickFirst(rawObj, ["eventId", "event_id"]) ?? readNestedString(rawObj, ["event", "id"]),
          groupId: pickFirst(rawObj, ["groupId", "group_id"]),
          seriesId: pickFirst(rawObj, ["seriesId", "series_id"]),
        };
      }),
    });
  }

  const best = [...stats].sort((a, b) => b.groupsGte2 - a.groupsGte2 || b.maxGroupSize - a.maxGroupSize)[0];

  let conclusion = "evidence insufficient";
  if (best && best.groupsGte2 > 0 && best.avgGroupSize >= 1.3) conclusion = "grouping data exists but not used correctly";
  if (stats.every((s) => s.groupsGte2 === 0) && stats.some((s) => s.marketsConsidered > 0)) conclusion = "grouping data missing from ingestion";
  if (stats.every((s) => s.marketsConsidered === 0)) conclusion = "grouping impossible with current schema";

  const lines: string[] = [];
  lines.push("# Polymarket Grouping Debug");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Active markets scanned: ${markets.length}`);
  lines.push(`- Raw metadata sample size: ${sample.length}`);
  lines.push("");

  lines.push("## A. Raw metadata inspection (sample)");
  lines.push("| slug | title | eventId | event.id | groupId | seriesId | top-level raw keys |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const m of sample) {
    const rawObj = parseRaw(m.raw);
    const eventId = pickFirst(rawObj, ["eventId", "event_id"]);
    const eventDotId = readNestedString(rawObj, ["event", "id"]);
    const groupId = pickFirst(rawObj, ["groupId", "group_id"]);
    const seriesId = pickFirst(rawObj, ["seriesId", "series_id"]);
    const topKeys = rawObj ? Object.keys(rawObj).slice(0, 8).join(", ") : "-";
    lines.push(
      `| ${m.slug.replace(/\|/g, "/")} | ${m.title.replace(/\|/g, "/")} | ${eventId ?? "-"} | ${eventDotId ?? "-"} | ${groupId ?? "-"} | ${seriesId ?? "-"} | ${topKeys || "-"} |`
    );
  }
  lines.push("");
  lines.push("Nested object key frequencies in sample:");
  for (const [k, c] of [...nestedFieldInventory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    lines.push(`- ${k}: ${c}`);
  }
  lines.push("");

  lines.push("## B. Group candidate analysis");
  lines.push("| method | markets considered | groups formed | avg group size | max group size | groups >=2 |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const s of stats) {
    lines.push(
      `| ${s.method} | ${s.marketsConsidered} | ${s.groupsFormed} | ${fmt(s.avgGroupSize)} | ${s.maxGroupSize} | ${s.groupsGte2} |`
    );
  }
  lines.push("");

  lines.push("## C. Ground truth sanity (known multi-outcome queries)");
  for (const row of sanityRows) {
    lines.push(`- Query: "${row.query}" -> exists=${row.exists ? "yes" : "no"}, matches=${row.matchCount}`);
    if (row.sample.length) {
      lines.push("| slug | title | eventId | groupId | seriesId |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const s of row.sample) {
        lines.push(
          `| ${s.slug.replace(/\|/g, "/")} | ${s.title.replace(/\|/g, "/")} | ${s.eventId ?? "-"} | ${s.groupId ?? "-"} | ${s.seriesId ?? "-"} |`
        );
      }
    }
  }
  lines.push("");

  lines.push("## D. Best key candidate");
  lines.push(
    `- ${best ? `${best.method} (groups>=2: ${best.groupsGte2}, avg size: ${fmt(best.avgGroupSize)}, max size: ${best.maxGroupSize})` : "none"}`
  );
  lines.push("");

  lines.push("## E. Blunt conclusion");
  lines.push(`- ${conclusion}`);

  const outPath = path.join(process.cwd(), "diagnostics", "polymarket-grouping-debug.md");
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

