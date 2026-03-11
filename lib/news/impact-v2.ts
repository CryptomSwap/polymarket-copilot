/**
 * Impact V2: instant vs persistent impact, decay, time-to-incorporation, confidence from quality.
 * Deterministic and explainable. Extends E11 impact model.
 */

import { prisma } from "@/lib/db";
import { getTimeToResolutionHours, getTimeToResolutionHoursByMarkets } from "@/lib/polymarket/market-time";
import type { EventType } from "./event-extract";

const BASE_BY_EVENT_CATEGORY: Record<string, Record<string, number>> = {
  geopolitics: { sanctions: 0.15, war_escalation: 0.25, elections: 0.08, central_bank: 0.05, regulation: 0.06, other: 0.02 },
  politics: { sanctions: 0.05, war_escalation: 0.1, elections: 0.2, central_bank: 0.02, regulation: 0.08, other: 0.02 },
  crypto: { sanctions: 0.04, war_escalation: 0.03, elections: 0.02, central_bank: 0.12, regulation: 0.18, earnings: 0.02, other: 0.02 },
  commodities: { sanctions: 0.12, war_escalation: 0.15, elections: 0.02, central_bank: 0.08, regulation: 0.03, other: 0.02 },
  default: { sanctions: 0.08, war_escalation: 0.12, elections: 0.1, central_bank: 0.1, regulation: 0.08, earnings: 0.06, other: 0.02 },
};

function mapCategory(category: string | null): string {
  if (!category) return "default";
  const c = category.toLowerCase();
  if (c.includes("geo") || c.includes("world")) return "geopolitics";
  if (c.includes("politic") || c.includes("elect")) return "politics";
  if (c.includes("crypto") || c.includes("bitcoin") || c.includes("eth")) return "crypto";
  if (c.includes("commodit") || c.includes("oil") || c.includes("energy")) return "commodities";
  return "default";
}

function sentimentMult(sentiment: string | null): number {
  if (!sentiment) return 1;
  if (sentiment === "negative") return 1.2;
  if (sentiment === "positive") return 0.9;
  return 1;
}

function severityMult(severity: string | null): number {
  if (!severity) return 1;
  if (severity === "critical") return 1.5;
  if (severity === "high") return 1.25;
  if (severity === "medium") return 1;
  return 0.8;
}

const SLOW_DECAY_EVENTS = new Set<string>(["sanctions", "war_escalation", "central_bank", "regulation"]);
const HALF_LIFE_OFFICIAL_MINUTES = 360;
const HALF_LIFE_FAST_MINUTES = 45;
const INCORPORATION_OFFICIAL_MINUTES = 120;
const INCORPORATION_FAST_MINUTES = 30;

export interface EstimateImpactV2Params {
  eventType: EventType | string;
  marketCategory: string | null;
  severity: string | null;
  sentiment: string | null;
  linkRelevanceScore: number;
  sourceCredibility?: number | null;
  noveltyScore?: number | null;
  confirmationCount?: number | null;
  isOfficialSource?: boolean | null;
  extractionConfidence?: number | null;
  timeToResolutionHours?: number | null;
}

export interface ImpactV2Result {
  instantImpact: number;
  persistentImpact: number;
  blendedImpactEstimate: number;
  confidence: number;
  decayHalfLifeMinutes: number;
  timeToFullIncorporationMinutes: number;
  reasoning: Record<string, unknown>;
}

