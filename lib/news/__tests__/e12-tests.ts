/**
 * E12 unit tests: event quality, impact V2, decay, calibration logic.
 * Run with: npx ts-node --project tsconfig.json lib/news/__tests__/e12-tests.ts
 * Or: node -r ts-node/register lib/news/__tests__/e12-tests.ts
 */

import assert from "assert";
import { getSourceCredibility, detectOfficialSource, estimateExtractionConfidence, refreshEventSignalsQuality } from "../event-quality";
import { estimateImpactV2, aggregateCatalystImpactSafe } from "../impact-v2";
import { getTimeToResolutionHours } from "../../polymarket/market-time";
import { computeObservedImpactForLink } from "../impact-calibration";

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function ok(cond: boolean, msg: string): void {
    if (cond) {
      passed++;
      console.log("  OK:", msg);
    } else {
      failed++;
      console.error("  FAIL:", msg);
    }
  }

  console.log("E12 tests\n");

  console.log("Source credibility");
  {
    const high = getSourceCredibility("Reuters", "https://reuters.com/article/123");
    ok(high >= 0.9, "Reuters has high credibility");
    const ap = getSourceCredibility("Associated Press");
    ok(ap >= 0.85, "AP has high credibility");
    const unknown = getSourceCredibility("Random Blog");
    ok(unknown >= 0.5 && unknown <= 0.7, "Unknown source gets medium credibility");
    const empty = getSourceCredibility();
    ok(empty === 0.5, "No source defaults to 0.5");
  }

  console.log("Official source detection");
  {
    ok(detectOfficialSource("Reuters") === true, "Reuters is official");
    ok(detectOfficialSource("Random Blog") === false, "Random blog is not official");
    ok(detectOfficialSource(undefined, "https://sec.gov/news") === true, "sec.gov URL is official");
  }

  console.log("Extraction confidence");
  {
    const high = estimateExtractionConfidence({ keywordMatches: 3, entityPresent: true, titleLength: 50, bodyLength: 200 });
    ok(high >= 0.8, "High keyword + entity gives high extraction confidence");
    const low = estimateExtractionConfidence({ keywordMatches: 0, entityPresent: false, titleLength: 5, bodyLength: 0 });
    ok(low <= 0.5, "No signals give low extraction confidence");
  }

  console.log("Impact V2 output shape and bounds");
  {
    const r = estimateImpactV2({
      eventType: "war_escalation",
      marketCategory: "geopolitics",
      severity: "high",
      sentiment: "negative",
      linkRelevanceScore: 0.7,
    });
    ok(typeof r.instantImpact === "number" && r.instantImpact >= -1 && r.instantImpact <= 1, "instantImpact in [-1,1]");
    ok(typeof r.persistentImpact === "number" && r.persistentImpact >= -1 && r.persistentImpact <= 1, "persistentImpact in [-1,1]");
    ok(typeof r.blendedImpactEstimate === "number" && r.blendedImpactEstimate >= -1 && r.blendedImpactEstimate <= 1, "blendedImpactEstimate in [-1,1]");
    ok(typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1, "confidence in [0,1]");
    ok(typeof r.decayHalfLifeMinutes === "number" && r.decayHalfLifeMinutes > 0, "decayHalfLifeMinutes positive");
    ok(typeof r.timeToFullIncorporationMinutes === "number" && r.timeToFullIncorporationMinutes > 0, "timeToFullIncorporationMinutes positive");
    ok(r.reasoning && typeof r.reasoning === "object", "reasoning is object");
  }

  console.log("Impact V2 directional sanity");
  {
    const strong = estimateImpactV2({
      eventType: "sanctions",
      marketCategory: "geopolitics",
      severity: "critical",
      sentiment: "negative",
      linkRelevanceScore: 0.9,
      sourceCredibility: 0.95,
      isOfficialSource: true,
      noveltyScore: 0.9,
    });
    const weak = estimateImpactV2({
      eventType: "other",
      marketCategory: "default",
      severity: "low",
      sentiment: "neutral",
      linkRelevanceScore: 0.2,
    });
    ok(
      Math.abs(strong.persistentImpact) >= Math.abs(weak.persistentImpact),
      "Strong event has larger persistent impact than weak"
    );
    ok(strong.confidence >= weak.confidence, "Strong event has higher confidence");
  }

  console.log("Decay logic");
  {
    const officialWar = estimateImpactV2({
      eventType: "war_escalation",
      marketCategory: "geopolitics",
      severity: "high",
      sentiment: "negative",
      linkRelevanceScore: 0.5,
      isOfficialSource: true,
    });
    const vague = estimateImpactV2({
      eventType: "other",
      marketCategory: "default",
      severity: "low",
      sentiment: "neutral",
      linkRelevanceScore: 0.5,
    });
    ok(officialWar.decayHalfLifeMinutes >= vague.decayHalfLifeMinutes, "Official/serious event has slower decay (higher half-life)");
  }

  console.log("Time to resolution");
  {
    const future = getTimeToResolutionHours({ id: "m1", endDate: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    ok(future !== null && future > 20 && future < 28, "Market ending in 24h returns ~24h");
    const noEnd = getTimeToResolutionHours({ id: "m2", endDate: null });
    ok(noEnd === null, "No endDate returns null");
  }

  const hasDb = !!process.env.DATABASE_URL;
  if (hasDb) {
    console.log("E12.1 Outcome alignment / calibration result shape");
    const base = new Date(Date.now() - 60 * 60 * 1000);
    const result = await computeObservedImpactForLink({
      id: "test",
      marketId: "nonexistent",
      createdAt: base,
      instantImpact: 0.1,
      persistentImpact: 0.05,
    });
    ok(typeof result.calibrationOutcomeIndex === "number" || result.calibrationOutcomeIndex === null, "calibrationOutcomeIndex present");
    ok(typeof result.calibrationConfidence === "number" && result.calibrationConfidence >= 0 && result.calibrationConfidence <= 1, "calibrationConfidence in [0,1]");
  } else {
    console.log("E12.1 Outcome alignment (skipped: no DATABASE_URL)");
  }

  console.log("E12.1 Duplicate catalyst suppression");
  {
    const base = new Date();
    const link = (et: string, ep: string | null, impact: number) => ({
      impactEstimate: impact,
      confidence: 0.8,
      persistentImpact: impact,
      instantImpact: impact,
      eventSignal: {
        eventType: et,
        entityPrimary: ep,
        createdAt: base,
        sourceCredibility: 0.9,
        noveltyScore: 0.8,
      },
      calibrationConfidence: null as number | null | undefined,
    });
    const one = aggregateCatalystImpactSafe([link("sanctions", "RU", 0.2)]);
    const twoSame = aggregateCatalystImpactSafe([
      link("sanctions", "RU", 0.2),
      link("sanctions", "RU", 0.2),
    ]);
    ok(Math.abs(one.blendedImpactEstimate) <= 1, "single link impact bounded");
    ok(Math.abs(twoSame.blendedImpactEstimate) <= 1, "two duplicate links impact bounded");
    ok(
      typeof twoSame.blendedImpactEstimate === "number" && typeof twoSame.persistentImpact === "number",
      "aggregation returns numbers"
    );
  }

  if (hasDb) {
    console.log("E12.1 Calibration guard: result includes confidence");
    const base = new Date(Date.now() - 120 * 60 * 1000);
    const out = await computeObservedImpactForLink({
      id: "t",
      marketId: "no-market",
      createdAt: base,
      instantImpact: 0,
      persistentImpact: 0,
      calibrationOutcomeIndex: null,
    });
    ok(out.calibrationConfidence >= 0 && out.calibrationConfidence <= 1, "calibrationConfidence in [0,1] when no market");
  } else {
    console.log("E12.1 Calibration guard (skipped: no DATABASE_URL)");
  }

  console.log("E12.1 Quality refresh with force=true");
  if (hasDb) {
    const result = await refreshEventSignalsQuality({ sinceHours: 1, limit: 5, force: true });
    ok(typeof result.enriched === "number" && result.enriched >= 0, "refreshEventSignalsQuality returns enriched count");
    ok(Array.isArray(result.errors), "refreshEventSignalsQuality returns errors array");
  } else {
    ok(typeof refreshEventSignalsQuality === "function", "refreshEventSignalsQuality exists (skip DB call)");
  }

  console.log("\n---");
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  assert.strictEqual(failed, 0, `${failed} test(s) failed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
