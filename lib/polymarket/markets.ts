/**
 * Polymarket market sync: fetch from Gamma API, normalize, upsert SyncedMarket + SyncedAsset.
 * Read-only; no trading.
 */

import { prisma } from "@/lib/db";
import type { GammaMarket, NormalizedMarket, NormalizedAsset } from "@/types/polymarket";
import { gammaMarketSchema, gammaMarketsResponseSchema } from "@/types/polymarket";

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";

/** Status-related keys we inspect for raw diagnostics (lowercase for case-insensitive check). */
const STATUS_KEYS = [
  "id",
  "slug",
  "question",
  "title",
  "active",
  "closed",
  "archived",
  "acceptingOrders",
  "enableOrderBook",
  "endDate",
  "endDateIso",
  "end_date",
  "startDate",
  "start_date",
  "closedTime",
  "resolved",
];

type RawMarket = Record<string, unknown>;
type RawEvent = Record<string, unknown>;

interface EventGroupingMeta {
  eventId: string | null;
  groupKey: string | null;
  groupTitle: string | null;
}

/** Fetch raw JSON array from Gamma API (no schema parse). Returns empty array on parse failure. */
async function fetchGammaMarketsPageRaw(
  limit: number,
  offset: number,
  activeOnly: boolean = true
): Promise<RawMarket[]> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (activeOnly) {
    params.set("active", "true");
    params.set("closed", "false");
  }
  const url = `${GAMMA_API_BASE}/markets?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Gamma API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const raw = Array.isArray(data)
    ? data
    : (data as { data?: unknown[]; markets?: unknown[] }).data ??
      (data as { markets?: unknown[] }).markets ??
      [];
  return raw.filter((r): r is RawMarket => r != null && typeof r === "object");
}

/** Default: fetch only active (tradable) markets. Returns parsed GammaMarket[]; use first-page raw for diagnostics elsewhere. */
async function fetchGammaMarketsPage(
  limit: number,
  offset: number,
  activeOnly: boolean = true
): Promise<GammaMarket[]> {
  const raw = await fetchGammaMarketsPageRaw(limit, offset, activeOnly);
  const parsed = gammaMarketsResponseSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data;
}

function normalizeConditionIdLike(value: unknown): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (t.startsWith("0x")) return t;
  if (/^[0-9a-f]{64}$/.test(t)) return `0x${t}`;
  return raw;
}

function pickString(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function deriveGroupKeyFromEvent(rawEvent: RawEvent): { groupKey: string | null; groupTitle: string | null } {
  const eventId = pickString(rawEvent, "id");
  const eventTitle = pickString(rawEvent, "title");
  const seriesRaw = rawEvent.series;
  let seriesId: string | null = null;
  let seriesTitle: string | null = null;
  if (Array.isArray(seriesRaw) && seriesRaw.length > 0 && typeof seriesRaw[0] === "object" && seriesRaw[0] != null) {
    const s = seriesRaw[0] as Record<string, unknown>;
    seriesId = pickString(s, "id");
    seriesTitle = pickString(s, "title");
  }
  if (seriesId) return { groupKey: `series:${seriesId}`, groupTitle: seriesTitle ?? eventTitle };
  if (eventId) return { groupKey: `event:${eventId}`, groupTitle: eventTitle };
  return { groupKey: null, groupTitle: eventTitle };
}

async function fetchGammaEventsPageRaw(limit: number, offset: number): Promise<RawEvent[]> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const url = `${GAMMA_API_BASE}/events?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Gamma events API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const rows = Array.isArray(data)
    ? data
    : (data as { data?: unknown[]; events?: unknown[] }).data ?? (data as { events?: unknown[] }).events ?? [];
  return rows.filter((r): r is RawEvent => r != null && typeof r === "object");
}

