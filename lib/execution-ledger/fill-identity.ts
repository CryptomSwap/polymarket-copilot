/**
 * Fill identity: derive stable or fallback unique id for ledger dedupe.
 * Priority: exchangeFillId (venue) > venueTradeId > deterministic weak fingerprint.
 * Use weak fingerprint only when upstream does not provide a stable id; log explicitly.
 */

/**
 * Build a deterministic fallback fill id when the venue does not provide one.
 * WEAK: same logical fill with different timing/encoding could produce a different key.
 * Use only when exchangeFillId and venueTradeId are absent. Log when used.
 */
export function buildWeakFillFingerprint(params: {
  funderAddress: string;
  exchangeOrderId: string;
  filledAt: Date;
  size: number;
  price: number;
  side?: string;
}): string {
  const t = params.filledAt.getTime();
  const size = Number.isFinite(params.size) ? params.size : 0;
  const price = Number.isFinite(params.price) ? params.price : 0;
  const side = (params.side ?? "").slice(0, 4);
  return `fp:${params.funderAddress.toLowerCase()}:${params.exchangeOrderId}:${t}:${size}:${price}:${side}`;
}

export type FillIdentityStrength = "exchange_fill_id" | "venue_trade_id" | "weak_fingerprint";

export interface ResolvedFillIdentity {
  /** Value to use as exchangeFillId in ledger (required for unique key). */
  exchangeFillId: string;
  /** Optional venue trade id if available. */
  venueTradeId: string | null;
  /** How the id was derived; weak_fingerprint means we had no stable upstream id. */
  strength: FillIdentityStrength;
}

/**
 * Resolve the best available fill identity for ledger persistence.
 * Prefer exchangeFillId from upstream, then venueTradeId, then weak fingerprint.
 */
export function resolveFillIdentity(params: {
  funderAddress: string;
  exchangeOrderId: string;
  exchangeFillId: string | null | undefined;
  venueTradeId: string | null | undefined;
  filledAt: Date;
  size: number;
  price: number;
  side?: string;
}): ResolvedFillIdentity {
  if (params.exchangeFillId && params.exchangeFillId.trim().length > 0) {
    return {
      exchangeFillId: params.exchangeFillId.trim(),
      venueTradeId: params.venueTradeId?.trim() || null,
      strength: "exchange_fill_id",
    };
  }
  if (params.venueTradeId && params.venueTradeId.trim().length > 0) {
    const fallback = buildWeakFillFingerprint({
      funderAddress: params.funderAddress,
      exchangeOrderId: params.exchangeOrderId,
      filledAt: params.filledAt,
      size: params.size,
      price: params.price,
      side: params.side,
    });
    return {
      exchangeFillId: fallback,
      venueTradeId: params.venueTradeId.trim(),
      strength: "venue_trade_id",
    };
  }
  const weak = buildWeakFillFingerprint({
    funderAddress: params.funderAddress,
    exchangeOrderId: params.exchangeOrderId,
    filledAt: params.filledAt,
    size: params.size,
    price: params.price,
    side: params.side,
  });
  return {
    exchangeFillId: weak,
    venueTradeId: null,
    strength: "weak_fingerprint",
  };
}