export function estimateImpactV2(params: EstimateImpactV2Params): ImpactV2Result {
  const {
    eventType,
    marketCategory,
    severity,
    sentiment,
    linkRelevanceScore,
    sourceCredibility = 0.5,
    noveltyScore = 0.5,
    confirmationCount = 0,
    isOfficialSource = false,
    extractionConfidence = 0.5,
    timeToResolutionHours,
  } = params;

  const category = mapCategory(marketCategory);
  const table = BASE_BY_EVENT_CATEGORY[category] ?? BASE_BY_EVENT_CATEGORY.default;
  const base = table[eventType] ?? table.other ?? 0.02;
  const sent = sentimentMult(sentiment);
  const sev = severityMult(severity);
  const relevanceFactor = 0.5 + Math.min(0.5, linkRelevanceScore);

  const raw = base * sent * sev * relevanceFactor;
  const signed = sentiment === "negative" ? raw : -raw * 0.5;
  const capped = Math.max(-1, Math.min(1, signed));

  const officialBoost = isOfficialSource ? 1.25 : 1;
  const noveltyFactor = 0.7 + (noveltyScore ?? 0.5) * 0.3;
  const confirmCap = Math.min(confirmationCount ?? 0, 5);
  const confirmFactor = 1 + confirmCap * 0.05;

  const instantImpact = Math.max(-1, Math.min(1, capped * 1.1));
  const persistentShare = SLOW_DECAY_EVENTS.has(eventType) && isOfficialSource ? 0.7 : SLOW_DECAY_EVENTS.has(eventType) ? 0.5 : 0.35;
  const persistentImpact = Math.max(-1, Math.min(1, capped * officialBoost * noveltyFactor * persistentShare * Math.min(1.2, confirmFactor)));

  const blendedImpactEstimate = 0.4 * instantImpact + 0.6 * persistentImpact;
  const blended = Math.max(-1, Math.min(1, blendedImpactEstimate));

  const confFromSource = (sourceCredibility ?? 0.5) * 0.3;
  const confFromNovelty = (noveltyScore ?? 0.5) * 0.2;
  const confFromRelevance = relevanceFactor * 0.3;
  const confFromExtraction = (extractionConfidence ?? 0.5) * 0.2;
  const confidence = Math.min(1, confFromSource + confFromNovelty + confFromRelevance + confFromExtraction);

  const slowDecay = SLOW_DECAY_EVENTS.has(eventType) && (isOfficialSource || severity === "high" || severity === "critical");
  const decayHalfLifeMinutes = slowDecay ? HALF_LIFE_OFFICIAL_MINUTES : HALF_LIFE_FAST_MINUTES;
  const timeToFullIncorporationMinutes = slowDecay ? INCORPORATION_OFFICIAL_MINUTES : INCORPORATION_FAST_MINUTES;

  const reasoning: Record<string, unknown> = {
    category,
    base,
    sentimentMult: sent,
    severityMult: sev,
    linkRelevance: linkRelevanceScore,
    sourceCredibility: sourceCredibility ?? undefined,
    noveltyScore: noveltyScore ?? undefined,
    isOfficialSource,
    persistentShare,
    decayHalfLifeMinutes,
    timeToFullIncorporationMinutes,
  };
  if (timeToResolutionHours != null) reasoning.timeToResolutionHours = timeToResolutionHours;

  return {
    instantImpact,
    persistentImpact,
    blendedImpactEstimate: blended,
    confidence,
    decayHalfLifeMinutes,
    timeToFullIncorporationMinutes,
    reasoning,
  };
}

export interface MarketImpactV2Result {
  linksCreatedOrUpdated: number;
  errors: string[];
}

export async function runMarketImpactLinkingV2(opts?: {
  sinceHours?: number;
  maxSignals?: number;
}): Promise<MarketImpactV2Result> {
  const since = opts?.sinceHours ?? 168;
  const maxSignals = opts?.maxSignals ?? 1000;
  const sinceDate = new Date(Date.now() - since * 60 * 60 * 1000);
  const errors: string[] = [];
  let linksCreatedOrUpdated = 0;

  const signals = await prisma.eventSignal.findMany({
    where: { createdAt: { gte: sinceDate } },
    include: { newsItem: true },
    orderBy: { createdAt: "desc" },
    take: maxSignals,
  });

  const marketIds = new Set<string>();
  const links = await prisma.marketNewsLink.findMany({
    where: { newsItemId: { in: signals.map((s) => s.newsItemId) } },
    select: { marketId: true, newsItemId: true, relevanceScore: true },
  });
  for (const l of links) marketIds.add(l.marketId);
  const markets = await prisma.syncedMarket.findMany({
    where: { id: { in: Array.from(marketIds) } },
    select: { id: true, endDate: true, category: true },
  });
  const marketById = new Map(markets.map((m) => [m.id, m]));
  const timeToRes = getTimeToResolutionHoursByMarkets(markets);

  for (const signal of signals) {
    const signalLinks = links.filter((l) => l.newsItemId === signal.newsItemId);
    for (const link of signalLinks) {
      const market = marketById.get(link.marketId);
      const category = market?.category ?? null;
      const timeToResolutionHours = timeToRes[link.marketId] ?? null;
      const result = estimateImpactV2({
        eventType: signal.eventType,
        marketCategory: category,
        severity: signal.severity,
        sentiment: signal.sentiment,
        linkRelevanceScore: link.relevanceScore,
        sourceCredibility: signal.sourceCredibility,
        noveltyScore: signal.noveltyScore,
        confirmationCount: signal.confirmationCount,
        isOfficialSource: signal.isOfficialSource,
        extractionConfidence: signal.extractionConfidence,
        timeToResolutionHours,
      });
      try {
        const existing = await prisma.marketEventLink.findFirst({
          where: { eventSignalId: signal.id, marketId: link.marketId },
        });
        if (existing) {
          await prisma.marketEventLink.update({
            where: { id: existing.id },
            data: {
              impactEstimate: result.blendedImpactEstimate,
              confidence: result.confidence,
              reasoningJson: JSON.stringify(result.reasoning),
              instantImpact: result.instantImpact,
              persistentImpact: result.persistentImpact,
              decayHalfLifeMinutes: result.decayHalfLifeMinutes,
              timeToFullIncorporationMinutes: result.timeToFullIncorporationMinutes,
            },
          });
          linksCreatedOrUpdated++;
        }
        // E12.1: E12 only updates links; E11 (runMarketImpactLinking) creates new links. Never create here.
      } catch (err) {
        errors.push(signal.id + "/" + link.marketId + ": " + (err instanceof Error ? err.message : String(err)));
      }
    }
  }

  return { linksCreatedOrUpdated, errors };
}

