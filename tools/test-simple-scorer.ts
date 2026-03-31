import "dotenv/config";
import { getFunderForPaperTradingTick } from "../lib/decision/recompute";
import { loadShadowCandidatesForPaperTick, normalizePreferredFunderForShadowLoad } from "../lib/paper-trading/candidates";
import { buildExternalSignalFeatureVectors } from "../lib/paper-trading/features/external_signal_features";
import { buildMispricingFeatureVectors } from "../lib/paper-trading/features/mispricing_features";
import { computeSimpleBaselineScores } from "../lib/paper-trading/simple_baseline_scorer";

function fmt(n: number): string {
  return n.toFixed(6);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? 0;
}

async function main(): Promise<void> {
  const explicitFunder = process.argv[2]?.trim() || undefined;
  const preferredFunder = normalizePreferredFunderForShadowLoad(
    explicitFunder ?? (await getFunderForPaperTradingTick())
  );
  const loaded = await loadShadowCandidatesForPaperTick({ preferredFunder });
  const mispricing = await buildMispricingFeatureVectors(loaded.candidates);
  const externalSignals = await buildExternalSignalFeatureVectors(loaded.candidates);

  const result = computeSimpleBaselineScores(loaded.candidates);
  const scores = result.scored.map((x) => x.score).sort((a, b) => a - b);
  const top = [...result.scored]
    .sort((a, b) => (b.score === a.score ? a.candidate.recommendationId.localeCompare(b.candidate.recommendationId) : b.score - a.score))
    .slice(0, 20);

  console.log("simple baseline scorer");
  console.log("funder used:", loaded.shadowDiagnostics.funderUsedForLoad ?? preferredFunder ?? "none");
  console.log("candidates loaded:", loaded.candidates.length);
  console.log("weights:", JSON.stringify(result.weights));
  console.log("distribution normalized:");
  console.log(
    JSON.stringify(
      {
        min: fmt(result.statsNormalized.min),
        max: fmt(result.statsNormalized.max),
        mean: fmt(result.statsNormalized.mean),
        std: fmt(result.statsNormalized.std),
        p10: fmt(percentile(scores, 0.1)),
        p50: fmt(percentile(scores, 0.5)),
        p90: fmt(percentile(scores, 0.9)),
      },
      null,
      2
    )
  );

  console.log("top 20 candidates:");
  for (const row of top) {
    const mf = mispricing.byRecommendationId[row.candidate.recommendationId];
    const ef = externalSignals.byRecommendationId[row.candidate.recommendationId];
    console.log(
      JSON.stringify({
        score: Number(fmt(row.score)),
        recommendationId: row.candidate.recommendationId,
        assetId: row.candidate.assetId,
        marketId: row.candidate.marketId,
        side: row.candidate.side,
        entryPrice: row.candidate.entryPrice,
        spreadNorm: Number(fmt(row.features.spreadNormalized)),
        pricePos: Number(fmt(row.features.pricePosition)),
        momentum: Number(fmt(row.features.momentum)),
        liquidity: Number(fmt(row.features.liquidity)),
        mispricing: mf
          ? {
              meanReversionSignal: Number(fmt(mf.meanReversionSignal)),
              priceVelocityChange: Number(fmt(mf.priceVelocityChange)),
              marketDisagreementProxy: Number(fmt(mf.marketDisagreementProxy)),
              spreadAdjustedConfidence: Number(fmt(mf.spreadAdjustedConfidence)),
              crossMarketComparison: Number(fmt(mf.crossMarketComparison)),
            }
          : null,
        externalSignals: ef
          ? {
              crossMarketConsistency: Number(fmt(ef.crossMarketConsistency)),
              timeToResolutionSignal: Number(fmt(ef.timeToResolutionSignal)),
              priceDriftSignal: Number(fmt(ef.priceDriftSignal)),
              marketActivityProxy: Number(fmt(ef.marketActivityProxy)),
              eventTypeHeuristic: Number(fmt(ef.eventTypeHeuristic)),
            }
          : null,
      })
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
