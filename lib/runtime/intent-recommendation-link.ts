/**
 * Resolve Recommendation (+ MarketSignal theme/category) for runtime intents when the bus
 * payload omits recommendationId. Read-only DB lookup; no trading or policy logic.
 */

import { prisma } from "@/lib/db";

export type RuntimeIntentRecommendationLink = {
  recommendationId: string;
  theme: string;
  category: string;
  marketTitle: string;
};

/**
 * Best-effort: latest Recommendation for this funder+market, preferring matching MarketSignal.outcome.
 */
export async function resolveRuntimeIntentRecommendationLink(params: {
  funderAddress: string;
  marketId: string;
  outcome: string;
}): Promise<RuntimeIntentRecommendationLink | null> {
  const funder = params.funderAddress.toLowerCase().trim();
  const marketId = params.marketId?.trim();
  if (!marketId) return null;

  const include = {
    marketSignal: { select: { theme: true, category: true, marketTitle: true } },
  } as const;

  /** Runtime intents often set `marketId` to Polymarket condition_id; MarketSignal may store that in `conditionId`. */
  const marketOrCondition = {
    OR: [{ marketId }, { conditionId: marketId }],
  } as const;

  const tight = await prisma.recommendation.findFirst({
    where: {
      marketSignal: {
        funderAddress: { equals: funder, mode: "insensitive" },
        outcome: { equals: params.outcome, mode: "insensitive" },
        ...marketOrCondition,
      },
    },
    orderBy: { createdAt: "desc" },
    include,
  });

  const rec =
    tight ??
    (await prisma.recommendation.findFirst({
      where: {
        marketSignal: {
          funderAddress: { equals: funder, mode: "insensitive" },
          ...marketOrCondition,
        },
      },
      orderBy: { createdAt: "desc" },
      include,
    }));

  if (!rec?.marketSignal) return null;

  const ms = rec.marketSignal;
  return {
    recommendationId: rec.id,
    theme: (ms.theme ?? "").trim(),
    category: (ms.category ?? "").trim(),
    marketTitle: (ms.marketTitle ?? "").trim(),
  };
}