export async function buildEventGroupingMaps(opts?: {
  limit?: number;
  maxPages?: number;
}): Promise<{ byConditionId: Map<string, EventGroupingMeta>; bySlug: Map<string, EventGroupingMeta>; errors: string[] }> {
  const byConditionId = new Map<string, EventGroupingMeta>();
  const bySlug = new Map<string, EventGroupingMeta>();
  const errors: string[] = [];
  const limit = Math.max(1, opts?.limit ?? 200);
  const maxPages = Math.max(1, opts?.maxPages ?? 20);

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    let events: RawEvent[] = [];
    try {
      events = await fetchGammaEventsPageRaw(limit, offset);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Failed to fetch Gamma events");
      break;
    }
    if (events.length === 0) break;

    for (const ev of events) {
      const eventId = pickString(ev, "id");
      const eventSlug = pickString(ev, "slug");
      const group = deriveGroupKeyFromEvent(ev);
      const meta: EventGroupingMeta = {
        eventId,
        groupKey: group.groupKey,
        groupTitle: group.groupTitle,
      };
      if (eventSlug) bySlug.set(eventSlug, meta);

      const markets = Array.isArray(ev.markets) ? ev.markets : [];
      for (const mk of markets) {
        if (!mk || typeof mk !== "object") continue;
        const m = mk as Record<string, unknown>;
        const conditionId = normalizeConditionIdLike(m.conditionId ?? m.condition_id);
        if (conditionId) byConditionId.set(conditionId, meta);
        const marketSlug = pickString(m, "slug");
        if (marketSlug) bySlug.set(marketSlug, meta);
      }
    }

    if (events.length < limit) break;
  }

  return { byConditionId, bySlug, errors };
}

