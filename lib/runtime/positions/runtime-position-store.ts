/**
 * Runtime position state: in-memory, streaming-first view of per-asset exposure.
 *
 * DESIGN:
 * - This is the FAST EXECUTION-PLANE LIVE INVENTORY. It updates immediately from
 *   fill/order events and does not wait for debounced DB projections.
 * - The CANONICAL portfolio projection (DerivedPosition, recompute flows) remains
 *   separate and debounced; this store is for runtime decisions only.
 */

/** Confidence in the runtime position view (e.g. after out-of-order or repair). */
export type PositionConfidence = "live" | "reconciling" | "degraded";

export interface RuntimePositionState {
  funderAddress: string;
  assetId: string;
  marketId: string;
  outcome: string;
  side: "LONG" | "SHORT";
  /** Net shares currently held (display units). Long = positive, short = negative stored as netShares with side. */
  netShares: number;
  /** Volume-weighted average entry price (0–1 for probability markets). */
  avgEntryPrice: number;
  /** Realized PnL to date (approximate from fills). */
  realizedPnlApprox: number;
  /** Unrealized PnL based on last known mark (approximate). */
  unrealizedPnlApprox: number;
  /** Time of last fill applied to this position. */
  lastFillAt: Date | null;
  /** Exposure notional (|netShares| * mark or avgEntry if no mark). */
  exposureNotional: number;
  /** Data quality: live = in sync, reconciling = catch-up, degraded = stale or inconsistent. */
  confidence: PositionConfidence;
  /** Time when this position was first opened (first buy). */
  openedAt: Date | null;
  /** Time when this position was last updated. */
  updatedAt: Date;
  /** Optional: current mark price when known (for unrealized / marketValue). */
  markPrice?: number | null;
}

/** Partial update for a position (undefined = leave as-is, null = clear). */
export interface RuntimePositionStatePatch {
  marketId?: string | null;
  outcome?: string | null;
  side?: "LONG" | "SHORT" | null;
  netShares?: number | null;
  avgEntryPrice?: number | null;
  realizedPnlApprox?: number | null;
  unrealizedPnlApprox?: number | null;
  lastFillAt?: Date | null;
  exposureNotional?: number | null;
  confidence?: PositionConfidence | null;
  openedAt?: Date | null;
  updatedAt?: Date | null;
  markPrice?: number | null;
}

/** Snapshot of all positions (read-only). */
export interface RuntimePositionSnapshot {
  positions: RuntimePositionState[];
  at: Date;
}

export interface RuntimePositionStore {
  /** Get position by funder and asset. */
  getPosition(funderAddress: string, assetId: string): RuntimePositionState | null;
  /** Get all positions for a funder. */
  getPositionsForFunder(funderAddress: string): RuntimePositionState[];
  /** Get all positions in the store (all funders). */
  getAll(): RuntimePositionState[];
  /** Replace full state for one position. */
  upsertPosition(state: RuntimePositionState): void;
  /** Partial update; merges into existing or no-op if no position. */
  patch(funderAddress: string, assetId: string, patch: RuntimePositionStatePatch): void;
  /** Apply a single fill: update netShares, avgEntryPrice, realizedPnlApprox, lastFillAt. */
  applyFill(params: ApplyFillParams): void;
  /** Mark position as reconciling (e.g. catch-up in progress). */
  markReconciling(funderAddress: string, assetId: string): void;
  /** Mark position as degraded (stale or inconsistent). */
  markDegraded(funderAddress: string, assetId: string): void;
  /** Read-only snapshot of all positions. */
  snapshot(): RuntimePositionSnapshot;
  deletePosition(funderAddress: string, assetId: string): void;
  clear(): void;
}

export interface ApplyFillParams {
  funderAddress: string;
  assetId: string;
  marketId: string;
  outcome: string;
  side: "BUY" | "SELL";
  /** Filled size in display units. */
  size: number;
  /** Fill price (0–1). */
  price: number;
  filledAt: Date;
}

