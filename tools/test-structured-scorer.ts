import "dotenv/config";
import { getFunderForPaperTradingTick } from "../lib/decision/recompute";
import { loadShadowCandidatesForPaperTick, normalizePreferredFunderForShadowLoad } from "../lib/paper-trading/candidates";
import { buildExternalSignalFeatureVectors } from "../lib/paper-trading/features/external_signal_features";
import { buildStructuredScoringModel, scoreStructuredCandidates } from "../lib/paper-trading/structured_scorer";

function fmt(n: number): string {
  return n.toFixed(6);
}

function stats(values: number[]): { min: number; max: number; mean: number; std: number } {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, std: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return { min, max, mean, std: Math.sqrt(Math.max(0, variance)) };
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
  const model = await buildStructuredScoringModel(30);
  const external = await buildExternalSignalFeatureVectors(loaded.candidates);
  const scored = scoreStructuredCandidates(loaded.candidates, model, external.byRecommendationId);

  const scores = scored.map((x) => x.score).sort((a, b) => a - b);
  const s = stats(scores);
  const top = [...scored]
    .sort((a, b) =>
      b.score === a.score
        ? a.candidate.recommendationId.localeCompare(b.candidate.recommendationId)
        : b.score - a.score
    )
    .slice(0, 20);

  console.log("structured scorer");
  console.log("funder used:", loaded.shadowDiagnostics.funderUsedForLoad ?? preferredFunder ?? "none");
  console.log("candidates loaded:", loaded.candidates.length);
  console.log(
    "model summary:",
    JSON.stringify(
      {
        lookbackDays: model.lookbackDays,
        sampleSize: model.sampleSize,
        midRange: [model.midRangeMin, model.midRangeMax],
        spreadCutoffs: model.spreadCutoffs,
        globalMeanOutcome: Number(fmt(model.globalMeanOutcome)),
        globalStdOutcome: Number(fmt(model.globalStdOutcome)),
        optionalWeights: {
          crossMarketConsistency: Number(fmt(model.optionalWeights.crossMarketConsistency)),
          priceDriftSignal: Number(fmt(model.optionalWeights.priceDriftSignal)),
        },
      },
      null,
      2
    )
  );
  console.log(
    "score distribution:",
    JSON.stringify(
      {
        min: fmt(s.min),
        max: fmt(s.max),
        mean: fmt(s.mean),
        std: fmt(s.std),
        p10: fmt(percentile(scores, 0.1)),
        p50: fmt(percentile(scores, 0.5)),
        p90: fmt(percentile(scores, 0.9)),
      },
      null,
      2
    )
  );

  console.log("top 20 candidates:");
  for (const r of top) {
    console.log(
      JSON.stringify({
        score: Number(fmt(r.score)),
        linear: Number(fmt(r.linear)),
        recommendationId: r.candidate.recommendationId,
        assetId: r.candidate.assetId,
        marketId: r.candidate.marketId,
        side: r.candidate.side,
        entryPrice: r.candidate.entryPrice,
        priceBand: r.priceBand,
        spreadQuartile: r.spreadQuartile,
        external: r.external
          ? {
              crossMarketConsistency: Number(fmt(r.external.crossMarketConsistency)),
              priceDriftSignal: Number(fmt(r.external.priceDriftSignal)),
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