function parseEndDate(value: string | null | undefined): Date | null {
  if (value == null || typeof value !== "string" || value.trim() === "") return null;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseEndDateFromUnknown(value: unknown): Date | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() !== "") return parseEndDate(value);
  if (typeof value === "number" && !Number.isNaN(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toBool(v: unknown): boolean {
  if (v === true || v === "true" || v === 1) return true;
  if (v === false || v === "false" || v === 0) return false;
  return false;
}

export interface NormalizeMarketStatusResult {
  status: "active" | "inactive" | "closed";
  endDate: Date | null;
  endDateIso: string | null;
  reasons: string[];
}

/**
 * Normalize market status from raw upstream payload. Uses actual field names and fallbacks.
 * Returns status, endDate, and short reasoning strings for debugging.
 */
export function normalizeMarketStatus(rawMarket: RawMarket): NormalizeMarketStatusResult {
  const reasons: string[] = [];
  const closed = toBool(rawMarket.closed);
  const active = toBool(rawMarket.active);
  const archived = toBool(rawMarket.archived);
  const acceptingOrders = toBool(rawMarket.acceptingOrders);

  const endDateRaw =
    rawMarket.endDate ??
    rawMarket.endDateIso ??
    (rawMarket as Record<string, unknown>).end_date ??
    null;
  const endDate = parseEndDateFromUnknown(endDateRaw);
  const endDateIso = endDate ? endDate.toISOString() : null;
  const now = Date.now();

  if (closed && endDate != null && endDate.getTime() <= now) {
    reasons.push("closed===true and endDate in past");
    return { status: "closed", endDate, endDateIso, reasons };
  }
  if (closed && (endDate == null || endDate.getTime() > now)) {
    reasons.push("closed===true but endDate future or null -> treat as active");
    return { status: "active", endDate, endDateIso, reasons };
  }
  if (active) {
    reasons.push("active===true");
    return { status: "active", endDate, endDateIso, reasons };
  }
  if (archived) {
    reasons.push("archived===true");
    return { status: "closed", endDate, endDateIso, reasons };
  }
  if (acceptingOrders) {
    reasons.push("acceptingOrders===true");
    return { status: "active", endDate, endDateIso, reasons };
  }
  if (active === false && closed === false) {
    reasons.push("active=false,closed=false");
    if (endDate == null || endDate.getTime() > now) {
      reasons.push("endDate future or null -> active");
      return { status: "active", endDate, endDateIso, reasons };
    }
    return { status: "inactive", endDate, endDateIso, reasons };
  }
  if (endDate == null || endDate.getTime() > now) {
    reasons.push("no active/closed; endDate future or null -> active");
    return { status: "active", endDate, endDateIso, reasons };
  }
  reasons.push("no active/closed; endDate in past -> inactive");
  return { status: "inactive", endDate, endDateIso, reasons };
}

function normalizeGammaMarket(row: GammaMarket): { market: NormalizedMarket; assets: NormalizedAsset[] } {
  const title = row.question ?? "";
  const raw = row as unknown as RawMarket;
  const { status, endDateIso, reasons: _reasons } = normalizeMarketStatus(raw);
  const endDateParsed = parseEndDateFromUnknown(
    row.endDate ?? row.endDateIso ?? (row as Record<string, unknown>).end_date ?? null
  );
  const endDateIsoFinal = endDateIso ?? (endDateParsed ? endDateParsed.toISOString() : null);

  const conditionIdRaw = row.conditionId != null ? String(row.conditionId).trim() : null;
  const conditionId = conditionIdRaw
    ? (() => {
        const t = conditionIdRaw.toLowerCase();
        if (t.startsWith("0x")) return t;
        if (/^[0-9a-f]{64}$/.test(t)) return "0x" + t;
        return conditionIdRaw;
      })()
    : null;
  const slug = row.slug != null ? String(row.slug).trim() : null;
  const category = row.category ?? null;
  const volumeNum = row.volumeNum ?? null;
  const liquidityNum = row.liquidityNum ?? null;
  const eventIdDirect = pickString(raw, "eventId") ?? pickString(raw, "event_id");
  const groupIdDirect = pickString(raw, "groupId") ?? pickString(raw, "group_id");
  const seriesIdDirect = pickString(raw, "seriesId") ?? pickString(raw, "series_id");
  const directGroupKey = seriesIdDirect ? `series:${seriesIdDirect}` : groupIdDirect ? `group:${groupIdDirect}` : eventIdDirect ? `event:${eventIdDirect}` : null;

  let outcomes: string[] = [];
  let outcomePrices: string[] = [];
  let tokenIds: string[] = [];
  try {
    if (row.outcomes) outcomes = JSON.parse(row.outcomes) as string[];
    if (row.outcomePrices) outcomePrices = JSON.parse(row.outcomePrices) as string[];
    if (row.clobTokenIds) tokenIds = JSON.parse(row.clobTokenIds) as string[];
  } catch {
    // ignore parse errors
  }

  // Normalize tokenId to string and trim so CLOB/fill assetId lookups match (avoid format mismatch).
  const assets: NormalizedAsset[] = tokenIds.map((tid, i) => ({
    tokenId: String(tid).trim(),
    outcome: outcomes[i] ?? `Outcome ${i}`,
    outcomeIndex: i,
  }));

  if (assets.length === 0 && outcomes.length > 0) {
    outcomes.forEach((outcome, i) => {
      assets.push({ tokenId: `unknown-${i}`, outcome, outcomeIndex: i });
    });
  }

  const market: NormalizedMarket = {
    conditionId,
    eventId: eventIdDirect,
    groupKey: directGroupKey,
    groupTitle: null,
    slug,
    title,
    status,
    endDate: endDateIsoFinal,
    category,
    volumeNum,
    liquidityNum,
    raw: row as unknown as Record<string, unknown>,
  };
  return { market, assets };
}

export interface RawFieldDiagnostics {
  activeTrue: number;
  activeFalse: number;
  closedTrue: number;
  closedFalse: number;
  archivedTrue: number;
  acceptingOrdersTrue: number;
  endDatePresent: number;
  endDateIsoPresent: number;
  end_datePresent: number;
}

export interface SyncMarketsDiagnostics {
  fetchedRawMarkets: number;
  syncedMarkets: number;
  activeCount: number;
  inactiveCount: number;
  closedCount: number;
  nullStatusCount: number;
  futureEndDateCount: number;
  nullEndDateCount: number;
  expiredEndDateCount: number;
  tradableCountAfterNormalization: number;
  rawFieldDiagnostics?: RawFieldDiagnostics;
  sampleRawMarkets?: Record<string, unknown>[];
  sampleNormalizedMarkets?: { status: string; endDate: string | null; slug: string | null; reasons?: string[] }[];
  groupingMetaCoverage?: {
    byConditionIdCount: number;
    bySlugCount: number;
    upsertedWithEventId: number;
    upsertedWithGroupKey: number;
    eventFetchErrors: number;
  };
}

export interface SyncMarketsResult {
  synced: number;
  errors: string[];
  diagnostics?: SyncMarketsDiagnostics;
}

const TRADABLE_END_DATE_DAYS = 30;
const SAMPLE_SIZE = 5;

function buildRawFieldDiagnostics(rawMarkets: RawMarket[]): RawFieldDiagnostics {
  let activeTrue = 0,
    activeFalse = 0,
    closedTrue = 0,
    closedFalse = 0,
    archivedTrue = 0,
    acceptingOrdersTrue = 0,
    endDatePresent = 0,
    endDateIsoPresent = 0,
    end_datePresent = 0;
  for (const r of rawMarkets) {
    if (toBool(r.active)) activeTrue++;
    else if (r.active !== undefined && r.active !== null) activeFalse++;
    if (toBool(r.closed)) closedTrue++;
    else if (r.closed !== undefined && r.closed !== null) closedFalse++;
    if (toBool(r.archived)) archivedTrue++;
    if (toBool(r.acceptingOrders)) acceptingOrdersTrue++;
    if (r.endDate != null && String(r.endDate).trim() !== "") endDatePresent++;
    if (r.endDateIso != null && String(r.endDateIso).trim() !== "") endDateIsoPresent++;
    if ((r as Record<string, unknown>).end_date != null && String((r as Record<string, unknown>).end_date).trim() !== "")
      end_datePresent++;
  }
  return {
    activeTrue,
    activeFalse,
    closedTrue,
    closedFalse,
    archivedTrue,
    acceptingOrdersTrue,
    endDatePresent,
    endDateIsoPresent,
    end_datePresent,
  };
}

function buildSampleRawMarkets(rawMarkets: RawMarket[], n: number): Record<string, unknown>[] {
  return rawMarkets.slice(0, n).map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of STATUS_KEYS) {
      if (r[k] !== undefined) out[k] = r[k];
    }
    if (Object.keys(out).length === 0) {
      Object.keys(r).forEach((key) => {
        if (
          /active|closed|endDate|end_date|archived|order|slug|question|title|id/i.test(key)
        )
          out[key] = r[key];
      });
    }
    return out;
  });
}

