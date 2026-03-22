/**
 * Batch backfill path/regime columns on MlShadowTrainingExample from MarketPriceSnapshot.
 * Report-only / ops use; does not change labels or trading.
 */

import type { PrismaClient } from "@prisma/client";
import {
  computePathRegimeFeaturesFromPreDecisionPoints,
  fetchSnapshotsForShadowRow,
  filterPreDecisionPoints,
  mergePathFeaturesIntoUpdate,
  pathSlotNeedsFill,
} from "./path-features-from-snapshots";

export interface BackfillPathRegimeFeaturesOptions {
  /** Max rows to scan (default 5000). */
  limit?: number;
  /** Batch size for DB updates (default 50). */
  batchSize?: number;
  dryRun?: boolean;
  /** Optional: only rows with this label non-null (reduces scan for bootstrap experiments). */
  requireLabelGoodDecision12h?: boolean;
}

export interface BackfillPathRegimeFeaturesResult {
  scanned: number;
  updated: number;
  skippedNoMarket: number;
  skippedNoSnapshots: number;
  skippedNothingToFill: number;
  errors: string[];
}

function pathRowNeedsAnyFill(row: {
  momentum1hBps: string | null;
  momentum6hBps: string | null;
  volatility1hBps: string | null;
  volatility6hBps: string | null;
  distanceFromMid: string | null;
  timeToCloseHours: string | null;
  liquidityTrend: string | null;
}): boolean {
  return (
    pathSlotNeedsFill(row.momentum1hBps) ||
    pathSlotNeedsFill(row.momentum6hBps) ||
    pathSlotNeedsFill(row.volatility1hBps) ||
    pathSlotNeedsFill(row.volatility6hBps) ||
    pathSlotNeedsFill(row.distanceFromMid) ||
    pathSlotNeedsFill(row.timeToCloseHours) ||
    pathSlotNeedsFill(row.liquidityTrend)
  );
}

export async function backfillPathRegimeFeaturesForMlExamples(
  prisma: PrismaClient,
  options: BackfillPathRegimeFeaturesOptions = {}
): Promise<BackfillPathRegimeFeaturesResult> {
  const {
    limit = 5000,
    batchSize = 50,
    dryRun = false,
    requireLabelGoodDecision12h = false,
  } = options;

  const HORIZON_12H_MS = 12 * 60 * 60 * 1000;
  const snapshotMarketIdCache = new Map<string, string[]>();
  const errors: string[] = [];
  let scanned = 0;
  let updated = 0;
  let skippedNoMarket = 0;
  let skippedNoSnapshots = 0;
  let skippedNothingToFill = 0;

  const candidates = await prisma.mlShadowTrainingExample.findMany({
    where: {
      ...(requireLabelGoodDecision12h ? { labelGoodDecision12h: { not: null } } : {}),
      OR: [
        { momentum1hBps: null },
        { momentum6hBps: null },
        { volatility1hBps: null },
        { volatility6hBps: null },
        { distanceFromMid: null },
        { timeToCloseHours: null },
        { liquidityTrend: null },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      marketId: true,
      assetId: true,
      createdAt: true,
      intendedPrice: true,
      momentum1hBps: true,
      momentum6hBps: true,
      volatility1hBps: true,
      volatility6hBps: true,
      distanceFromMid: true,
      timeToCloseHours: true,
      liquidityTrend: true,
    },
  });

  const uniqueMarketKeys = [
    ...new Set(candidates.map((r) => r.marketId).filter(Boolean) as string[]),
  ];
  const syncedMarkets =
    uniqueMarketKeys.length > 0
      ? await prisma.syncedMarket.findMany({
          where: {
            OR: [{ id: { in: uniqueMarketKeys } }, { conditionId: { in: uniqueMarketKeys } }],
          },
          select: { id: true, conditionId: true, endDate: true },
        })
      : [];
  const endDateByKey = new Map<string, Date>();
  for (const m of syncedMarkets) {
    if (m.endDate) {
      const d = m.endDate instanceof Date ? m.endDate : new Date(m.endDate);
      if (m.id) endDateByKey.set(m.id, d);
      if (m.conditionId) endDateByKey.set(m.conditionId, d);
    }
  }
  function marketEndFor(marketId: string | null): Date | null {
    if (!marketId) return null;
    return endDateByKey.get(marketId) ?? null;
  }

  function parseNum(s: string | null | undefined): number | null {
    if (s == null || s === "") return null;
    const n = parseFloat(String(s).trim());
    return Number.isFinite(n) ? n : null;
  }

  for (let i = 0; i < candidates.length; i += batchSize) {
    const chunk = candidates.slice(i, i + batchSize);
    for (const row of chunk) {
      scanned++;
      if (!pathRowNeedsAnyFill(row)) {
        skippedNothingToFill++;
        continue;
      }
      if (!row.marketId || !row.assetId) {
        skippedNoMarket++;
        continue;
      }

      const decisionAt = row.createdAt;
      const at12h = new Date(decisionAt.getTime() + HORIZON_12H_MS);
      let fullPoints: Awaited<ReturnType<typeof fetchSnapshotsForShadowRow>> = [];
      try {
        fullPoints = await fetchSnapshotsForShadowRow(
          prisma,
          {
            decisionAt,
            forwardHorizonEnd: at12h,
            marketId: row.marketId,
            assetId: row.assetId,
          },
          { marketIdAliasCache: snapshotMarketIdCache }
        );
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
        skippedNoSnapshots++;
        continue;
      }

      if (fullPoints.length === 0) {
        skippedNoSnapshots++;
        continue;
      }

      const pre = filterPreDecisionPoints(fullPoints, decisionAt);
      const pathFeatures = computePathRegimeFeaturesFromPreDecisionPoints(pre, decisionAt, {
        marketEndDate: marketEndFor(row.marketId),
        intendedPriceFallback: parseNum(row.intendedPrice),
      });

      const patch = mergePathFeaturesIntoUpdate(
        {
          momentum1hBps: row.momentum1hBps,
          momentum6hBps: row.momentum6hBps,
          volatility1hBps: row.volatility1hBps,
          volatility6hBps: row.volatility6hBps,
          distanceFromMid: row.distanceFromMid,
          timeToCloseHours: row.timeToCloseHours,
          liquidityTrend: row.liquidityTrend,
        },
        pathFeatures
      );

      if (Object.keys(patch).length === 0) {
        skippedNothingToFill++;
        continue;
      }

      if (!dryRun) {
        try {
          await prisma.mlShadowTrainingExample.update({
            where: { id: row.id },
            data: patch,
          });
          updated++;
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      } else {
        updated++;
      }
    }
  }

  return {
    scanned,
    updated,
    skippedNoMarket,
    skippedNoSnapshots,
    skippedNothingToFill,
    errors,
  };
}
