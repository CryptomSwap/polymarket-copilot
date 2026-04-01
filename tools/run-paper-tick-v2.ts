import "dotenv/config";
import { runPaperTradingTickV2 } from "../lib/paper-trading/engine_v2_minimal";

function printDistribution(dist: Record<string, number>): void {
  const rows = Object.entries(dist)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    console.log("reject reason distribution: (none)");
    return;
  }
  console.log("reject reason distribution:");
  for (const [reason, count] of rows) {
    console.log(`- ${reason}: ${count}`);
  }
}

async function main(): Promise<void> {
  const explicitFunder = process.argv[2]?.trim() || undefined;
  const result = await runPaperTradingTickV2(explicitFunder);

  console.log("paper tick v2");
  console.log("enabled:", result.enabled);
  console.log("model:", result.modelRunId ?? "none");
  console.log("funder used:", result.funderUsedForCandidateLoad ?? "none");
  console.log("candidates loaded:", result.candidatesLoaded);
  console.log("candidates passed filter:", result.candidatesPassedFilter);
  console.log("trades opened:", result.tradesOpened);
  printDistribution(result.rejectReasonDistribution);
  if (result.duplicateExposureSuppression) {
    console.log("duplicate exposure suppression:", JSON.stringify(result.duplicateExposureSuppression));
  }
  if (result.dedupeCollisionBreakdown) {
    console.log("dedupe collision breakdown:", JSON.stringify(result.dedupeCollisionBreakdown));
  }
  if (result.scoreProvenanceSample && result.scoreProvenanceSample.length > 0) {
    console.log("score provenance sample:");
    for (const r of result.scoreProvenanceSample) {
      console.log(
        JSON.stringify(
          {
            recommendationId: r.recommendationId,
            scorerSource: r.scorerSource,
            structuredBaseScore: r.structuredBaseScore,
            structuredBlendedScore: r.structuredBlendedScore,
            rawShadowMlScore: r.shadowMlScoreRaw,
            shadowMlScoreCalibrated: r.shadowMlScoreCalibrated,
            band: r.shadowBand,
            bandRankScore: r.shadowBandRankScore,
            bandSignal: r.shadowBandSignal,
            bandPenaltyMultiplier: r.shadowBandPenaltyMultiplier,
            finalBandAwareScore: r.finalBandAwareScore,
            actualScoreUsedForOrdering: r.actualScoreUsedForOrdering,
            actualScoreUsedForThreshold: r.actualScoreUsedForThreshold,
            thresholdApplied: r.thresholdApplied,
            outcomes: r.outcomes,
          },
          null,
          0
        )
      );
    }
  }

  if (result.errors.length > 0) {
    console.log("errors:");
    for (const err of result.errors) console.log(`- ${err}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