function buildSampleNormalizedMarkets(
  rawMarkets: RawMarket[],
  n: number
): { status: string; endDate: string | null; slug: string | null; reasons?: string[] }[] {
  return rawMarkets.slice(0, n).map((r) => {
    const { status, endDateIso, reasons } = normalizeMarketStatus(r);
    const slugRaw = r.slug ?? (r as Record<string, unknown>).slug;
    const slug = slugRaw != null && typeof slugRaw === "string" ? slugRaw : null;
    return {
      status,
      endDate: endDateIso,
      slug,
      reasons,
    };
  });
}

/**
 * Fetch markets from Gamma API and upsert SyncedMarket + SyncedAsset.
 * By default fetches only active (tradable) markets. Set activeOnly: false for historical backfill.
 */
export async function syncMarkets(opts?: {
  limit?: number;
  offset?: number;
  maxPages?: number;
  activeOnly?: boolean;
}): Promise<SyncMarketsResult> {
  const limit = opts?.limit ?? 100;
  const maxPages = opts?.maxPages ?? 5;
  const activeOnly = opts?.activeOnly !== false;
  const errors: string[] = [];
  let synced = 0;
  let fetchedRawMarkets = 0;
  let rawFieldDiagnostics: RawFieldDiagnostics | undefined;
  let sampleRawMarkets: Record<string, unknown>[] | undefined;
  let sampleNormalizedMarkets: { status: string; endDate: string | null; slug: string | null; reasons?: string[] }[] | undefined;
  let upsertedWithEventId = 0;
  let upsertedWithGroupKey = 0;
  const groupingMaps = await buildEventGroupingMaps();
  errors.push(...groupingMaps.errors);

  for (let page = 0; page < maxPages; page++) {
    const offset = (opts?.offset ?? 0) + page * limit;
    let rawRows: RawMarket[];
    try {
      rawRows = await fetchGammaMarketsPageRaw(limit, offset, activeOnly);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Failed to fetch markets");
      break;
    }
    fetchedRawMarkets += rawRows.length;
    if (rawRows.length === 0) break;

    if (page === 0) {
      rawFieldDiagnostics = buildRawFieldDiagnostics(rawRows);
      sampleRawMarkets = buildSampleRawMarkets(rawRows, SAMPLE_SIZE);
      sampleNormalizedMarkets = buildSampleNormalizedMarkets(rawRows, SAMPLE_SIZE);
    }

    const parsed = gammaMarketsResponseSchema.safeParse(rawRows);
    const rows: GammaMarket[] = parsed.success ? parsed.data : [];
    if (!parsed.success && rawRows.length > 0) {
      errors.push("First page schema parse failed; check Gamma response shape");
    }

    for (const row of rows) {
      try {
        const { market: norm, assets } = normalizeGammaMarket(row);
        const slugKey = norm.slug ?? norm.conditionId ?? `market-${row.id}`;
        const endDate = norm.endDate ? new Date(norm.endDate) : null;
        const byCondition = norm.conditionId ? groupingMaps.byConditionId.get(norm.conditionId) : undefined;
        const bySlug = norm.slug ? groupingMaps.bySlug.get(norm.slug) : undefined;
        const grouping = byCondition ??
          bySlug ??
          (norm.eventId || norm.groupKey
            ? { eventId: norm.eventId ?? null, groupKey: norm.groupKey ?? null, groupTitle: norm.groupTitle ?? null }
            : null);
        if (grouping?.eventId) upsertedWithEventId++;
        if (grouping?.groupKey) upsertedWithGroupKey++;

        const created = await prisma.syncedMarket.upsert({
          where: { slug: slugKey },
          create: {
            conditionId: norm.conditionId ?? undefined,
            eventId: grouping?.eventId ?? undefined,
            groupKey: grouping?.groupKey ?? undefined,
            groupTitle: grouping?.groupTitle ?? undefined,
            slug: slugKey,
            title: norm.title,
            status: norm.status,
            endDate,
            category: norm.category ?? undefined,
            volumeNum: norm.volumeNum ?? undefined,
            liquidityNum: norm.liquidityNum ?? undefined,
            raw: norm.raw ? JSON.stringify(norm.raw) : undefined,
          },
          update: {
            conditionId: norm.conditionId ?? undefined,
            eventId: grouping?.eventId ?? undefined,
            groupKey: grouping?.groupKey ?? undefined,
            groupTitle: grouping?.groupTitle ?? undefined,
            title: norm.title,
            status: norm.status,
            endDate,
            category: norm.category ?? undefined,
            volumeNum: norm.volumeNum ?? undefined,
            liquidityNum: norm.liquidityNum ?? undefined,
            raw: norm.raw ? JSON.stringify(norm.raw) : undefined,
          },
        });

        for (const asset of assets) {
          await prisma.syncedAsset.upsert({
            where: {
              syncedMarketId_tokenId: { syncedMarketId: created.id, tokenId: asset.tokenId },
            },
            create: {
              syncedMarketId: created.id,
              tokenId: asset.tokenId,
              outcome: asset.outcome,
              outcomeIndex: asset.outcomeIndex,
            },
            update: {
              outcome: asset.outcome,
              outcomeIndex: asset.outcomeIndex,
            },
          });
        }
        synced++;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : "Upsert failed");
      }
    }
    if (rows.length < limit) break;
  }

  const now = new Date();
  const tradableCutoff = new Date(now.getTime() - TRADABLE_END_DATE_DAYS * 24 * 60 * 60 * 1000);

  const [activeCount, inactiveCount, closedCount, nullStatusCount, allMarkets] = await Promise.all([
    prisma.syncedMarket.count({ where: { status: "active" } }),
    prisma.syncedMarket.count({ where: { status: "inactive" } }),
    prisma.syncedMarket.count({ where: { status: "closed" } }),
    prisma.syncedMarket.count({ where: { status: null } }),
    prisma.syncedMarket.findMany({
      select: { status: true, endDate: true },
    }),
  ]);

  let futureEndDateCount = 0;
  let nullEndDateCount = 0;
  let expiredEndDateCount = 0;
  for (const m of allMarkets) {
    if (m.endDate == null) nullEndDateCount++;
    else {
      const t = m.endDate.getTime();
      if (t > now.getTime()) futureEndDateCount++;
      else expiredEndDateCount++;
    }
  }

  const tradableCountAfterNormalization = await prisma.syncedMarket.count({
    where: {
      status: { not: "closed" },
      OR: [{ endDate: null }, { endDate: { gte: tradableCutoff } }],
    },
  });

  const diagnostics: SyncMarketsDiagnostics = {
    fetchedRawMarkets,
    syncedMarkets: synced,
    activeCount,
    inactiveCount,
    closedCount,
    nullStatusCount,
    futureEndDateCount,
    nullEndDateCount,
    expiredEndDateCount,
    tradableCountAfterNormalization,
    rawFieldDiagnostics,
    sampleRawMarkets,
    sampleNormalizedMarkets,
    groupingMetaCoverage: {
      byConditionIdCount: groupingMaps.byConditionId.size,
      bySlugCount: groupingMaps.bySlug.size,
      upsertedWithEventId,
      upsertedWithGroupKey,
      eventFetchErrors: groupingMaps.errors.length,
    },
  };

  return { synced, errors, diagnostics };
}