const PER_EVENT_IMPACT_CAP = 0.15;
const DUPLICATE_SUPPRESSION_HOURS = 6;

type LinkWithSignal = {
  impactEstimate: number;
  confidence: number;
  persistentImpact: number | null;
  instantImpact: number | null;
  eventSignal: { eventType: string; entityPrimary: string | null; createdAt: Date; sourceCredibility: number | null; noveltyScore: number | null };
  calibrationConfidence?: number | null;
};

/**
 * E12.1: Safe catalyst aggregation: cap per-event impact, weights from quality, tanh, duplicate suppression.
 * weight_i = noveltyScore * sourceCredibility * linkConfidence; duplicate (eventType+entityPrimary within 6h) gets diminishing weight.
 * Exported for testing.
 */
export function aggregateCatalystImpactSafe(links: LinkWithSignal[]): {
  blendedImpactEstimate: number;
  persistentImpact: number;
} {
  if (links.length === 0) return { blendedImpactEstimate: 0, persistentImpact: 0 };
  const sorted = [...links].sort(
    (a, b) => a.eventSignal.createdAt.getTime() - b.eventSignal.createdAt.getTime()
  );
  const windowMs = DUPLICATE_SUPPRESSION_HOURS * 60 * 60 * 1000;
  const duplicateFactor: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const li = sorted[i];
    let sameInWindow = 0;
    for (let j = 0; j < i; j++) {
      const lj = sorted[j];
      if (
        lj.eventSignal.eventType === li.eventSignal.eventType &&
        (lj.eventSignal.entityPrimary ?? "") === (li.eventSignal.entityPrimary ?? "") &&
        li.eventSignal.createdAt.getTime() - lj.eventSignal.createdAt.getTime() <= windowMs
      ) {
        sameInWindow++;
      }
    }
    duplicateFactor[i] = 1 / (1 + sameInWindow);
  }
  let sumBlended = 0;
  let sumPersistent = 0;
  let sumWBlended = 0;
  let sumWPersistent = 0;
  for (let i = 0; i < sorted.length; i++) {
    const l = sorted[i];
    const novelty = l.eventSignal.noveltyScore ?? 0.5;
    const sourceCred = l.eventSignal.sourceCredibility ?? 0.5;
    const linkConf = l.calibrationConfidence ?? l.confidence;
    const dup = duplicateFactor[i];
    const w = novelty * sourceCred * linkConf * dup;
    const cappedBlend = Math.max(-PER_EVENT_IMPACT_CAP, Math.min(PER_EVENT_IMPACT_CAP, l.impactEstimate));
    const persistentVal = l.persistentImpact ?? l.impactEstimate;
    const cappedPersist = Math.max(-PER_EVENT_IMPACT_CAP, Math.min(PER_EVENT_IMPACT_CAP, persistentVal));
    sumBlended += cappedBlend * w;
    sumWBlended += w;
    sumPersistent += cappedPersist * w;
    sumWPersistent += w;
  }
  const blendedImpactEstimate = Math.tanh(sumBlended);
  const persistentImpactVal = Math.tanh(sumPersistent);
  return {
    blendedImpactEstimate: Math.max(-1, Math.min(1, blendedImpactEstimate)),
    persistentImpact: Math.max(-1, Math.min(1, persistentImpactVal)),
  };
}

