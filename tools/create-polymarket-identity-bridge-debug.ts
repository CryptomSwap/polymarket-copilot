import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

type GammaMarketFlat = {
  eventId: string | null;
  eventTitle: string | null;
  eventSlug: string | null;
  marketId: string | null;
  marketSlug: string | null;
  question: string | null;
  conditionId: string | null;
  clobTokenIdsRaw: string | null;
  tokenIds: string[];
  outcomes: string[];
  raw: Record<string, unknown>;
};

function parseRaw(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJsonArrayStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    try {
      const arr = JSON.parse(v) as unknown[];
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  return [];
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

function normalizeTitleStem(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  const words = s.split(" ").filter(Boolean);
  if (words.length < 4) return null;
  return words.slice(0, Math.min(8, words.length)).join(" ");
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
    if (!res.ok) throw new Error(`Gamma events failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const rows = Array.isArray(data)
      ? data
      : (data as { data?: unknown[]; events?: unknown[] }).data ?? (data as { events?: unknown[] }).events ?? [];
    const ev = rows.filter((r): r is Record<string, unknown> => r != null && typeof r === "object");
    out.push(...ev);
    if (ev.length < limit) break;
  }
  return out;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const gammaLimit = Math.max(1, Number.parseInt(process.env.IDENTITY_BRIDGE_GAMMA_LIMIT ?? "200", 10));
  const gammaPages = Math.max(1, Number.parseInt(process.env.IDENTITY_BRIDGE_GAMMA_MAX_PAGES ?? "8", 10));
  const sampleEvents = Math.max(1, Number.parseInt(process.env.IDENTITY_BRIDGE_SAMPLE_EVENTS ?? "12", 10));
  const sampleSynced = Math.max(1, Number.parseInt(process.env.IDENTITY_BRIDGE_SAMPLE_SYNCED ?? "50", 10));

  const gammaEvents = await fetchGammaEvents(gammaLimit, gammaPages);
  const gammaMarkets: GammaMarketFlat[] = [];
  const gammaFieldKeys = new Map<string, number>();
  const gammaNestedKeys = new Map<string, number>();

  for (const ev of gammaEvents) {
    const eventId = pickString(ev, "id");
    const eventTitle = pickString(ev, "title");
    const eventSlug = pickString(ev, "slug");
    const markets = Array.isArray(ev.markets) ? ev.markets : [];
    for (const m of markets) {
      if (!m || typeof m !== "object") continue;
      const mm = m as Record<string, unknown>;
      for (const k of Object.keys(mm)) gammaFieldKeys.set(k, (gammaFieldKeys.get(k) ?? 0) + 1);
      for (const k of Object.keys(mm)) {
        const v = mm[k];
        if (v && typeof v === "object" && !Array.isArray(v)) {
          for (const sk of Object.keys(v as Record<string, unknown>)) {
            const nk = `${k}.${sk}`;
            gammaNestedKeys.set(nk, (gammaNestedKeys.get(nk) ?? 0) + 1);
          }
        }
      }

      const tokenIds = parseJsonArrayStrings(mm.clobTokenIds ?? mm.clob_token_ids);
      const outcomes = parseJsonArrayStrings(mm.outcomes);
      gammaMarkets.push({
        eventId,
        eventTitle,
        eventSlug,
        marketId: pickString(mm, "id"),
        marketSlug: pickString(mm, "slug"),
        question: pickString(mm, "question") ?? pickString(mm, "title"),
        conditionId: normalizeConditionId(mm.conditionId ?? mm.condition_id),
        clobTokenIdsRaw: typeof mm.clobTokenIds === "string" ? mm.clobTokenIds : null,
        tokenIds,
        outcomes,
        raw: mm,
      });
    }
  }

  const syncedMarkets = await prisma.syncedMarket.findMany({
    select: { id: true, conditionId: true, slug: true, title: true, raw: true },
    take: 5000,
    orderBy: { updatedAt: "desc" },
  });
  const syncedAssets = await prisma.syncedAsset.findMany({
    select: { syncedMarketId: true, tokenId: true, outcome: true },
    take: 20000,
  });
  const shadowRows = await prisma.shadowCandidate.findMany({
    select: { marketId: true, assetId: true, executionQualitySnapshotJson: true },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  const syncedCondExact = new Set(syncedMarkets.map((s) => s.conditionId).filter((x): x is string => !!x));
  const syncedCondNorm = new Set(syncedMarkets.map((s) => normalizeConditionId(s.conditionId)).filter((x): x is string => !!x));
  const syncedSlugExact = new Set(syncedMarkets.map((s) => s.slug));
  const syncedSlugNorm = new Set(syncedMarkets.map((s) => normalizeSlug(s.slug)).filter((x): x is string => !!x));
  const syncedTokenIds = new Set(syncedAssets.map((a) => a.tokenId));
  const syncedTitleStems = new Map<string, number>();
  for (const s of syncedMarkets) {
    const stem = normalizeTitleStem(s.title);
    if (stem) syncedTitleStems.set(stem, (syncedTitleStems.get(stem) ?? 0) + 1);
  }

  const gammaCondExact = new Set(gammaMarkets.map((g) => g.conditionId).filter((x): x is string => !!x));
  const gammaSlugExact = new Set(gammaMarkets.map((g) => g.marketSlug).filter((x): x is string => !!x));
  const gammaSlugNorm = new Set(gammaMarkets.map((g) => normalizeSlug(g.marketSlug)).filter((x): x is string => !!x));
  const gammaTokens = new Set(gammaMarkets.flatMap((g) => g.tokenIds));
  const gammaTitleStems = new Map<string, number>();
  for (const g of gammaMarkets) {
    const stem = normalizeTitleStem(g.question);
    if (stem) gammaTitleStems.set(stem, (gammaTitleStems.get(stem) ?? 0) + 1);
  }

  const condExactMatches = [...syncedCondExact].filter((x) => gammaCondExact.has(x)).length;
  const condNormMatches = [...syncedCondNorm].filter((x) => gammaCondExact.has(x)).length;
  const slugExactMatches = [...syncedSlugExact].filter((x) => gammaSlugExact.has(x)).length;
  const slugNormMatches = [...syncedSlugNorm].filter((x) => gammaSlugNorm.has(x)).length;
  const tokenIdMatches = [...syncedTokenIds].filter((x) => gammaTokens.has(x)).length;
  const titleStemMatches = [...syncedTitleStems.keys()].filter((x) => gammaTitleStems.has(x)).length;

  const bestBridge =
    tokenIdMatches > 0
      ? "tokenId <-> clobTokenIds"
      : condNormMatches > 0
        ? "conditionId"
        : slugNormMatches > 0
          ? "slug"
          : titleStemMatches > 0
            ? "normalized title stem (diagnostic only)"
            : "none";

  let conclusion = "identity bridge not available with current APIs";
  if (tokenIdMatches > 0) conclusion = "bridge requires token-level mapping";
  else if (condNormMatches > 0 || slugNormMatches > 0) conclusion = "Gamma contains matching IDs but we are not extracting them correctly";
  else if (titleStemMatches > 0) conclusion = "Gamma does not expose CLOB-level identifiers";

  const lines: string[] = [];
  lines.push("# Polymarket Identity Bridge Debug");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- SyncedMarket rows: ${syncedMarkets.length}`);
  lines.push(`- SyncedAsset rows: ${syncedAssets.length}`);
  lines.push(`- Gamma events fetched: ${gammaEvents.length}`);
  lines.push(`- Gamma event markets flattened: ${gammaMarkets.length}`);
  lines.push("");

  lines.push("## A. Deep Gamma inspection");
  lines.push(`- unique Gamma conditionIds: ${gammaCondExact.size}`);
  lines.push(`- unique Gamma slugs: ${gammaSlugExact.size}`);
  lines.push(`- unique Gamma clobTokenIds: ${gammaTokens.size}`);
  lines.push("Top Gamma market field keys:");
  for (const [k, c] of [...gammaFieldKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    lines.push(`- ${k}: ${c}`);
  }
  lines.push("Top Gamma nested keys:");
  for (const [k, c] of [...gammaNestedKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    lines.push(`- ${k}: ${c}`);
  }
  lines.push("");
  lines.push("| eventId | event title | market id | conditionId | slug | clobTokenIds count | outcomes count |");
  lines.push("| --- | --- | --- | --- | --- | ---: | ---: |");
  for (const g of gammaMarkets.slice(0, 80)) {
    lines.push(
      `| ${g.eventId ?? "-"} | ${(g.eventTitle ?? "-").replace(/\|/g, "/")} | ${g.marketId ?? "-"} | ${g.conditionId ?? "-"} | ${(g.marketSlug ?? "-").replace(/\|/g, "/")} | ${g.tokenIds.length} | ${g.outcomes.length} |`
    );
  }
  lines.push("");

  lines.push("## B. Deep SyncedMarket inspection");
  lines.push(`- unique Synced conditionIds: ${syncedCondExact.size}`);
  lines.push(`- unique Synced slugs: ${syncedSlugExact.size}`);
  lines.push(`- unique Synced tokenIds (SyncedAsset): ${syncedTokenIds.size}`);
  lines.push("| syncedMarketId | conditionId | slug | title | raw id hints |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const s of syncedMarkets.slice(0, sampleSynced)) {
    const raw = parseRaw(s.raw);
    const hints = [pickString(raw ?? {}, "id"), pickString(raw ?? {}, "marketId"), pickString(raw ?? {}, "eventId")]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `| ${s.id} | ${s.conditionId ?? "-"} | ${s.slug.replace(/\|/g, "/")} | ${s.title.replace(/\|/g, "/")} | ${hints || "-"} |`
    );
  }
  lines.push("");
  lines.push("Recent ShadowCandidate identifier sample (for CLOB-linked runtime context):");
  lines.push("| marketId | assetId | has executionQualitySnapshotJson |");
  lines.push("| --- | --- | --- |");
  for (const r of shadowRows.slice(0, 40)) {
    lines.push(`| ${r.marketId ?? "-"} | ${r.assetId} | ${r.executionQualitySnapshotJson ? "yes" : "no"} |`);
  }
  lines.push("");

  lines.push("## C/D. Attempted bridge candidates and match counts");
  lines.push("| attempted bridge | match count |");
  lines.push("| --- | ---: |");
  lines.push(`| conditionId exact | ${condExactMatches} |`);
  lines.push(`| conditionId normalized | ${condNormMatches} |`);
  lines.push(`| slug exact | ${slugExactMatches} |`);
  lines.push(`| slug normalized | ${slugNormMatches} |`);
  lines.push(`| tokenId (SyncedAsset.tokenId <-> Gamma clobTokenIds) | ${tokenIdMatches} |`);
  lines.push(`| normalized title stem (diagnostic only) | ${titleStemMatches} |`);
  lines.push("");

  lines.push("## E. Temporary title-based grouping (diagnostic only)");
  const titleGroups = [...syncedTitleStems.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  lines.push("| normalized title stem | synced group size | also in Gamma stems? |");
  lines.push("| --- | ---: | --- |");
  for (const [stem, c] of titleGroups) {
    lines.push(`| ${stem.replace(/\|/g, "/")} | ${c} | ${gammaTitleStems.has(stem) ? "yes" : "no"} |`);
  }
  lines.push("");

  lines.push("## F. Best candidate bridge");
  lines.push(`- ${bestBridge}`);
  lines.push("");
  lines.push("## G. Blunt conclusion");
  lines.push(`- ${conclusion}`);

  const outPath = path.join(process.cwd(), "diagnostics", "polymarket-identity-bridge-debug.md");
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

