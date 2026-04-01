import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

type SyncedRow = {
  id: string;
  conditionId: string | null;
  slug: string;
  title: string;
  raw: string | null;
};

type GammaEvent = Record<string, unknown>;
type GammaMarket = Record<string, unknown>;

type JoinStats = {
  exactConditionId: number;
  normalizedConditionId: number;
  exactSlug: number;
  normalizedSlug: number;
  titleSimilarity: number;
};

type Taxonomy = {
  gammaMarketMissingConditionId: number;
  syncedMissingComparableId: number;
  slugFormattingMismatch: number;
  universeMismatch: number;
  other: number;
};

function parseRaw(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeConditionId(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("0x")) return s;
  if (/^[0-9a-f]{64}$/.test(s)) return `0x${s}`;
  return s;
}

function normalizeSlug(v: unknown): string | null {
  if (v == null) return null;
  const s = decodeURIComponent(String(v)).trim().toLowerCase();
  if (!s) return null;
  return s.replace(/\s+/g, "-").replace(/-+/g, "-");
}

function normalizeTitle(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

function tokenSet(s: string | null): Set<string> {
  if (!s) return new Set();
  return new Set(s.split(" ").filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function pickString(o: Record<string, unknown> | null, key: string): string | null {
  if (!o) return null;
  const v = o[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

async function fetchGammaEvents(limit: number, maxPages: number): Promise<GammaEvent[]> {
  const out: GammaEvent[] = [];
  for (let p = 0; p < maxPages; p++) {
    const offset = p * limit;
    const url = `https://gamma-api.polymarket.com/events?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Gamma events fetch failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const rows = Array.isArray(data)
      ? data
      : (data as { data?: unknown[]; events?: unknown[] }).data ?? (data as { events?: unknown[] }).events ?? [];
    const events = rows.filter((r): r is GammaEvent => r != null && typeof r === "object");
    out.push(...events);
    if (events.length < limit) break;
  }
  return out;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const syncedSampleSize = Math.max(1, Number.parseInt(process.env.GAMMA_JOIN_DEBUG_SYNCED_SAMPLE ?? "50", 10));
  const gammaSampleEvents = Math.max(1, Number.parseInt(process.env.GAMMA_JOIN_DEBUG_GAMMA_SAMPLE_EVENTS ?? "15", 10));
  const gammaLimit = Math.max(1, Number.parseInt(process.env.GAMMA_JOIN_DEBUG_GAMMA_LIMIT ?? "200", 10));
  const gammaPages = Math.max(1, Number.parseInt(process.env.GAMMA_JOIN_DEBUG_GAMMA_MAX_PAGES ?? "8", 10));
  const titleThreshold = Number.parseFloat(process.env.GAMMA_JOIN_DEBUG_TITLE_THRESHOLD ?? "0.6");

  const synced = (await prisma.syncedMarket.findMany({
    select: { id: true, conditionId: true, slug: true, title: true, raw: true },
    take: 5000,
    orderBy: { updatedAt: "desc" },
  })) as SyncedRow[];

  const gammaEvents = await fetchGammaEvents(gammaLimit, gammaPages);
  const gammaMarketsRaw: Array<{
    eventId: string | null;
    eventTitle: string | null;
    marketId: string | null;
    conditionId: string | null;
    slug: string | null;
    title: string | null;
  }> = [];
  for (const ev of gammaEvents) {
    const eventId = pickString(ev, "id");
    const eventTitle = pickString(ev, "title");
    const mk = Array.isArray(ev.markets) ? (ev.markets as unknown[]) : [];
    for (const m of mk) {
      if (!m || typeof m !== "object") continue;
      const mm = m as GammaMarket;
      gammaMarketsRaw.push({
        eventId,
        eventTitle,
        marketId: pickString(mm, "id"),
        conditionId: pickString(mm, "conditionId") ?? pickString(mm, "condition_id"),
        slug: pickString(mm, "slug"),
        title: pickString(mm, "question") ?? pickString(mm, "title"),
      });
    }
  }

  const gammaByCondExact = new Set(gammaMarketsRaw.map((m) => m.conditionId).filter((x): x is string => !!x));
  const gammaByCondNorm = new Set(gammaMarketsRaw.map((m) => normalizeConditionId(m.conditionId)).filter((x): x is string => !!x));
  const gammaBySlugExact = new Set(gammaMarketsRaw.map((m) => m.slug).filter((x): x is string => !!x));
  const gammaBySlugNorm = new Set(gammaMarketsRaw.map((m) => normalizeSlug(m.slug)).filter((x): x is string => !!x));
  const gammaTitleNorm = gammaMarketsRaw.map((m) => ({ tokens: tokenSet(normalizeTitle(m.title)), raw: m }));

  const joinStats: JoinStats = {
    exactConditionId: 0,
    normalizedConditionId: 0,
    exactSlug: 0,
    normalizedSlug: 0,
    titleSimilarity: 0,
  };

  const taxonomy: Taxonomy = {
    gammaMarketMissingConditionId: gammaMarketsRaw.filter((m) => !m.conditionId).length,
    syncedMissingComparableId: 0,
    slugFormattingMismatch: 0,
    universeMismatch: 0,
    other: 0,
  };

  for (const s of synced) {
    const sCondExact = s.conditionId?.trim() || null;
    const sCondNorm = normalizeConditionId(s.conditionId);
    const sSlugExact = s.slug;
    const sSlugNorm = normalizeSlug(s.slug);
    const sTitleTok = tokenSet(normalizeTitle(s.title));

    const exactCondMatch = !!(sCondExact && gammaByCondExact.has(sCondExact));
    const normCondMatch = !!(sCondNorm && gammaByCondNorm.has(sCondNorm));
    const exactSlugMatch = gammaBySlugExact.has(sSlugExact);
    const normSlugMatch = !!(sSlugNorm && gammaBySlugNorm.has(sSlugNorm));

    let titleSimMatch = false;
    if (sTitleTok.size > 0) {
      for (const g of gammaTitleNorm) {
        if (jaccard(sTitleTok, g.tokens) >= titleThreshold) {
          titleSimMatch = true;
          break;
        }
      }
    }

    if (exactCondMatch) joinStats.exactConditionId++;
    if (normCondMatch) joinStats.normalizedConditionId++;
    if (exactSlugMatch) joinStats.exactSlug++;
    if (normSlugMatch) joinStats.normalizedSlug++;
    if (titleSimMatch) joinStats.titleSimilarity++;

    const hasComparable = !!sCondNorm || !!sSlugNorm;
    if (!hasComparable) {
      taxonomy.syncedMissingComparableId++;
      continue;
    }
    if (!exactSlugMatch && normSlugMatch) {
      taxonomy.slugFormattingMismatch++;
      continue;
    }
    if (!normCondMatch && !normSlugMatch && !titleSimMatch) {
      taxonomy.universeMismatch++;
      continue;
    }
    if (!normCondMatch && !normSlugMatch && titleSimMatch) {
      taxonomy.other++;
      continue;
    }
  }

  let conclusion = "evidence insufficient";
  if (joinStats.normalizedConditionId === 0 && joinStats.normalizedSlug === 0 && taxonomy.universeMismatch > synced.length * 0.7) {
    conclusion = "Gamma does not cover the same market universe";
  } else if (joinStats.normalizedConditionId > 0 || joinStats.normalizedSlug > 0) {
    conclusion = "Gamma has the right grouping data but our join logic is wrong";
  } else if (joinStats.titleSimilarity > 0 && joinStats.normalizedConditionId === 0 && joinStats.normalizedSlug === 0) {
    conclusion = "our ingestion source is incompatible with Gamma grouping";
  }

  const syncedSample = synced.slice(0, Math.min(syncedSampleSize, synced.length));
  const gammaSample = gammaEvents.slice(0, Math.min(gammaSampleEvents, gammaEvents.length));

  const lines: string[] = [];
  lines.push("# Polymarket Gamma Join Debug");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Synced markets scanned: ${synced.length}`);
  lines.push(`- Gamma events fetched: ${gammaEvents.length}`);
  lines.push(`- Gamma event markets flattened: ${gammaMarketsRaw.length}`);
  lines.push("");

  lines.push("## A. SyncedMarket side");
  lines.push(`- unique non-null conditionIds: ${new Set(synced.map((s) => s.conditionId).filter((x): x is string => !!x)).size}`);
  lines.push(`- unique slugs: ${new Set(synced.map((s) => s.slug)).size}`);
  lines.push("| conditionId | slug | title | raw ids hints |");
  lines.push("| --- | --- | --- | --- |");
  for (const s of syncedSample) {
    const rawObj = parseRaw(s.raw);
    const hints = [
      pickString(rawObj, "id"),
      pickString(rawObj, "eventId"),
      pickString(rawObj, "groupId"),
      pickString(rawObj, "seriesId"),
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`| ${s.conditionId ?? "-"} | ${s.slug.replace(/\|/g, "/")} | ${s.title.replace(/\|/g, "/")} | ${hints || "-"} |`);
  }
  lines.push("");

  lines.push("## B. Gamma events side");
  for (const ev of gammaSample) {
    const eventId = pickString(ev, "id");
    const eventTitle = pickString(ev, "title");
    const mk = Array.isArray(ev.markets) ? (ev.markets as unknown[]) : [];
    lines.push(`- eventId=${eventId ?? "-"} | title=${eventTitle ?? "-"} | marketCount=${mk.length}`);
    for (const m of mk.slice(0, 5)) {
      if (!m || typeof m !== "object") continue;
      const mm = m as GammaMarket;
      const conditionId = pickString(mm, "conditionId") ?? pickString(mm, "condition_id");
      const slug = pickString(mm, "slug");
      const mId = pickString(mm, "id");
      const question = pickString(mm, "question") ?? pickString(mm, "title");
      lines.push(`  - marketId=${mId ?? "-"} conditionId=${conditionId ?? "-"} slug=${slug ?? "-"} title=${question ?? "-"}`);
    }
  }
  lines.push("");

  lines.push("## C. Join attempts");
  lines.push("| method | matches |");
  lines.push("| --- | ---: |");
  lines.push(`| exact conditionId | ${joinStats.exactConditionId} |`);
  lines.push(`| normalized conditionId | ${joinStats.normalizedConditionId} |`);
  lines.push(`| exact slug | ${joinStats.exactSlug} |`);
  lines.push(`| normalized slug | ${joinStats.normalizedSlug} |`);
  lines.push(`| title similarity (diagnostic) | ${joinStats.titleSimilarity} |`);
  lines.push("");

  lines.push("## D. Mismatch taxonomy");
  lines.push(`- Gamma market missing conditionId: ${taxonomy.gammaMarketMissingConditionId}`);
  lines.push(`- SyncedMarket missing comparable id: ${taxonomy.syncedMissingComparableId}`);
  lines.push(`- slug formatting mismatch: ${taxonomy.slugFormattingMismatch}`);
  lines.push(`- universe mismatch: ${taxonomy.universeMismatch}`);
  lines.push(`- other: ${taxonomy.other}`);
  lines.push("");

  lines.push("## E. Blunt conclusion");
  lines.push(`- ${conclusion}`);

  const outPath = path.join(process.cwd(), "diagnostics", "polymarket-gamma-join-debug.md");
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

