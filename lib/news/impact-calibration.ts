/**
 * Calibration: compare predicted impact to observed price moves using MarketPriceSnapshot.
 * Populates impactObserved* and calibrationError* on MarketEventLink. Idempotent.
 * E12.1: Uses correct outcome (explicit, YES token, or first asset), sets calibrationConfidence,
 * and applies safety guards (no snapshots, event too young, price diff > 0.9).
 */

import { prisma } from "@/lib/db";

const HORIZONS = [
  { key: "5m", minutes: 5 },
  { key: "30m", minutes: 30 },
  { key: "2h", minutes: 120 },
  { key: "24h", minutes: 24 * 60 },
] as const;

const TOLERANCE_MINUTES = 10;
const MIN_HORIZON_MINUTES = 5;
const PRICE_DIFF_SNAPSHOT_ERROR = 0.9;

async function getPriceAt(marketId: string, assetId: string, at: Date): Promise<number | null> {
  const tolMs = TOLERANCE_MINUTES * 60 * 1000;
  const snap = await prisma.marketPriceSnapshot.findFirst({
    where: {
      marketId,
      assetId,
      capturedAt: { gte: new Date(at.getTime() - tolMs), lte: new Date(at.getTime() + tolMs) },
    },
    orderBy: { capturedAt: "asc" },
  });
  if (!snap) {
    const before = await prisma.marketPriceSnapshot.findFirst({
      where: { marketId, assetId, capturedAt: { lte: at } },
      orderBy: { capturedAt: "desc" },
    });
    if (!before) return null;
    return parseFloat(before.price);
  }
  return parseFloat(snap.price);
}

/** Check if we have any snapshot for this market/asset within tolerance of the baseline time. */
async function hasSnapshotInTolerance(marketId: string, assetId: string, at: Date): Promise<boolean> {
  const tolMs = TOLERANCE_MINUTES * 60 * 1000;
  const count = await prisma.marketPriceSnapshot.count({
    where: {
      marketId,
      assetId,
      capturedAt: { gte: new Date(at.getTime() - tolMs), lte: new Date(at.getTime() + tolMs) },
    },
  });
  if (count > 0) return true;
  const before = await prisma.marketPriceSnapshot.findFirst({
    where: { marketId, assetId, capturedAt: { lte: at } },
    orderBy: { capturedAt: "desc" },
  });
  return before != null;
}

/**
 * Resolve which asset to use for calibration and the confidence in that choice.
 * 1.0 = explicit outcome (calibrationOutcomeIndex from previous run), 0.6 = inferred YES, 0.3 = fallback first asset.
 */
async function resolveCalibrationAsset(
  marketId: string,
  existingCalibrationOutcomeIndex: number | null | undefined
): Promise<{
  asset: { tokenId: string; outcomeIndex: number | null } | null;
  calibrationOutcomeIndex: number | null;
  calibrationConfidence: number;
}> {
  const assets = await prisma.syncedAsset.findMany({
    where: { syncedMarketId: marketId },
    orderBy: { outcomeIndex: "asc" },
  });
  if (assets.length === 0) {
    return { asset: null, calibrationOutcomeIndex: null, calibrationConfidence: 0 };
  }

  if (existingCalibrationOutcomeIndex != null) {
    const byIndex = assets.find((a) => a.outcomeIndex === existingCalibrationOutcomeIndex);
    if (byIndex) {
      return {
        asset: { tokenId: byIndex.tokenId, outcomeIndex: byIndex.outcomeIndex ?? null },
        calibrationOutcomeIndex: byIndex.outcomeIndex ?? existingCalibrationOutcomeIndex,
        calibrationConfidence: 1.0,
      };
    }
  }

  const yesAsset = assets.find(
    (a) => a.outcome?.toLowerCase() === "yes" || a.outcome?.toLowerCase() === "true"
  );
  if (yesAsset) {
    return {
      asset: { tokenId: yesAsset.tokenId, outcomeIndex: yesAsset.outcomeIndex ?? null },
      calibrationOutcomeIndex: yesAsset.outcomeIndex ?? 0,
      calibrationConfidence: 0.6,
    };
  }

  const first = assets[0];
  return {
    asset: { tokenId: first.tokenId, outcomeIndex: first.outcomeIndex ?? null },
    calibrationOutcomeIndex: first.outcomeIndex ?? 0,
    calibrationConfidence: 0.3,
  };
}

export interface ComputeObservedImpactResult {
  impactObserved5m: number | null;
  impactObserved30m: number | null;
  impactObserved2h: number | null;
  impactObserved24h: number | null;
  calibrationOutcomeIndex: number | null;
  calibrationConfidence: number;
}