const DEFAULT_CONFIDENCE: PositionConfidence = "live";

function defaultPosition(
  funderAddress: string,
  assetId: string,
  marketId: string,
  outcome: string,
  side: "LONG" | "SHORT"
): RuntimePositionState {
  const now = new Date();
  return {
    funderAddress,
    assetId,
    marketId,
    outcome,
    side,
    netShares: 0,
    avgEntryPrice: 0,
    realizedPnlApprox: 0,
    unrealizedPnlApprox: 0,
    lastFillAt: null,
    exposureNotional: 0,
    confidence: DEFAULT_CONFIDENCE,
    openedAt: null,
    updatedAt: now,
    markPrice: null,
  };
}

function clonePosition(s: RuntimePositionState): RuntimePositionState {
  return {
    ...s,
    lastFillAt: s.lastFillAt ? new Date(s.lastFillAt.getTime()) : null,
    openedAt: s.openedAt ? new Date(s.openedAt.getTime()) : null,
    updatedAt: new Date(s.updatedAt.getTime()),
  };
}

function applyPatch(
  base: RuntimePositionState,
  patch: RuntimePositionStatePatch
): RuntimePositionState {
  const next = { ...base };
  if (patch.marketId !== undefined) next.marketId = patch.marketId ?? "";
  if (patch.outcome !== undefined) next.outcome = patch.outcome ?? "";
  if (patch.side !== undefined) next.side = patch.side ?? "LONG";
  if (patch.netShares !== undefined) next.netShares = patch.netShares ?? 0;
  if (patch.avgEntryPrice !== undefined) next.avgEntryPrice = patch.avgEntryPrice ?? 0;
  if (patch.realizedPnlApprox !== undefined) next.realizedPnlApprox = patch.realizedPnlApprox ?? 0;
  if (patch.unrealizedPnlApprox !== undefined) next.unrealizedPnlApprox = patch.unrealizedPnlApprox ?? 0;
  if (patch.lastFillAt !== undefined) next.lastFillAt = patch.lastFillAt ? new Date(patch.lastFillAt.getTime()) : null;
  if (patch.exposureNotional !== undefined) next.exposureNotional = patch.exposureNotional ?? 0;
  if (patch.confidence !== undefined) next.confidence = patch.confidence ?? DEFAULT_CONFIDENCE;
  if (patch.openedAt !== undefined) next.openedAt = patch.openedAt ? new Date(patch.openedAt.getTime()) : null;
  if (patch.updatedAt !== undefined && patch.updatedAt != null)
    next.updatedAt = new Date(patch.updatedAt.getTime());
  if (patch.markPrice !== undefined) next.markPrice = patch.markPrice ?? null;
  return next;
}

/**
 * In-memory runtime position store.
 * Keys: funderAddress::assetId. No Prisma; hot path is memory-only.
 */
export class InMemoryRuntimePositionStore implements RuntimePositionStore {
  private readonly byKey = new Map<string, RuntimePositionState>();

  private static key(funderAddress: string, assetId: string): string {
    return `${funderAddress.toLowerCase()}::${assetId}`;
  }

  getPosition(funderAddress: string, assetId: string): RuntimePositionState | null {
    const s = this.byKey.get(InMemoryRuntimePositionStore.key(funderAddress, assetId));
    return s ? clonePosition(s) : null;
  }

  getPositionsForFunder(funderAddress: string): RuntimePositionState[] {
    const prefix = `${funderAddress.toLowerCase()}::`;
    return Array.from(this.byKey.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => clonePosition(value));
  }

  getAll(): RuntimePositionState[] {
    return Array.from(this.byKey.values()).map(clonePosition);
  }

  upsertPosition(state: RuntimePositionState): void {
    this.byKey.set(InMemoryRuntimePositionStore.key(state.funderAddress, state.assetId), clonePosition(state));
  }

