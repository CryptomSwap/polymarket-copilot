/**
 * Read-only: quantify execution-policy concentration blocks (market/theme) from ledger + signals.
 * Theme/category for runtime_automated: recommendationId join → metadataJson.linkage → resolveRuntimeIntentRecommendationLink.
 * Writes diagnostics/v2-concentration-block-audit.md — no trading/risk logic changes.
 */
import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../lib/db";
import { resolveRuntimeIntentRecommendationLink } from "../lib/runtime/intent-recommendation-link";

const BANDS = ["<0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.6", "0.6-0.8", "0.8-0.9", ">=0.9"] as const;
type BandKey = (typeof BANDS)[number] | "unknown";

function lookbackDate(): Date {
  const h = Number(process.env.CONCENTRATION_AUDIT_LOOKBACK_HOURS ?? "24");
  const hours = Number.isFinite(h) && h > 0 && h <= 720 ? h : 24;
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function classifyShadowBandFromLimitPrice(limitPrice: string | null | undefined): BandKey {
  const p = parseNum(limitPrice);
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

function parseJson<T>(raw: string | null | undefined): T | null {
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

type PolicyBlockPayload = { blockingReasons?: string[] };
type ReadyPayload = {
  concentrationSoftened?: boolean;
  softenedReasons?: string[];
  originalWouldBlock?: boolean;
  operationalHardBlock?: boolean;
};

function parseBlockingReasons(payloadJson: string | null | undefined): string[] {
  const o = parseJson<PolicyBlockPayload>(payloadJson);
  if (!o?.blockingReasons || !Array.isArray(o.blockingReasons)) return [];
  return o.blockingReasons.filter((x): x is string => typeof x === "string");
}

function parseReadyPayload(payloadJson: string | null | undefined): ReadyPayload {
  const o = parseJson<ReadyPayload>(payloadJson);
  return {
    concentrationSoftened: o?.concentrationSoftened === true,
    softenedReasons: Array.isArray(o?.softenedReasons)
      ? o!.softenedReasons!.filter((x): x is string => typeof x === "string")
      : [],
    originalWouldBlock: o?.originalWouldBlock === true,
    operationalHardBlock: o?.operationalHardBlock === true,
  };
}

/** Flatten "a; b" style entries into tokens. */
function expandReasonTokens(reasons: string[]): string[] {
  const out: string[] = [];
  for (const r of reasons) {
    for (const part of r.split(";").map((x) => x.trim()).filter(Boolean)) {
      out.push(part);
    }
  }
  return out;
}

function tokenHasMarketConc(t: string): boolean {
  const s = t.toLowerCase();
  return s.includes("single_market_concentration") || s.includes("market_concentration_breach");
}

function tokenHasThemeConc(t: string): boolean {
  const s = t.toLowerCase();
  return s.includes("single_theme_concentration") || s.includes("theme_concentration_breach");
}

function tokenHasRuntimeSafety(t: string): boolean {
  return t.toLowerCase().includes("runtime_safety_blocked");
}

type DecisionSnap = {
  strategyVariant?: string;
  hypothesisType?: string;
  strategyFamily?: string;
};

function parseStrategyProxy(decisionSnapshotJson: string | null | undefined): string {
  const d = parseJson<DecisionSnap>(decisionSnapshotJson);
  if (!d) return "unknown";
  const v = d.strategyVariant;
  if (typeof v === "string" && v.trim()) return v.trim();
  const h = d.hypothesisType;
  if (typeof h === "string" && h.trim()) return `hypothesis:${h.trim()}`;
  return "unknown";
}

function topNShare(counts: Map<string, number>, total: number, n: number): number {
  if (total <= 0) return 0;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  let sum = 0;
  for (let i = 0; i < Math.min(n, sorted.length); i++) sum += sorted[i]![1];
  return sum / total;
}

function parseLinkage(metadataJson: string | null): { theme?: string; category?: string } | null {
  if (!metadataJson?.trim()) return null;
  try {
    const o = JSON.parse(metadataJson) as { linkage?: { theme?: string; category?: string } };
    return o?.linkage && typeof o.linkage === "object" ? o.linkage : null;
  } catch {
    return null;
  }
}

function isUsableTheme(t: string | null | undefined): boolean {
  const s = (t ?? "").trim();
  return s.length > 0 && s !== "unknown_theme";
}

type RecoSignal = { theme: string; category: string };

type IntentForTheme = {
  recommendationId: string | null;
  metadataJson: string | null;
  funderAddress: string;
  marketId: string;
  outcome: string;
};

function resolverCacheKey(intent: IntentForTheme): string {
  return JSON.stringify([
    intent.funderAddress.toLowerCase().trim(),
    intent.marketId?.trim() ?? "",
    intent.outcome?.trim() ?? "",
  ]);
}

/** One DB round-trip per unique key that still needs resolver after join + metadata. */
async function warmResolverCache(
  intents: IntentForTheme[],
  recoById: Map<string, { marketSignal: RecoSignal | null }>,
  resolverCache: Map<string, Awaited<ReturnType<typeof resolveRuntimeIntentRecommendationLink>>>
): Promise<void> {
  const pending = new Map<string, IntentForTheme>();
  for (const intent of intents) {
    const reco = intent.recommendationId ? recoById.get(intent.recommendationId) : undefined;
    const joinTheme = reco?.marketSignal?.theme?.trim() ?? "";
    if (isUsableTheme(joinTheme)) continue;
    const meta = parseLinkage(intent.metadataJson);
    if (isUsableTheme(meta?.theme?.trim())) continue;
    const k = resolverCacheKey(intent);
    if (!resolverCache.has(k)) pending.set(k, intent);
  }
  for (const intent of pending.values()) {
    const k = resolverCacheKey(intent);
    const link = await resolveRuntimeIntentRecommendationLink({
      funderAddress: intent.funderAddress,
      marketId: intent.marketId,
      outcome: intent.outcome,
    });
    resolverCache.set(k, link);
  }
}

function resolveRuntimeAutomatedThemeCategorySync(
  intent: IntentForTheme,
  recoById: Map<string, { marketSignal: RecoSignal | null }>,
  resolverCache: Map<string, Awaited<ReturnType<typeof resolveRuntimeIntentRecommendationLink>>>
): { theme: string; category: string; unknownTheme: boolean } {
  const reco = intent.recommendationId ? recoById.get(intent.recommendationId) : undefined;
  const joinTheme = reco?.marketSignal?.theme?.trim() ?? "";
  const joinCat = reco?.marketSignal?.category?.trim() ?? "";
  if (isUsableTheme(joinTheme)) {
    return { theme: joinTheme, category: joinCat || "unknown_category", unknownTheme: false };
  }
  const meta = parseLinkage(intent.metadataJson);
  const metaTheme = meta?.theme?.trim() ?? "";
  const metaCat = meta?.category?.trim() ?? "";
  if (isUsableTheme(metaTheme)) {
    return { theme: metaTheme, category: metaCat || "unknown_category", unknownTheme: false };
  }
  const link = resolverCache.get(resolverCacheKey(intent)) ?? null;
  const resTheme = link?.theme?.trim() ?? "";
  const resCat = link?.category?.trim() ?? "";
  if (isUsableTheme(resTheme)) {
    return { theme: resTheme, category: resCat || "unknown_category", unknownTheme: false };
  }
  return { theme: "unknown_theme", category: joinCat || metaCat || resCat || "unknown_category", unknownTheme: true };
}

function bluntConclusionV2(args: {
  cohortDenom: number;
  top5MarketPct: number;
  top10MarketPct: number;
  top5ThemePct: number;
  top10ThemePct: number;
  /** Share of concentration cohort in price bands <0.1 or >=0.9 */
  extremeBandShareBlocked: number;
  unknownThemeShareBlocked: number;
}):
  | "concentration is mainly theme-driven"
  | "concentration is mainly market-driven"
  | "concentration is mainly extreme-band-driven"
  | "concentration is broad/systemic across dimensions" {
  const {
    cohortDenom,
    top5MarketPct,
    top10MarketPct,
    top5ThemePct,
    top10ThemePct,
    extremeBandShareBlocked,
    unknownThemeShareBlocked,
  } = args;

  if (cohortDenom < 30) return "concentration is broad/systemic across dimensions";

  const themeReliable = unknownThemeShareBlocked < 0.2;

  const extremeStrong =
    extremeBandShareBlocked >= 0.42 &&
    extremeBandShareBlocked >= top5MarketPct - 0.02 &&
    extremeBandShareBlocked >= (themeReliable ? top5ThemePct : 0) - 0.02;

  if (extremeStrong) return "concentration is mainly extreme-band-driven";

  if (themeReliable && top5ThemePct >= top5MarketPct + 0.07) return "concentration is mainly theme-driven";

  if (top5MarketPct >= top5ThemePct + 0.07) return "concentration is mainly market-driven";

  if (top10MarketPct < 0.52 && top10ThemePct < 0.52) return "concentration is broad/systemic across dimensions";

  if (top5MarketPct >= top5ThemePct) return "concentration is mainly market-driven";
  if (themeReliable) return "concentration is mainly theme-driven";
  return "concentration is broad/systemic across dimensions";
}

function topThemesInBand(m: Map<BandKey, Map<string, number>>, band: BandKey, n: number): [string, number][] {
  const inner = m.get(band);
  if (!inner || inner.size === 0) return [];
  return [...inner.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function bandThemeMatrixToJson(matrix: Map<BandKey, Map<string, number>>, topPerBand: number): Record<string, [string, number][]> {
  const out: Record<string, [string, number][]> = {};
  for (const b of [...BANDS, "unknown" as const]) {
    const top = topThemesInBand(matrix, b, topPerBand);
    if (top.length > 0) out[b] = top;
  }
  return out;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const since = lookbackDate();
  const lookbackHours = Number(process.env.CONCENTRATION_AUDIT_LOOKBACK_HOURS ?? "24");
  const EVENT_CAP = Math.min(80_000, Number(process.env.CONCENTRATION_AUDIT_EVENT_CAP ?? "50000") || 50000);

  const codeRefs = [
    "Exposure checks / reason codes: `lib/execution-policy/evaluate.ts` (e.g. `single_market_concentration_breach`, `single_theme_concentration_breach`).",
    "Runtime handler appends `EXECUTION_POLICY_BLOCKED` with `blockingReasons`: `worker/stream-runtime.ts`.",
    "Ledger: `OrderIntentEvent` joined to `OrderIntent` (`source = runtime_automated`).",
    "Theme/category resolution (this audit): `OrderIntent.recommendationId` → `MarketSignal`; else `metadataJson.linkage`; else `resolveRuntimeIntentRecommendationLink` (`lib/runtime/intent-recommendation-link.ts`).",
  ].join("\n");

  const blockEvents = await prisma.orderIntentEvent.findMany({
    where: {
      eventType: "EXECUTION_POLICY_BLOCKED",
      createdAt: { gte: since },
      orderIntent: { source: "runtime_automated" },
    },
    select: {
      id: true,
      orderIntentId: true,
      payloadJson: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: EVENT_CAP,
  });

  const intentIds = [...new Set(blockEvents.map((e) => e.orderIntentId))];
  const intents = await prisma.orderIntent.findMany({
    where: { id: { in: intentIds } },
    select: {
      id: true,
      marketId: true,
      assetId: true,
      limitPrice: true,
      recommendationId: true,
      funderAddress: true,
      outcome: true,
      metadataJson: true,
    },
  });
  const intentById = new Map(intents.map((i) => [i.id, i]));

  const recIds = [...new Set(intents.map((i) => i.recommendationId).filter((x): x is string => !!x))];
  const recos = await prisma.recommendation.findMany({
    where: { id: { in: recIds } },
    select: {
      id: true,
      marketSignal: { select: { theme: true, category: true, marketTitle: true } },
    },
  });
  const recoById = new Map(recos.map((r) => [r.id, r]));

  const shadowRows = await prisma.shadowCandidate.findMany({
    where: {
      orderIntentId: { in: intentIds },
      candidateSource: "runtime_automated",
      wasBlocked: true,
    },
    select: { orderIntentId: true, decisionSnapshotJson: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const shadowByIntent = new Map<string, { decisionSnapshotJson: string | null }>();
  for (const s of shadowRows) {
    if (s.orderIntentId && !shadowByIntent.has(s.orderIntentId)) {
      shadowByIntent.set(s.orderIntentId, { decisionSnapshotJson: s.decisionSnapshotJson });
    }
  }

  const reasonTokenCounts = new Map<string, number>();
  let eventsWithMarketConc = 0;
  let eventsWithThemeConc = 0;
  let eventsWithRuntimeSafety = 0;
  let eventsConcentrationAny = 0;

  const concIntentIds = new Set<string>();

  for (const ev of blockEvents) {
    const tokens = expandReasonTokens(parseBlockingReasons(ev.payloadJson));
    for (const t of tokens) {
      reasonTokenCounts.set(t, (reasonTokenCounts.get(t) ?? 0) + 1);
    }
    const hasM = tokens.some(tokenHasMarketConc);
    const hasT = tokens.some(tokenHasThemeConc);
    const hasR = tokens.some(tokenHasRuntimeSafety);
    if (hasM) eventsWithMarketConc++;
    if (hasT) eventsWithThemeConc++;
    if (hasR) eventsWithRuntimeSafety++;
    if (hasM || hasT) {
      eventsConcentrationAny++;
      concIntentIds.add(ev.orderIntentId);
    }
  }

  const resolverCache: Map<string, Awaited<ReturnType<typeof resolveRuntimeIntentRecommendationLink>>> = new Map();

  const concIntentRows: IntentForTheme[] = [];
  for (const iid of concIntentIds) {
    const intent = intentById.get(iid);
    if (!intent) continue;
    concIntentRows.push({
      recommendationId: intent.recommendationId,
      metadataJson: intent.metadataJson,
      funderAddress: intent.funderAddress,
      marketId: intent.marketId,
      outcome: intent.outcome,
    });
  }
  await warmResolverCache(concIntentRows, recoById, resolverCache);

  const marketCountsBlocked = new Map<string, number>();
  const themeCountsBlocked = new Map<string, number>();
  const categoryCountsBlocked = new Map<string, number>();
  const bandCountsBlocked = new Map<string, number>();
  const strategyVariantBlocked = new Map<string, number>();
  const bandThemeBlocked = new Map<BandKey, Map<string, number>>();
  let blockedUnknownThemeCount = 0;

  for (const iid of concIntentIds) {
    const intent = intentById.get(iid);
    if (!intent) continue;
    const mid = intent.marketId?.trim() || "unknown_market";
    marketCountsBlocked.set(mid, (marketCountsBlocked.get(mid) ?? 0) + 1);
    const band = classifyShadowBandFromLimitPrice(intent.limitPrice);
    bandCountsBlocked.set(band, (bandCountsBlocked.get(band) ?? 0) + 1);
    const attr = resolveRuntimeAutomatedThemeCategorySync(
      {
        recommendationId: intent.recommendationId,
        metadataJson: intent.metadataJson,
        funderAddress: intent.funderAddress,
        marketId: intent.marketId,
        outcome: intent.outcome,
      },
      recoById,
      resolverCache
    );
    if (attr.unknownTheme) blockedUnknownThemeCount++;
    themeCountsBlocked.set(attr.theme, (themeCountsBlocked.get(attr.theme) ?? 0) + 1);
    categoryCountsBlocked.set(attr.category, (categoryCountsBlocked.get(attr.category) ?? 0) + 1);
    if (!bandThemeBlocked.has(band)) bandThemeBlocked.set(band, new Map());
    const bt = bandThemeBlocked.get(band)!;
    bt.set(attr.theme, (bt.get(attr.theme) ?? 0) + 1);
    const snap = shadowByIntent.get(iid)?.decisionSnapshotJson;
    const strat = parseStrategyProxy(snap);
    strategyVariantBlocked.set(strat, (strategyVariantBlocked.get(strat) ?? 0) + 1);
  }

  const concEventsTotal = eventsConcentrationAny;
  const concIntentTotal = concIntentIds.size;
  const cohortDenom = concIntentTotal > 0 ? concIntentTotal : concEventsTotal;
  const unknownThemeShareBlocked = cohortDenom > 0 ? blockedUnknownThemeCount / cohortDenom : 1;

  const extremeBlockedCount =
    (bandCountsBlocked.get("<0.1") ?? 0) + (bandCountsBlocked.get(">=0.9") ?? 0);
  const extremeBandShareBlocked = cohortDenom > 0 ? extremeBlockedCount / cohortDenom : 0;

  const top5MarketPct = topNShare(marketCountsBlocked, cohortDenom, 5);
  const top10MarketPct = topNShare(marketCountsBlocked, cohortDenom, 10);
  const top5ThemePct = topNShare(themeCountsBlocked, cohortDenom, 5);
  const top10ThemePct = topNShare(themeCountsBlocked, cohortDenom, 10);

  const topBlockedMarkets = [...marketCountsBlocked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const topBlockedThemes = [...themeCountsBlocked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const topBlockedCategories = [...categoryCountsBlocked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  const blunt = bluntConclusionV2({
    cohortDenom,
    top5MarketPct,
    top10MarketPct,
    top5ThemePct,
    top10ThemePct,
    extremeBandShareBlocked,
    unknownThemeShareBlocked,
  });

  const readyEvents = await prisma.orderIntentEvent.findMany({
    where: {
      eventType: "READY_FOR_RECONCILIATION",
      createdAt: { gte: since },
      orderIntent: { source: "runtime_automated" },
    },
    select: { orderIntentId: true, payloadJson: true },
    take: EVENT_CAP,
  });
  const allowedIntentIds = [...new Set(readyEvents.map((e) => e.orderIntentId))];
  const softenedReadyIntentIds = new Set<string>();
  for (const ev of readyEvents) {
    const rp = parseReadyPayload(ev.payloadJson);
    if (rp.concentrationSoftened) softenedReadyIntentIds.add(ev.orderIntentId);
  }
  const allowedIntents = await prisma.orderIntent.findMany({
    where: { id: { in: allowedIntentIds } },
    select: {
      id: true,
      marketId: true,
      limitPrice: true,
      recommendationId: true,
      funderAddress: true,
      outcome: true,
      metadataJson: true,
    },
  });
  const allowedRecIds = [...new Set(allowedIntents.map((i) => i.recommendationId).filter((x): x is string => !!x))];
  const allowedRecos =
    allowedRecIds.length > 0
      ? await prisma.recommendation.findMany({
          where: { id: { in: allowedRecIds } },
          select: { id: true, marketSignal: { select: { theme: true, category: true } } },
        })
      : [];
  const allowedRecoById = new Map(allowedRecos.map((r) => [r.id, r]));

  const allowedIntentRows: IntentForTheme[] = allowedIntents.map((intent) => ({
    recommendationId: intent.recommendationId,
    metadataJson: intent.metadataJson,
    funderAddress: intent.funderAddress,
    marketId: intent.marketId,
    outcome: intent.outcome,
  }));
  await warmResolverCache(allowedIntentRows, allowedRecoById, resolverCache);

  const marketCountsAllowed = new Map<string, number>();
  const themeCountsAllowed = new Map<string, number>();
  const categoryCountsAllowed = new Map<string, number>();
  const bandCountsAllowed = new Map<string, number>();
  const bandThemeAllowed = new Map<BandKey, Map<string, number>>();
  let allowedUnknownThemeCount = 0;
  const allowedDenom = allowedIntents.length;
  const allowedSoftenedDenom = allowedIntents.filter((i) => softenedReadyIntentIds.has(i.id)).length;

  for (const intent of allowedIntents) {
    const mid = intent.marketId?.trim() || "unknown_market";
    marketCountsAllowed.set(mid, (marketCountsAllowed.get(mid) ?? 0) + 1);
    const band = classifyShadowBandFromLimitPrice(intent.limitPrice);
    bandCountsAllowed.set(band, (bandCountsAllowed.get(band) ?? 0) + 1);
    const attr = resolveRuntimeAutomatedThemeCategorySync(
      {
        recommendationId: intent.recommendationId,
        metadataJson: intent.metadataJson,
        funderAddress: intent.funderAddress,
        marketId: intent.marketId,
        outcome: intent.outcome,
      },
      allowedRecoById,
      resolverCache
    );
    if (attr.unknownTheme) allowedUnknownThemeCount++;
    themeCountsAllowed.set(attr.theme, (themeCountsAllowed.get(attr.theme) ?? 0) + 1);
    categoryCountsAllowed.set(attr.category, (categoryCountsAllowed.get(attr.category) ?? 0) + 1);
    if (!bandThemeAllowed.has(band)) bandThemeAllowed.set(band, new Map());
    const bt = bandThemeAllowed.get(band)!;
    bt.set(attr.theme, (bt.get(attr.theme) ?? 0) + 1);
  }

  const unknownThemeShareAllowed = allowedDenom > 0 ? allowedUnknownThemeCount / allowedDenom : 1;

  const topAllowedMarkets = [...marketCountsAllowed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const topAllowedThemes = [...themeCountsAllowed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const topAllowedCategories = [...categoryCountsAllowed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  const blockedTop5Markets = new Set(topBlockedMarkets.slice(0, 5).map(([k]) => k));
  const allowedTop5Markets = new Set(topAllowedMarkets.slice(0, 5).map(([k]) => k));
  const overlapTop5Markets = [...blockedTop5Markets].filter((m) => allowedTop5Markets.has(m)).length;

  const reasonTop = [...reasonTokenCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);

  const formatTopTable = (
    label: string,
    rows: [string, number][],
    denom: number,
    maxRows: number
  ): string[] => {
    const out: string[] = [];
    out.push(`### ${label}`);
    out.push("| rank | name | count | share |");
    out.push("| ---: | --- | ---: | ---: |");
    rows.slice(0, maxRows).forEach(([name, c], i) => {
      const share = denom > 0 ? ((c / denom) * 100).toFixed(2) : "0";
      out.push(`| ${i + 1} | ${String(name).replace(/\|/g, "\\|")} | ${c} | ${share}% |`);
    });
    out.push("");
    return out;
  };

  const lines: string[] = [];
  lines.push("# V2 concentration block audit (read-only)");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(
    `- Lookback: **${Number.isFinite(lookbackHours) ? lookbackHours : 24}h** (\`CONCENTRATION_AUDIT_LOOKBACK_HOURS\`; cap **${EVENT_CAP}** blocked events via \`CONCENTRATION_AUDIT_EVENT_CAP\`).`
  );
  lines.push("- Cohort: `OrderIntent.source = runtime_automated` + `OrderIntentEvent.eventType = EXECUTION_POLICY_BLOCKED`.");
  lines.push(
    "- **Concentration-blocked** = blocked event whose `blockingReasons` tokens mention market and/or theme concentration."
  );
  lines.push("");

  lines.push("## Code references");
  lines.push(codeRefs);
  lines.push("");

  lines.push("## A. Top blocked themes and categories (concentration cohort; count & share)");
  lines.push(
    `- Denominator: **${cohortDenom}** distinct intents with concentration-related block tokens (fallback: event count if no intent rows).`
  );
  lines.push(...formatTopTable("Themes (resolved)", topBlockedThemes, cohortDenom, 15));
  lines.push(...formatTopTable("Categories (resolved)", topBlockedCategories, cohortDenom, 15));
  lines.push("```json");
  lines.push(JSON.stringify({ themes: topBlockedThemes.slice(0, 15), categories: topBlockedCategories.slice(0, 15) }, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## B. Top allowed themes and categories (`READY_FOR_RECONCILIATION`; count & share)");
  lines.push(`- Denominator: **${allowedDenom}** distinct intents with READY in window.`);
  lines.push(
    `- READY intents marked as **concentration softened**: **${allowedSoftenedDenom}** (${allowedDenom > 0 ? ((allowedSoftenedDenom / allowedDenom) * 100).toFixed(2) : "0.00"}%).`
  );
  lines.push(...formatTopTable("Themes (resolved)", topAllowedThemes, allowedDenom, 15));
  lines.push(...formatTopTable("Categories (resolved)", topAllowedCategories, allowedDenom, 15));
  lines.push("```json");
  lines.push(JSON.stringify({ themes: topAllowedThemes.slice(0, 15), categories: topAllowedCategories.slice(0, 15) }, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## C. Unknown theme share (after resolver fallback)");
  lines.push(
    `- **Blocked (concentration cohort):** **${(unknownThemeShareBlocked * 100).toFixed(2)}%** (${blockedUnknownThemeCount}/${cohortDenom}) map to \`unknown_theme\` after join → metadata → resolver.`
  );
  lines.push(
    `- **Allowed (READY cohort):** **${(unknownThemeShareAllowed * 100).toFixed(2)}%** (${allowedUnknownThemeCount}/${allowedDenom}).`
  );
  lines.push("");

  lines.push("## D. Market vs theme concentration comparison (concentration cohort only)");
  lines.push(`- Unique markets: **${marketCountsBlocked.size}**; unique resolved themes: **${themeCountsBlocked.size}**.`);
  lines.push(`- Top **5** markets share of cohort: **${(top5MarketPct * 100).toFixed(1)}%**`);
  lines.push(`- Top **10** markets share of cohort: **${(top10MarketPct * 100).toFixed(1)}%**`);
  lines.push(`- Top **5** themes share of cohort: **${(top5ThemePct * 100).toFixed(1)}%**`);
  lines.push(`- Top **10** themes share of cohort: **${(top10ThemePct * 100).toFixed(1)}%**`);
  lines.push(
    `- **Extreme bands** (\`<0.1\` ∪ \`>=0.9\`) share of concentration cohort: **${(extremeBandShareBlocked * 100).toFixed(1)}%** (${extremeBlockedCount}/${cohortDenom})`
  );
  lines.push("");
  lines.push("### Top markets (concentration cohort)");
  lines.push("| rank | marketId | count | share |");
  lines.push("| ---: | --- | ---: | ---: |");
  topBlockedMarkets.slice(0, 12).forEach(([m, c], i) => {
    lines.push(`| ${i + 1} | \`${m}\` | ${c} | ${cohortDenom ? ((c / cohortDenom) * 100).toFixed(2) : "0"}% |`);
  });
  lines.push("");

  lines.push("## E. Band × theme breakdown (blocked concentration cohort vs allowed READY)");
  lines.push("- Per band: top themes by count (empty bands omitted).");
  lines.push("");
  lines.push("### Blocked (concentration cohort)");
  lines.push("```json");
  lines.push(JSON.stringify(bandThemeMatrixToJson(bandThemeBlocked, 10), null, 2));
  lines.push("```");
  lines.push("### Allowed (READY cohort)");
  lines.push("```json");
  lines.push(JSON.stringify(bandThemeMatrixToJson(bandThemeAllowed, 10), null, 2));
  lines.push("```");
  lines.push("### Band totals: blocked vs allowed");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        blockedConc: Object.fromEntries([...bandCountsBlocked.entries()].sort((a, b) => b[1] - a[1])),
        allowed: Object.fromEntries([...bandCountsAllowed.entries()].sort((a, b) => b[1] - a[1])),
      },
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");

  lines.push("## F. Blunt conclusion");
  lines.push(`**${blunt}**`);
  lines.push("");

  lines.push("## Appendix: block event stats & reason tokens");
  lines.push(`- Total blocked events sampled: **${blockEvents.length}**`);
  lines.push(`- Events with **market** concentration token: **${eventsWithMarketConc}**`);
  lines.push(`- Events with **theme** concentration token: **${eventsWithThemeConc}**`);
  lines.push(`- Events with **runtime_safety_blocked** token: **${eventsWithRuntimeSafety}**`);
  lines.push(`- Events with **any** concentration token (market ∪ theme): **${eventsConcentrationAny}**`);
  lines.push(`- READY events with **concentrationSoftened=true**: **${softenedReadyIntentIds.size}**`);
  lines.push(`- Distinct intents in concentration set: **${concIntentTotal}**`);
  lines.push("");
  lines.push("### Top raw reason tokens");
  lines.push("```json");
  lines.push(JSON.stringify(reasonTop, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("### Allowed vs blocked markets (top blocked vs allowed counts)");
  lines.push("| blocked rank | marketId | blocked (conc) | allowed (READY) |");
  lines.push("| ---: | --- | ---: | ---: |");
  for (let i = 0; i < Math.min(10, topBlockedMarkets.length); i++) {
    const [m, bc] = topBlockedMarkets[i]!;
    const ac = marketCountsAllowed.get(m) ?? 0;
    lines.push(`| ${i + 1} | \`${m}\` | ${bc} | ${ac} |`);
  }
  lines.push("");
  lines.push("### Strategy proxy (concentration-blocked only)");
  lines.push("```json");
  lines.push(
    JSON.stringify(Object.fromEntries([...strategyVariantBlocked.entries()].sort((a, b) => b[1] - a[1])), null, 2)
  );
  lines.push("```");
  lines.push(`- Overlap: **${overlapTop5Markets}** marketIds in both top-5 blocked (conc) and top-5 allowed.`);
  lines.push("");

  lines.push("## JSON summary");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        generatedAt,
        lookbackHours: Number.isFinite(lookbackHours) ? lookbackHours : 24,
        eventCap: EVENT_CAP,
        blockedEventsSampled: blockEvents.length,
        counts: {
          eventsWithMarketConcToken: eventsWithMarketConc,
          eventsWithThemeConcToken: eventsWithThemeConc,
          eventsWithRuntimeSafetyToken: eventsWithRuntimeSafety,
          eventsWithAnyConcentrationToken: eventsConcentrationAny,
          readyWithConcentrationSoftened: softenedReadyIntentIds.size,
        },
        concentrationCohortUniqueIntents: concIntentTotal,
        themeResolution: {
          unknownThemeShareBlocked,
          unknownThemeShareAllowed,
          blockedUnknownThemeCount,
          allowedUnknownThemeCount,
        },
        marketVsTheme: {
          top5MarketShareOfConcCohort: top5MarketPct,
          top10MarketShareOfConcCohort: top10MarketPct,
          top5ThemeShareOfConcCohort: top5ThemePct,
          top10ThemeShareOfConcCohort: top10ThemePct,
          extremeBandShareBlocked,
          uniqueMarketsInConcCohort: marketCountsBlocked.size,
          uniqueThemesInConcCohort: themeCountsBlocked.size,
        },
        topReasonTokens: reasonTop,
        topMarketsBlocked: topBlockedMarkets,
        topThemesBlocked: topBlockedThemes,
        topCategoriesBlocked: topBlockedCategories,
        topThemesAllowed: topAllowedThemes,
        topCategoriesAllowed: topAllowedCategories,
        bandThemeBlocked: bandThemeMatrixToJson(bandThemeBlocked, 10),
        bandThemeAllowed: bandThemeMatrixToJson(bandThemeAllowed, 10),
        bandBlockedConc: Object.fromEntries([...bandCountsBlocked.entries()].sort((a, b) => b[1] - a[1])),
        bandAllowed: Object.fromEntries([...bandCountsAllowed.entries()].sort((a, b) => b[1] - a[1])),
        strategyVariantBlocked: Object.fromEntries([...strategyVariantBlocked.entries()].sort((a, b) => b[1] - a[1])),
        allowedDistinctIntents: allowedIntentIds.length,
        allowedSoftenedDistinctIntents: allowedSoftenedDenom,
        topMarketsAllowed: topAllowedMarkets,
        bluntConclusion: blunt,
      },
      null,
      2
    )
  );
  lines.push("```");

  const outPath = path.join(process.cwd(), "diagnostics", "v2-concentration-block-audit.md");
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
