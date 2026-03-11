/**
 * Full news sync: ensure sources, fetch, dedupe (via persist), link, features, summaries,
 * event extraction, event quality enrichment, market impact linking (V2), narrative tracking, calibration.
 */

import { ensureDefaultNewsSources } from "./sources";
import { fetchAllEnabledSources, persistFetchedItems } from "./fetch";
import { linkNewsToMarkets, type LinkNewsDiagnostics } from "./link";
import { runFallbackEventMarketLinking, type FallbackLinkDiagnostics } from "./link-fallback";
import { refreshLinkScores } from "./features";
import { fillCatalystSummaries } from "./summarize";
import { runEventExtraction } from "./event-extract";
import { enrichRecentEventSignalsQuality } from "./event-quality";
import { runMarketImpactLinking } from "./impact";
import { runMarketImpactLinkingV2 } from "./impact-v2";
import { runNarrativeTracking } from "./narratives";
import { calibrateMarketEventLinks } from "./impact-calibration";

export interface NewsSyncResult {
  sourcesEnsured: number;
  itemsFetched: number;
  itemsCreated: number;
  linksCreated: number;
  summariesFilled: number;
  eventSignalsCreated: number;
  eventSignalsQualityEnriched: number;
  marketEventLinksCreated: number;
  marketEventLinksV2CreatedOrUpdated: number;
  marketEventLinksCalibrated: number;
  narrativeTrendsUpserted: number;
  errors: string[];
  /** Diagnostics: news→market linker */
  linkDiagnostics?: LinkNewsDiagnostics;
  /** Diagnostics: fallback event→market linker */
  fallbackDiagnostics?: FallbackLinkDiagnostics;
  /** Fallback linker created this many MarketNewsLinks when primary linker had none */
  fallbackLinksCreated?: number;
  /** EventSignals that had no MarketNewsLink when impact linking ran (before or after fallback) */
  signalsWithZeroNewsLinks?: number;
}

/**
 * Run full news pipeline: sources → fetch → persist → link → refresh scores → summaries.
 */
export async function runNewsSync(): Promise<NewsSyncResult> {
  const errors: string[] = [];
  let sourcesEnsured = 0;
  let itemsCreated = 0;
  let linksCreated = 0;
  let summariesFilled = 0;
  let eventSignalsCreated = 0;
  let eventSignalsQualityEnriched = 0;
  let marketEventLinksCreated = 0;
  let marketEventLinksV2CreatedOrUpdated = 0;
  let marketEventLinksCalibrated = 0;
  let narrativeTrendsUpserted = 0;
  let linkDiagnostics: LinkNewsDiagnostics | undefined;
  let fallbackDiagnostics: FallbackLinkDiagnostics | undefined;
  let fallbackLinksCreated = 0;

  try {
    const sources = await ensureDefaultNewsSources();
    sourcesEnsured = sources.length;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  let itemsFetched = 0;
  try {
    const items = await fetchAllEnabledSources();
    itemsFetched = items.length;
    itemsCreated = await persistFetchedItems(items);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    const { linked, diagnostics: linkDiag } = await linkNewsToMarkets(0.15);
    linksCreated = linked;
    linkDiagnostics = linkDiag;
    if (linkDiag) {
      console.info("[news/sync] linkNewsToMarkets", {
        linked,
        candidateItemsScanned: linkDiag.candidateItemsScanned,
        candidateMarketsScanned: linkDiag.candidateMarketsScanned,
        rejectedLowRelevance: linkDiag.rejectedLowRelevance,
        itemsWithNullPublishedAt: linkDiag.itemsWithNullPublishedAt,
      });
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    await refreshLinkScores();
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    summariesFilled = await fillCatalystSummaries();
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    const ext = await runEventExtraction({ sinceHours: 168, maxItems: 500 });
    eventSignalsCreated = ext.signalsCreated;
    errors.push(...ext.errors);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    const enrich = await enrichRecentEventSignalsQuality({ sinceHours: 168, maxSignals: 500 });
    eventSignalsQualityEnriched = enrich.enriched;
    errors.push(...enrich.errors);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    const fallback = await runFallbackEventMarketLinking({ sinceHours: 168, maxSignals: 500 });
    fallbackLinksCreated = fallback.linksCreated;
    fallbackDiagnostics = fallback.diagnostics;
    errors.push(...fallback.errors);
    if (fallback.diagnostics) {
      console.info("[news/sync] fallbackEventMarketLinking", {
        linksCreated: fallback.linksCreated,
        eventsProcessed: fallback.diagnostics.eventsProcessed,
        eventsWithExistingLinks: fallback.diagnostics.eventsWithExistingLinks,
        fallbackEventMarketMatches: fallback.diagnostics.fallbackEventMarketMatches,
        marketsConsidered: fallback.diagnostics.marketsConsidered,
      });
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // E12.1: E11 creates MarketEventLink only when none exists; E12 runs after and only updates (never creates).
  let signalsWithZeroNewsLinks: number | undefined;
  try {
    const impact = await runMarketImpactLinking({ sinceHours: 168, maxSignals: 1000 });
    marketEventLinksCreated = impact.linksCreated;
    signalsWithZeroNewsLinks = impact.signalsWithZeroNewsLinks;
    errors.push(...impact.errors);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    const impactV2 = await runMarketImpactLinkingV2({ sinceHours: 168, maxSignals: 1000 });
    marketEventLinksV2CreatedOrUpdated = impactV2.linksCreatedOrUpdated;
    errors.push(...impactV2.errors);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    const nar = await runNarrativeTracking({ windowHours: 24 });
    narrativeTrendsUpserted = nar.trendsUpserted;
    errors.push(...nar.errors);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    const cal = await calibrateMarketEventLinks({ maxLinks: 150, lookbackHours: 72 });
    marketEventLinksCalibrated = cal.calibrated;
    errors.push(...cal.errors);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  return {
    sourcesEnsured,
    itemsFetched,
    itemsCreated,
    linksCreated,
    summariesFilled,
    eventSignalsCreated,
    eventSignalsQualityEnriched,
    marketEventLinksCreated,
    marketEventLinksV2CreatedOrUpdated,
    marketEventLinksCalibrated,
    narrativeTrendsUpserted,
    errors,
    linkDiagnostics,
    fallbackDiagnostics,
    fallbackLinksCreated,
    signalsWithZeroNewsLinks,
  };
}