// ---------------------------------------------------------------------------
// Targeted backfill for held positions (conditionIds from UserFill).
// Upstream: Gamma API supports GET /markets?condition_ids=<id> and returns
// one market or []. Exact lookup by conditionId; no slug/market id needed.
// Fallback if condition_ids were unavailable: paginate GET /markets and
// filter by conditionId in memory (expensive); exact lookup is preferred.
// ---------------------------------------------------------------------------

/** Fetch one market by conditionId from Gamma. Returns null if not found or parse fails. */
async function fetchGammaMarketByConditionId(conditionId: string): Promise<GammaMarket | null> {
  const trimmed = conditionId.trim();
  if (!trimmed) return null;
  const url = `${GAMMA_API_BASE}/markets?condition_ids=${encodeURIComponent(trimmed)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  const arr = Array.isArray(data) ? data : (data as { data?: unknown[] })?.data ?? [];
  const raw = arr[0];
  if (!raw || typeof raw !== "object") return null;
  const parsed = gammaMarketSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Upsert a single SyncedMarket + SyncedAsset rows from a Gamma market row. Returns created/updated market id. */
async function upsertOneMarketFromGammaRow(
  row: GammaMarket,
  groupingMaps?: { byConditionId: Map<string, EventGroupingMeta>; bySlug: Map<string, EventGroupingMeta> }
): Promise<{ marketId: string; assetCount: number }> {
  const { market: norm, assets } = normalizeGammaMarket(row);
  const slugKey = norm.slug ?? norm.conditionId ?? `market-${row.id}`;
  const endDate = norm.endDate ? new Date(norm.endDate) : null;
  const byCondition = groupingMaps && norm.conditionId ? groupingMaps.byConditionId.get(norm.conditionId) : undefined;
  const bySlug = groupingMaps && norm.slug ? groupingMaps.bySlug.get(norm.slug) : undefined;
  const grouping = byCondition ??
    bySlug ??
    (norm.eventId || norm.groupKey
      ? { eventId: norm.eventId ?? null, groupKey: norm.groupKey ?? null, groupTitle: norm.groupTitle ?? null }
      : null);

  const created = await prisma.syncedMarket.upsert({
    where: { slug: slugKey },
    create: {
      conditionId: norm.conditionId ?? undefined,
      eventId: grouping?.eventId ?? undefined,
      groupKey: grouping?.groupKey ?? undefined,
      groupTitle: grouping?.groupTitle ?? undefined,
      slug: slugKey,
      title: norm.title,
      status: norm.status,
      endDate,
      category: norm.category ?? undefined,
      volumeNum: norm.volumeNum ?? undefined,
      liquidityNum: norm.liquidityNum ?? undefined,
      raw: norm.raw ? JSON.stringify(norm.raw) : undefined,
    },
    update: {
      conditionId: norm.conditionId ?? undefined,
      eventId: grouping?.eventId ?? undefined,
      groupKey: grouping?.groupKey ?? undefined,
      groupTitle: grouping?.groupTitle ?? undefined,
      title: norm.title,
      status: norm.status,
      endDate,
      category: norm.category ?? undefined,
      volumeNum: norm.volumeNum ?? undefined,
      liquidityNum: norm.liquidityNum ?? undefined,
      raw: norm.raw ? JSON.stringify(norm.raw) : undefined,
    },
  });

  for (const asset of assets) {
    await prisma.syncedAsset.upsert({
      where: {
        syncedMarketId_tokenId: { syncedMarketId: created.id, tokenId: asset.tokenId },
      },
      create: {
        syncedMarketId: created.id,
        tokenId: asset.tokenId,
        outcome: asset.outcome,
        outcomeIndex: asset.outcomeIndex,
      },
      update: {
        outcome: asset.outcome,
        outcomeIndex: asset.outcomeIndex,
      },
    });
  }

  return { marketId: created.id, assetCount: assets.length };
}

export interface BackfillHeldMarketsResult {
  funderAddress: string;
  distinctHeldConditionIds: number;
  alreadyPresent: number;
  fetched: number;
  upsertedMarkets: number;
  upsertedAssets: number;
  stillMissing: number;
  errors: string[];
}

/**
 * Backfill SyncedMarket + SyncedAsset for conditionIds the funder holds (from UserFill.market)
 * that are not already in the catalog. Uses Gamma GET /markets?condition_ids=<id> per conditionId.
 * Normalization matches the resolution pipeline (normalizeConditionId).
 */
export async function backfillHeldMarkets(funderAddress: string): Promise<BackfillHeldMarketsResult> {
  const { normalizeConditionId } = await import("@/lib/polymarket/portfolio");
  const funder = funderAddress.trim().toLowerCase();
  const errors: string[] = [];

  const fills = await prisma.userFill.findMany({
    where: { funderAddress: funder },
    select: { market: true },
    distinct: ["market"],
  });

  const rawConditionIds = fills.map((f) => f.market?.trim()).filter(Boolean) as string[];
  const normalizedSet = new Map<string, string>();
  for (const id of rawConditionIds) {
    const norm = normalizeConditionId(id);
    if (norm) normalizedSet.set(norm, id);
  }
  const distinctHeldConditionIds = normalizedSet.size;

  if (distinctHeldConditionIds === 0) {
    return {
      funderAddress: funder,
      distinctHeldConditionIds: 0,
      alreadyPresent: 0,
      fetched: 0,
      upsertedMarkets: 0,
      upsertedAssets: 0,
      stillMissing: 0,
      errors: [],
    };
  }

  const heldConditionIds = Array.from(normalizedSet.keys());

  const existing = await prisma.syncedMarket.findMany({
    where: { conditionId: { in: heldConditionIds } },
    select: { conditionId: true },
  });
  const existingSet = new Set(existing.map((m) => m.conditionId).filter(Boolean));
  const alreadyPresent = existingSet.size;

  const missingConditionIds = heldConditionIds.filter((id) => !existingSet.has(id));

  let fetched = 0;
  let upsertedMarkets = 0;
  let upsertedAssets = 0;
  const groupingMaps = await buildEventGroupingMaps();
  errors.push(...groupingMaps.errors);

  for (const conditionId of missingConditionIds) {
    try {
      const row = await fetchGammaMarketByConditionId(conditionId);
      if (!row) {
        errors.push(`Gamma returned no market for conditionId ${conditionId.slice(0, 18)}…`);
        continue;
      }
      fetched++;
      const { marketId: _mid, assetCount } = await upsertOneMarketFromGammaRow(row, groupingMaps);
      upsertedMarkets += 1;
      upsertedAssets += assetCount;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : `Backfill failed for ${conditionId.slice(0, 18)}…`);
    }
  }

  const stillMissing = missingConditionIds.length - fetched;

  return {
    funderAddress: funder,
    distinctHeldConditionIds,
    alreadyPresent,
    fetched,
    upsertedMarkets,
    upsertedAssets,
    stillMissing,
    errors,
  };
}