/**
 * Compute observed impact for one link: price change from baseline (link createdAt) to each horizon.
 * Uses outcome alignment (explicit calibrationOutcomeIndex, YES token, or first asset) and safety guards.
 */
export async function computeObservedImpactForLink(
  link: {
    id: string;
    marketId: string;
    createdAt: Date;
    instantImpact: number | null;
    persistentImpact: number | null;
    calibrationOutcomeIndex?: number | null;
  },
  horizons: readonly { key: string; minutes: number }[] = HORIZONS
): Promise<ComputeObservedImpactResult> {
  const resolved = await resolveCalibrationAsset(
    link.marketId,
    link.calibrationOutcomeIndex
  );
  if (!resolved.asset) {
    return {
      impactObserved5m: null,
      impactObserved30m: null,
      impactObserved2h: null,
      impactObserved24h: null,
      calibrationOutcomeIndex: null,
      calibrationConfidence: 0,
    };
  }

  const { asset } = resolved;
  let { calibrationConfidence } = resolved;

  const basePrice = await getPriceAt(link.marketId, asset.tokenId, link.createdAt);

  const noSnapshotInTolerance = !(await hasSnapshotInTolerance(
    link.marketId,
    asset.tokenId,
    link.createdAt
  ));
  if (noSnapshotInTolerance || basePrice == null || basePrice <= 0) {
    return {
      impactObserved5m: null,
      impactObserved30m: null,
      impactObserved2h: null,
      impactObserved24h: null,
      calibrationOutcomeIndex: resolved.calibrationOutcomeIndex,
      calibrationConfidence: 0,
    };
  }

  const now = Date.now();
  const linkAgeMs = now - link.createdAt.getTime();

  const out: {
    impactObserved5m: number | null;
    impactObserved30m: number | null;
    impactObserved2h: number | null;
    impactObserved24h: number | null;
  } = {
    impactObserved5m: null,
    impactObserved30m: null,
    impactObserved2h: null,
    impactObserved24h: null,
  };

  for (const h of horizons) {
    const horizonMs = h.minutes * 60 * 1000;
    if (linkAgeMs < horizonMs - 60 * 1000) continue;
    const at = new Date(link.createdAt.getTime() + horizonMs);
    const price = await getPriceAt(link.marketId, asset.tokenId, at);
    if (price == null) continue;
    const observed = price - basePrice;
    if (Math.abs(observed) > PRICE_DIFF_SNAPSHOT_ERROR) {
      calibrationConfidence = 0;
    }
    const key = `impactObserved${h.key}` as keyof typeof out;
    (out as Record<string, number | null>)[key] = Math.max(-1, Math.min(1, observed));
  }

  return {
    ...out,
    calibrationOutcomeIndex: resolved.calibrationOutcomeIndex,
    calibrationConfidence,
  };
}

/**
 * Calibrate links: compute observed impacts and calibration errors, update DB.
 * Short horizons vs instantImpact, long vs persistentImpact.
 * Safety: skip conditions set calibrationConfidence = 0; calibration job never throws (per-link try/catch).
 */
export async function calibrateMarketEventLinks(opts?: {
  maxLinks?: number;
  lookbackHours?: number;
}): Promise<{ calibrated: number; errors: string[] }> {
  const maxLinks = opts?.maxLinks ?? 200;
  const lookbackHours = opts?.lookbackHours ?? 72;
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const errors: string[] = [];
  let calibrated = 0;

  const links = await prisma.marketEventLink.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: maxLinks,
  });

  for (const link of links) {
    try {
      const result = await computeObservedImpactForLink(link);
      const { calibrationOutcomeIndex, calibrationConfidence } = result;
      const instant = link.instantImpact ?? link.impactEstimate;
      const persistent = link.persistentImpact ?? link.impactEstimate;

      const err5m =
        result.impactObserved5m != null ? result.impactObserved5m - instant : null;
      const err30m =
        result.impactObserved30m != null ? result.impactObserved30m - instant : null;
      const err2h =
        result.impactObserved2h != null ? result.impactObserved2h - persistent : null;
      const err24h =
        result.impactObserved24h != null ? result.impactObserved24h - persistent : null;

      await prisma.marketEventLink.update({
        where: { id: link.id },
        data: {
          impactObserved5m: result.impactObserved5m,
          impactObserved30m: result.impactObserved30m,
          impactObserved2h: result.impactObserved2h,
          impactObserved24h: result.impactObserved24h,
          calibrationError5m: err5m,
          calibrationError30m: err30m,
          calibrationError2h: err2h,
          calibrationError24h: err24h,
          calibrationOutcomeIndex,
          calibrationConfidence,
        },
      });
      calibrated++;
    } catch (err) {
      errors.push(link.id + ": " + (err instanceof Error ? err.message : String(err)));
    }
  }

  return { calibrated, errors };
}
