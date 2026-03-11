/**
 * Portfolio recompute: rebuild DerivedPosition, PortfolioSnapshot, BehaviorFlag from synced data.
 * Called after user sync or via POST /api/portfolio/recompute.
 */

import { prisma } from "@/lib/db";
import { getStoredCredentials } from "./auth";
import { computeBehaviorFlags } from "./behavior";
import { computeSnapshot, persistSnapshot } from "./analytics";
import { derivePositionsFromFills, type DerivedPositionRow, type ResolutionDiagnostics } from "./portfolio";
import { traceResolutionForAssetIds, type PositionResolutionTrace } from "@/lib/portfolio/resolution-diagnostics";

export interface RecomputeResult {
  funderAddress: string;
  positionsWritten: number;
  snapshotCreated: boolean;
  flagsWritten: number;
  errors: string[];
  /** Resolution counts for canonical market linkage (when positions were derived). */
  resolutionDiagnostics?: ResolutionDiagnostics;
  /** Why specific sample positions failed to resolve (when unresolved > 0). */
  resolutionFailureSamples?: PositionResolutionTrace[];
}

/** Build create payload for DerivedPosition from a derived row. Single place for write shape. */
function derivedPositionCreateData(funderAddress: string, row: DerivedPositionRow) {
  return {
    funderAddress,
    marketId: row.marketId,
    syncedMarketId: row.syncedMarketId ?? undefined,
    assetId: row.assetId,
    marketTitle: row.marketTitle,
    outcome: row.outcome,
    side: row.side,
    size: row.size,
    avgEntry: row.avgEntry,
    lastPrice: row.lastPrice,
    costBasis: row.costBasis,
    marketValue: row.marketValue,
    unrealizedPnl: row.unrealizedPnl,
    realizedPnl: row.realizedPnl,
    reservedOrderSize: row.reservedOrderSize,
    reservedOrderValue: row.reservedOrderValue,
    category: row.category,
    theme: row.theme,
    openedAt: row.openedAt,
  };
}

/**
 * Resolve funder address: from stored credentials or from connected wallet.
 */
export async function getFunderForRecompute(): Promise<string | null> {
  const creds = await getStoredCredentials();
  if (creds?.funderAddress) return creds.funderAddress.toLowerCase();
  const wallet = await prisma.connectedWallet.findFirst({ orderBy: { updatedAt: "desc" } });
  return wallet?.funderAddress?.toLowerCase() ?? null;
}

/**
 * Full recompute: clear existing derived data for funder, derive positions, persist snapshot and flags.
 */
export async function recomputePortfolio(funderAddress?: string): Promise<RecomputeResult> {
  const errors: string[] = [];
  const resolved = funderAddress?.toLowerCase() ?? (await getFunderForRecompute());
  if (!resolved) {
    return {
      funderAddress: "",
      positionsWritten: 0,
      snapshotCreated: false,
      flagsWritten: 0,
      errors: ["No funder address: connect wallet and save connection (or init credentials)."],
    };
  }

  let positions: DerivedPositionRow[] = [];
  let resolutionDiagnostics: ResolutionDiagnostics | null = null;
  try {
    const derived = await derivePositionsFromFills(resolved);
    positions = derived.rows;
    resolutionDiagnostics = derived.diagnostics;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "derivePositionsFromFills failed");
    return {
      funderAddress: resolved,
      positionsWritten: 0,
      snapshotCreated: false,
      flagsWritten: 0,
      errors,
    };
  }

  if (resolutionDiagnostics && resolutionDiagnostics.total > 0) {
    console.info("[recompute] canonical linkage", JSON.stringify({
      total: resolutionDiagnostics.total,
      byMarketId: resolutionDiagnostics.resolvedByMarketId,
      byConditionId: resolutionDiagnostics.resolvedByConditionId,
      byAssetId: resolutionDiagnostics.resolvedByAssetId,
      unresolved: resolutionDiagnostics.unresolved,
    }));
  }

  let resolutionFailureSamples: PositionResolutionTrace[] | undefined;
  if (resolutionDiagnostics && resolutionDiagnostics.unresolved > 0 && positions.length > 0) {
    const unresolvedAssetIds = positions
      .filter((r) => r.syncedMarketId == null)
      .slice(0, 5)
      .map((r) => r.assetId);
    if (unresolvedAssetIds.length > 0) {
      try {
        resolutionFailureSamples = await traceResolutionForAssetIds(unresolvedAssetIds, resolved);
      } catch (e) {
        console.warn("[recompute] resolution sample trace failed", e);
      }
    }
  }

  await prisma.derivedPosition.deleteMany({ where: { funderAddress: resolved } });
  await prisma.behaviorFlag.deleteMany({ where: { funderAddress: resolved } });

  let positionsWritten = 0;
  for (const row of positions) {
    try {
      await prisma.derivedPosition.create({
        data: derivedPositionCreateData(resolved, row),
      });
      positionsWritten++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : `Position create failed for ${row.assetId}`);
    }
  }

  const openOrdersCount = await prisma.userOrder.count({ where: { funderAddress: resolved } });
  const snapshotData = computeSnapshot({
    funderAddress: resolved,
    positions,
    openOrdersCount,
  });
  let snapshotCreated = false;
  try {
    await persistSnapshot(resolved, snapshotData);
    snapshotCreated = true;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "persistSnapshot failed");
  }

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentFillsCount24h = await prisma.userFill.count({
    where: { funderAddress: resolved, syncedAt: { gte: oneDayAgo } },
  });
  const flags = computeBehaviorFlags(resolved, positions, { recentFillsCount24h });
  let flagsWritten = 0;
  for (const f of flags) {
    try {
      await prisma.behaviorFlag.create({
        data: {
          funderAddress: f.funderAddress,
          type: f.type,
          severity: f.severity,
          marketTitle: f.marketTitle,
          description: f.description,
          metadata: f.metadata ? (JSON.parse(JSON.stringify(f.metadata)) as object) : undefined,
        },
      });
      flagsWritten++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : `BehaviorFlag create failed for ${f.type}`);
    }
  }

  return {
    funderAddress: resolved,
    positionsWritten,
    snapshotCreated,
    flagsWritten,
    errors,
    resolutionDiagnostics: resolutionDiagnostics ?? undefined,
    resolutionFailureSamples,
  };
}
