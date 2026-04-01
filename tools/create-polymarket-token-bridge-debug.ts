import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";

type GammaMarketFlat = {
  eventTitle: string | null;
  eventSlug: string | null;
  marketTitle: string | null;
  marketSlug: string | null;
  tokenIdsRaw: string | null;
  tokenIds: string[];
};

type SyncedAssetRow = {
  syncedMarketId: string;
  tokenId: string;
  outcome: string;
  syncedMarket: { title: string; slug: string };
};

type MatchExample = {
  syncedTitle: string;
  syncedSlug: string;
  syncedTokenId: string;
  gammaEventTitle: string | null;
  gammaEventSlug: string | null;
  gammaTokenId: string;
};

function normalizeToken(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function normalizeTokenDigits(v: unknown): string {
  const s = normalizeToken(v);
  if (!s) return "";
  // Remove non-digits for defensive compare (if encoded oddly)
  const digits = s.replace(/[^0-9]/g, "");
  return digits || s;
}

function parseTokenArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return [];
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      // fallback: comma-separated or single token
      if (t.includes(",")) return t.split(",").map((x) => x.trim()).filter(Boolean);
      return [t.replace(/^\[|\]$/g, "").replace(/^"|"$/g, "").trim()].filter(Boolean);
    }
  }
  return [];
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

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const gammaLimit = Math.max(1, Number.parseInt(process.env.TOKEN_BRIDGE_GAMMA_LIMIT ?? "200", 10));
  const gammaPages = Math.max(1, Number.parseInt(process.env.TOKEN_BRIDGE_GAMMA_MAX_PAGES ?? "10", 10));

  const syncedAssets = (await prisma.syncedAsset.findMany({
    select: {
      syncedMarketId: true,
      tokenId: true,
      outcome: true,
      syncedMarket: { select: { title: true, slug: true } },
    },
    take: 50000,
  })) as SyncedAssetRow[];

  const totalSyncedAssets = syncedAssets.length;
  const nonNullSyncedTokens = syncedAssets.filter((a) => !!a.tokenId?.trim()).length;
  const syncedTokenSetExact = new Set(syncedAssets.map((a) => a.tokenId).filter((x) => !!x));
  const syncedTokenSetLower = new Set(syncedAssets.map((a) => normalizeToken(a.tokenId)).filter((x) => !!x));
  const syncedTokenSetDigits = new Set(syncedAssets.map((a) => normalizeTokenDigits(a.tokenId)).filter((x) => !!x));
  const syncedByTokenLower = new Map<string, SyncedAssetRow[]>();
  for (const a of syncedAssets) {
    const k = normalizeToken(a.tokenId);
    const arr = syncedByTokenLower.get(k) ?? [];
    arr.push(a);
    syncedByTokenLower.set(k, arr);
  }

  const gammaEvents = await fetchGammaEvents(gammaLimit, gammaPages);
  const gammaMarkets: GammaMarketFlat[] = [];
  for (const ev of gammaEvents) {
    const eventTitle = pickString(ev, "title");
    const eventSlug = pickString(ev, "slug");
    const markets = Array.isArray(ev.markets) ? ev.markets : [];
    for (const m of markets) {
      if (!m || typeof m !== "object") continue;
      const mm = m as Record<string, unknown>;
      const tokenIds = parseTokenArray(mm.clobTokenIds ?? mm.clob_token_ids);
      gammaMarkets.push({
        eventTitle,
        eventSlug,
        marketTitle: pickString(mm, "question") ?? pickString(mm, "title"),
        marketSlug: pickString(mm, "slug"),
        tokenIdsRaw: typeof mm.clobTokenIds === "string" ? mm.clobTokenIds : null,
        tokenIds,
      });
    }
  }

  const gammaWithTokens = gammaMarkets.filter((g) => g.tokenIds.length > 0);
  const gammaTokensFlat = gammaWithTokens.flatMap((g) => g.tokenIds);
  const gammaTokenSetExact = new Set(gammaTokensFlat);
  const gammaTokenSetLower = new Set(gammaTokensFlat.map((x) => normalizeToken(x)).filter(Boolean));
  const gammaTokenSetDigits = new Set(gammaTokensFlat.map((x) => normalizeTokenDigits(x)).filter(Boolean));

  const exactMatches = [...syncedTokenSetExact].filter((t) => gammaTokenSetExact.has(t)).length;
  const lowerMatches = [...syncedTokenSetLower].filter((t) => gammaTokenSetLower.has(t)).length;
  const digitsMatches = [...syncedTokenSetDigits].filter((t) => gammaTokenSetDigits.has(t)).length;

  const matchedSyncedAssetRows = syncedAssets.filter((a) => gammaTokenSetLower.has(normalizeToken(a.tokenId)));
  const matchedSyncedAssetIds = new Set(matchedSyncedAssetRows.map((a) => `${a.syncedMarketId}:${a.tokenId}`));
  const matchedSyncedMarketIds = new Set(matchedSyncedAssetRows.map((a) => a.syncedMarketId));
  const totalSyncedMarkets = new Set(syncedAssets.map((a) => a.syncedMarketId)).size;

  const gammaByTokenLower = new Map<string, GammaMarketFlat[]>();
  for (const g of gammaWithTokens) {
    for (const t of g.tokenIds) {
      const k = normalizeToken(t);
      const arr = gammaByTokenLower.get(k) ?? [];
      arr.push(g);
      gammaByTokenLower.set(k, arr);
    }
  }

  const examples: MatchExample[] = [];
  for (const [token, rows] of syncedByTokenLower.entries()) {
    const gm = gammaByTokenLower.get(token);
    if (!gm || gm.length === 0) continue;
    for (const s of rows) {
      const g = gm[0]!;
      examples.push({
        syncedTitle: s.syncedMarket.title,
        syncedSlug: s.syncedMarket.slug,
        syncedTokenId: s.tokenId,
        gammaEventTitle: g.eventTitle,
        gammaEventSlug: g.eventSlug,
        gammaTokenId: token,
      });
      if (examples.length >= 10) break;
    }
    if (examples.length >= 10) break;
  }

  const assetCoveragePct = totalSyncedAssets > 0 ? (matchedSyncedAssetIds.size / totalSyncedAssets) * 100 : 0;
  const marketCoveragePct = totalSyncedMarkets > 0 ? (matchedSyncedMarketIds.size / totalSyncedMarkets) * 100 : 0;

  let conclusion = "token bridge absent";
  if (matchedSyncedAssetIds.size > 0 && assetCoveragePct >= 20) conclusion = "token bridge exists and is usable";
  else if (matchedSyncedAssetIds.size > 0) conclusion = "token bridge exists but sparse";
  if (matchedSyncedAssetIds.size === 0 && gammaWithTokens.length === 0) conclusion = "evidence insufficient";

  const lines: string[] = [];
  lines.push("# Polymarket Token Bridge Debug");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push("");
  lines.push("## A. SyncedAsset side");
  lines.push(`- total SyncedAsset rows: ${totalSyncedAssets}`);
  lines.push(`- non-null tokenIds: ${nonNullSyncedTokens}`);
  lines.push(`- normalized token form: lowercase + trim`);
  lines.push(`- sample tokenIds: ${[...syncedTokenSetExact].slice(0, 12).join(", ")}`);
  lines.push("");
  lines.push("## B. Gamma side");
  lines.push(`- total Gamma markets flattened: ${gammaMarkets.length}`);
  lines.push(`- Gamma markets with clobTokenIds: ${gammaWithTokens.length}`);
  lines.push(`- total unique Gamma clobTokenIds: ${gammaTokenSetLower.size}`);
  lines.push(`- normalized token form: lowercase + trim (+ array parsing from clobTokenIds)`);
  lines.push(`- sample Gamma clobTokenIds: ${[...gammaTokenSetLower].slice(0, 12).join(", ")}`);
  lines.push("");
  lines.push("## C. Match counts");
  lines.push("| strategy | match count |");
  lines.push("| --- | ---: |");
  lines.push(`| exact tokenId | ${exactMatches} |`);
  lines.push(`| lowercase tokenId | ${lowerMatches} |`);
  lines.push(`| normalized digits/string representation | ${digitsMatches} |`);
  lines.push("");
  lines.push("## D. Coverage");
  lines.push(`- matched SyncedAssets: ${matchedSyncedAssetIds.size} / ${totalSyncedAssets} (${assetCoveragePct.toFixed(2)}%)`);
  lines.push(`- matched SyncedMarkets via assets: ${matchedSyncedMarketIds.size} / ${totalSyncedMarkets} (${marketCoveragePct.toFixed(2)}%)`);
  lines.push("");
  lines.push("## E. Example matched pairs");
  if (examples.length === 0) {
    lines.push("- no matched examples");
  } else {
    lines.push("| SyncedMarket title | SyncedMarket slug | SyncedAsset tokenId | Gamma event title | Gamma event slug | Gamma clobTokenId |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const e of examples) {
      lines.push(
        `| ${e.syncedTitle.replace(/\|/g, "/")} | ${e.syncedSlug.replace(/\|/g, "/")} | ${e.syncedTokenId} | ${(e.gammaEventTitle ?? "-").replace(/\|/g, "/")} | ${(e.gammaEventSlug ?? "-").replace(/\|/g, "/")} | ${e.gammaTokenId} |`
      );
    }
  }
  lines.push("");
  lines.push("## F. Blunt conclusion");
  lines.push(`- ${conclusion}`);

  const outPath = path.join(process.cwd(), "diagnostics", "polymarket-token-bridge-debug.md");
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

