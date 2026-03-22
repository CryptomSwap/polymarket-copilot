/**
 * Post-trade evaluation: compute markouts and classify shadow candidates.
 * Conservative: only evaluate when we have price data; no fake precision.
 */

import { prisma } from "@/lib/db";
import { getSnapshotPriceAtOrBefore } from "@/lib/polymarket/market-price-snapshot-lookup";
import { markout, classify } from "./markout";
import type { ShadowEvaluationSummary } from "./types";

const HORIZON_1H_MS = 60 * 60 * 1000;
const HORIZON_6H_MS = 6 * HORIZON_1H_MS;
const HORIZON_24H_MS = 24 * HORIZON_1H_MS;

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

export interface EvaluateShadowOptions {
  /** Min age (ms) of candidate before evaluating (default 25h so 24h markout is available). */
  minAgeMs?: number;
  /** Max candidates to evaluate in one run (default 100). */
  limit?: number;
  /** Max candidates for short-horizon backfill pass (default 200). */
  shortHorizonLimit?: number;
}

/**
 * Evaluate unevaluated shadow candidates older than minAgeMs.
 * Uses MarketPriceSnapshot for decision-time and horizon prices; falls back to intendedPrice for price0 if no snapshot.
 */
export async function evaluateShadowCandidates(
  options: EvaluateShadowOptions = {}
): Promise<{ evaluated: number; errors: string[] }> {
  const minAgeMs = options.minAgeMs ?? 25 * 60 * 60 * 1000;
  const limit = options.limit ?? 100;
  const shortHorizonLimit = options.shortHorizonLimit ?? 200;
  const cutoff = new Date(Date.now() - minAgeMs);
  const cutoff6h = new Date(Date.now() - HORIZON_6H_MS);
  const errors: string[] = [];
  let evaluated = 0;

  // Short-horizon truth backfill: persist markout1h/markout6h as soon as 6h data is mature.
  // Keep evaluatedAt null so full 24h outcome classification still happens later via canonical path.
  const shortHorizonCandidates = await prisma.shadowCandidate.findMany({
    where: {
      evaluatedAt: null,
      createdAt: { lte: cutoff6h },
      OR: [{ markout1h: null }, { markout6h: null }],
    },
    orderBy: { createdAt: "asc" },
    take: shortHorizonLimit,
  });
  for (const c of shortHorizonCandidates) {
    try {
      const marketId = c.marketId ?? "";
      const assetId = c.assetId;
      const side = c.side;
      const decisionAt = c.createdAt;
      const price0Num = parseNum(c.intendedPrice);
      const price0 = (await getSnapshotPriceAtOrBefore(marketId, assetId, decisionAt)) ?? price0Num ?? null;
      if (price0 == null) continue;
      const at1h = new Date(decisionAt.getTime() + HORIZON_1H_MS);
      const at6h = new Date(decisionAt.getTime() + HORIZON_6H_MS);
      const price1h = await getSnapshotPriceAtOrBefore(marketId, assetId, at1h);
      const price6h = await getSnapshotPriceAtOrBefore(marketId, assetId, at6h);
      const m1h = price1h != null ? markout(side, price0, price1h) : null;
      const m6h = price6h != null ? markout(side, price0, price6h) : null;
      const updateData: { markout1h?: string; markout6h?: string } = {};
      if (c.markout1h == null && m1h != null) updateData.markout1h = String(m1h);
      if (c.markout6h == null && m6h != null) updateData.markout6h = String(m6h);
      if (Object.keys(updateData).length > 0) {
        await prisma.shadowCandidate.update({
          where: { id: c.id },
          data: updateData,
        });
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  const candidates = await prisma.shadowCandidate.findMany({
    where: { evaluatedAt: null, createdAt: { lte: cutoff } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  for (const c of candidates) {
    try {
      const marketId = c.marketId ?? "";
      const assetId = c.assetId;
      const side = c.side;
      const price0Num = parseNum(c.intendedPrice);
      const decisionAt = c.createdAt;

      const price0 =
        (await getSnapshotPriceAtOrBefore(marketId, assetId, decisionAt)) ?? price0Num ?? null;
      if (price0 == null) {
        await prisma.shadowCandidate.update({
          where: { id: c.id },
          data: {
            evaluatedAt: new Date(),
            evaluationNotes: "no_decision_price",
          },
        });
        evaluated++;
        continue;
      }

      const at1h = new Date(decisionAt.getTime() + HORIZON_1H_MS);
      const at6h = new Date(decisionAt.getTime() + HORIZON_6H_MS);
      const at24h = new Date(decisionAt.getTime() + HORIZON_24H_MS);

      const price1h = await getSnapshotPriceAtOrBefore(marketId, assetId, at1h);
      const price6h = await getSnapshotPriceAtOrBefore(marketId, assetId, at6h);
      const price24h = await getSnapshotPriceAtOrBefore(marketId, assetId, at24h);

      const m1h = price1h != null ? markout(side, price0, price1h) : null;
      const m6h = price6h != null ? markout(side, price0, price6h) : null;
      const m24h = price24h != null ? markout(side, price0, price24h) : null;

      const outcomeClassification = classify(c.wasBlocked, side, m24h);
      const notes: string[] = [];
      if (m24h == null && (price1h != null || price6h != null)) notes.push("partial_price_data");

      await prisma.shadowCandidate.update({
        where: { id: c.id },
        data: {
          evaluatedAt: new Date(),
          markout1h: m1h != null ? String(m1h) : null,
          markout6h: m6h != null ? String(m6h) : null,
          markout24h: m24h != null ? String(m24h) : null,
          outcomeClassification,
          evaluationNotes: notes.length > 0 ? notes.join("; ") : null,
        },
      });
      evaluated++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return { evaluated, errors };
}

/**
 * Aggregate summary stats from ShadowCandidate table.
 */
export async function getShadowEvaluationSummary(
  funderAddress?: string
): Promise<ShadowEvaluationSummary> {
  const where = funderAddress ? { funderAddress: funderAddress.toLowerCase() } : {};
  const all = await prisma.shadowCandidate.findMany({ where });
  const blocked = all.filter((c) => c.wasBlocked);
  const allowed = all.filter((c) => !c.wasBlocked);
  const evaluated = all.filter((c) => c.evaluatedAt != null);
  const withClassification = evaluated.filter((c) => c.outcomeClassification != null);

  const goodBlocks = withClassification.filter((c) => c.outcomeClassification === "good_block").length;
  const badBlocks = withClassification.filter((c) => c.outcomeClassification === "bad_block").length;
  const goodAllows = withClassification.filter((c) => c.outcomeClassification === "good_allow").length;
  const badAllows = withClassification.filter((c) => c.outcomeClassification === "bad_allow").length;

  const byClassification: Record<string, number> = {
    good_block: goodBlocks,
    bad_block: badBlocks,
    good_allow: goodAllows,
    bad_allow: badAllows,
  };

  const markouts1h = evaluated.map((c) => parseNum(c.markout1h)).filter((n): n is number => n != null);
  const markouts6h = evaluated.map((c) => parseNum(c.markout6h)).filter((n): n is number => n != null);
  const markouts24h = evaluated.map((c) => parseNum(c.markout24h)).filter((n): n is number => n != null);

  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  return {
    totalCandidates: all.length,
    blockedCandidates: blocked.length,
    allowedCandidates: allowed.length,
    evaluatedCandidates: evaluated.length,
    goodBlocks,
    badBlocks,
    goodAllows,
    badAllows,
    averageMarkout1h: avg(markouts1h),
    averageMarkout6h: avg(markouts6h),
    averageMarkout24h: avg(markouts24h),
    byClassification,
  };
}

/**
 * Fetch recent shadow candidate rows for API sample.
 */
export async function getShadowCandidatesSample(
  limit: number = 50,
  funderAddress?: string
): Promise<Array<Record<string, unknown>>> {
  const where = funderAddress ? { funderAddress: funderAddress.toLowerCase() } : {};
  const rows = await prisma.shadowCandidate.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    funderAddress: r.funderAddress,
    assetId: r.assetId,
    marketId: r.marketId,
    side: r.side,
    intendedPrice: r.intendedPrice,
    intendedSize: r.intendedSize,
    wasBlocked: r.wasBlocked,
    wasSubmitted: r.wasSubmitted,
    wasFilled: r.wasFilled,
    createdAt: r.createdAt.toISOString(),
    evaluatedAt: r.evaluatedAt?.toISOString() ?? null,
    markout1h: r.markout1h,
    markout6h: r.markout6h,
    markout24h: r.markout24h,
    outcomeClassification: r.outcomeClassification,
    evaluationNotes: r.evaluationNotes,
  }));
}