export async function getEventImpactForMarketV2(marketId: string): Promise<{
  blendedImpactEstimate: number;
  persistentImpact: number;
  confidence: number;
  eventCount: number;
  calibratedCount: number;
  reasoning: unknown[];
  links: Array<{
    instantImpact: number | null;
    persistentImpact: number | null;
    impactEstimate: number;
    confidence: number;
    decayHalfLifeMinutes: number | null;
    timeToFullIncorporationMinutes: number | null;
    impactObserved5m: number | null;
    impactObserved30m: number | null;
    impactObserved2h: number | null;
    impactObserved24h: number | null;
    calibrationError5m: number | null;
    calibrationError30m: number | null;
    calibrationError2h: number | null;
    calibrationError24h: number | null;
    calibrationOutcomeIndex?: number | null;
    calibrationConfidence?: number | null;
  }>;
}> {
  const links = await prisma.marketEventLink.findMany({
    where: { marketId },
    include: { eventSignal: true },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  if (links.length === 0) {
    return {
      blendedImpactEstimate: 0,
      persistentImpact: 0,
      confidence: 0,
      eventCount: 0,
      calibratedCount: 0,
      reasoning: [],
      links: [],
    };
  }
  const safe = aggregateCatalystImpactSafe(
    links.map((l) => ({
      impactEstimate: l.impactEstimate,
      confidence: l.confidence,
      persistentImpact: l.persistentImpact,
      instantImpact: l.instantImpact,
      eventSignal: l.eventSignal,
      calibrationConfidence: l.calibrationConfidence,
    }))
  );
  const blendedImpactEstimate = safe.blendedImpactEstimate;
  const persistentImpact = safe.persistentImpact;
  const totalConf = links.reduce((a, l) => a + l.confidence, 0);
  const avgConfidence = links.length > 0 ? totalConf / links.length : 0;
  const calibratedCount = links.filter(
    (l) =>
      l.impactObserved5m != null ||
      l.impactObserved30m != null ||
      l.impactObserved2h != null ||
      l.impactObserved24h != null
  ).length;
  const reasoning = links.slice(0, 5).map((l) => ({
    eventType: l.eventSignal.eventType,
    instantImpact: l.instantImpact,
    persistentImpact: l.persistentImpact,
    impactEstimate: l.impactEstimate,
    confidence: l.confidence,
    reasoningJson: l.reasoningJson,
  }));
  return {
    blendedImpactEstimate,
    persistentImpact,
    confidence: Math.min(1, avgConfidence * 0.9),
    eventCount: links.length,
    calibratedCount,
    reasoning,
    links: links.map((l) => ({
      instantImpact: l.instantImpact,
      persistentImpact: l.persistentImpact,
      impactEstimate: l.impactEstimate,
      confidence: l.confidence,
      decayHalfLifeMinutes: l.decayHalfLifeMinutes,
      timeToFullIncorporationMinutes: l.timeToFullIncorporationMinutes,
      impactObserved5m: l.impactObserved5m,
      impactObserved30m: l.impactObserved30m,
      impactObserved2h: l.impactObserved2h,
      impactObserved24h: l.impactObserved24h,
      calibrationError5m: l.calibrationError5m,
      calibrationError30m: l.calibrationError30m,
      calibrationError2h: l.calibrationError2h,
      calibrationError24h: l.calibrationError24h,
      calibrationOutcomeIndex: l.calibrationOutcomeIndex ?? undefined,
      calibrationConfidence: l.calibrationConfidence ?? undefined,
    })),
  };
}

export async function getEventImpactByMarketsV2(
  marketIds: string[]
): Promise<
  Record<
    string,
    {
      impactEstimate: number;
      persistentImpact: number;
      confidence: number;
      eventCount: number;
      calibratedCount: number;
    }
  >
> {
  if (marketIds.length === 0) return {};
  const links = await prisma.marketEventLink.findMany({
    where: { marketId: { in: marketIds } },
    include: { eventSignal: true },
  });
  const out: Record<
    string,
    {
      impactEstimate: number;
      persistentImpact: number;
      confidence: number;
      eventCount: number;
      calibratedCount: number;
    }
  > = {};
  for (const mid of marketIds) {
    const marketLinks = links.filter((l) => l.marketId === mid);
    if (marketLinks.length === 0) {
      out[mid] = { impactEstimate: 0, persistentImpact: 0, confidence: 0, eventCount: 0, calibratedCount: 0 };
      continue;
    }
    const safe = aggregateCatalystImpactSafe(
      marketLinks.map((l) => ({
        impactEstimate: l.impactEstimate,
        confidence: l.confidence,
        persistentImpact: l.persistentImpact,
        instantImpact: l.instantImpact,
        eventSignal: l.eventSignal,
        calibrationConfidence: l.calibrationConfidence,
      }))
    );
    const totalConf = marketLinks.reduce((a, l) => a + l.confidence, 0);
    out[mid] = {
      impactEstimate: safe.blendedImpactEstimate,
      persistentImpact: safe.persistentImpact,
      confidence: Math.min(1, (totalConf / marketLinks.length) * 0.9),
      eventCount: marketLinks.length,
      calibratedCount: marketLinks.filter(
        (l) =>
          l.impactObserved5m != null ||
          l.impactObserved30m != null ||
          l.impactObserved2h != null ||
          l.impactObserved24h != null
      ).length,
    };
  }
  return out;
}
