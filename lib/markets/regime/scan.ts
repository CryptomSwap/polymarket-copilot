/**
 * Run full regime scan for a market: features -> classifier -> signals.
 * Optionally persist snapshot for evaluation and future ML.
 */

import { prisma } from "@/lib/db";
import { computeMarketRegimeFeatures } from "./features";
import { classifyRegime } from "./classifier";
import { getRegimeSignals } from "./signals";
import type { MarketRegimeFeatures } from "./features";
import type { RegimeResult } from "./classifier";
import type { RegimeSignals } from "./signals";

export interface RegimeScanResult {
  marketId: string;
  assetId: string;
  features: MarketRegimeFeatures;
  regime: RegimeResult;
  signals: RegimeSignals;
}

/**
 * Run regime scan for one market. Does not persist.
 */
export async function runRegimeScan(input: {
  marketId: string;
  assetId?: string;
}): Promise<RegimeScanResult | null> {
  const features = await computeMarketRegimeFeatures(input);
  if (!features) return null;

  const regime = classifyRegime(features);
  const signals = getRegimeSignals(features, regime.regime);

  return {
    marketId: features.marketId,
    assetId: features.assetId,
    features,
    regime,
    signals,
  };
}

/**
 * Persist regime snapshot for later evaluation and ML. Low-risk append-only.
 */
export async function persistRegimeSnapshot(result: RegimeScanResult): Promise<void> {
  await prisma.marketRegimeSnapshot.create({
    data: {
      marketId: result.marketId,
      assetId: result.assetId,
      regime: result.regime.regime,
      featuresJson: JSON.stringify(result.features),
      signalsJson: JSON.stringify(result.signals),
      explanation: result.regime.explanation,
    },
  });
}