  patch(funderAddress: string, assetId: string, patch: RuntimePositionStatePatch): void {
    const key = InMemoryRuntimePositionStore.key(funderAddress, assetId);
    const prev = this.byKey.get(key);
    if (!prev) return;
    const updatedAt =
      patch.updatedAt !== undefined
        ? (patch.updatedAt != null ? new Date(patch.updatedAt.getTime()) : new Date())
        : new Date();
    const next = applyPatch(prev, { ...patch, updatedAt });
    this.byKey.set(key, next);
  }

  applyFill(params: ApplyFillParams): void {
    const { funderAddress, assetId, marketId, outcome, side, size, price, filledAt } = params;
    if (size <= 0) return;
    const key = InMemoryRuntimePositionStore.key(funderAddress, assetId);
    const prev = this.byKey.get(key);
    const sideNorm: "LONG" | "SHORT" = side === "BUY" ? "LONG" : "SHORT";
    const signedSize = side === "BUY" ? size : -size;
    const now = new Date(filledAt.getTime());

    let next: RuntimePositionState;
    if (!prev) {
      next = defaultPosition(funderAddress, assetId, marketId, outcome, sideNorm);
      next.netShares = Math.abs(signedSize);
      next.avgEntryPrice = price;
      next.lastFillAt = now;
      next.openedAt = now;
      next.updatedAt = now;
      next.exposureNotional = next.netShares * price;
    } else {
      const prevSigned = prev.side === "LONG" ? prev.netShares : -prev.netShares;
      const newSigned = prevSigned + signedSize;
      let newNetShares: number;
      let newSide: "LONG" | "SHORT";
      let newAvg: number;
      let newRealized = prev.realizedPnlApprox;

      if (newSigned >= 0) {
        newSide = "LONG";
        newNetShares = newSigned;
      } else {
        newSide = "SHORT";
        newNetShares = -newSigned;
      }

      // Realized PnL when closing long (sell) or short (buy)
      if (prevSigned > 0 && signedSize < 0) {
        const closeSize = Math.min(prev.netShares, size);
        if (closeSize > 0) newRealized += closeSize * (price - prev.avgEntryPrice);
      } else if (prevSigned < 0 && signedSize > 0) {
        const closeSize = Math.min(prev.netShares, size);
        if (closeSize > 0) newRealized += closeSize * (prev.avgEntryPrice - price);
      }

      // Volume-weighted avg when adding; when closing/flipping use price for new side
      if (newNetShares === 0) {
        newAvg = 0;
      } else if (
        (prevSigned >= 0 && signedSize > 0) ||
        (prevSigned <= 0 && signedSize < 0)
      ) {
        const prevCost = prevSigned * prev.avgEntryPrice;
        const addCost = signedSize * price;
        newAvg = (prevCost + addCost) / newSigned;
      } else {
        newAvg = price;
      }

      const mark = prev.markPrice ?? newAvg;
      next = {
        ...prev,
        side: newSide,
        netShares: newNetShares,
        avgEntryPrice: newAvg,
        realizedPnlApprox: newRealized,
        lastFillAt: now,
        updatedAt: now,
        exposureNotional: newNetShares * mark,
      };
    }
    this.byKey.set(key, next);
  }

  markReconciling(funderAddress: string, assetId: string): void {
    this.patch(funderAddress, assetId, { confidence: "reconciling", updatedAt: new Date() });
  }

  markDegraded(funderAddress: string, assetId: string): void {
    this.patch(funderAddress, assetId, { confidence: "degraded", updatedAt: new Date() });
  }

  snapshot(): RuntimePositionSnapshot {
    const positions = Array.from(this.byKey.values()).map(clonePosition);
    return { positions, at: new Date() };
  }

  deletePosition(funderAddress: string, assetId: string): void {
    this.byKey.delete(InMemoryRuntimePositionStore.key(funderAddress, assetId));
  }

  clear(): void {
    this.byKey.clear();
  }
}
