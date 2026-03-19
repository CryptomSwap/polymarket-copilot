/**
 * Idempotency helpers for the execution ledger: key normalization,
 * deterministic key building, duplicate-constraint detection, create-or-get.
 * Generic and explicit; no business logic.
 */

/** Prisma error code for unique constraint violation. */
export const PRISMA_UNIQUE_VIOLATION = "P2002";

export function isPrismaUniqueViolation(e: unknown): boolean {
  if (e == null || typeof e !== "object") return false;
  const code = (e as { code?: string }).code;
  return code === PRISMA_UNIQUE_VIOLATION;
}

/**
 * Normalize an idempotency key: trim, collapse whitespace, enforce max length.
 * Returns null for empty/blank input.
 */
export function normalizeIdempotencyKey(key: string | null | undefined): string | null {
  if (key == null) return null;
  const s = String(key).trim().replace(/\s+/g, " ");
  return s.length > 0 ? s : null;
}

/**
 * Build a deterministic idempotency key from components. Components are joined with a delimiter;
 * order matters. Suitable for intent dedupe (e.g. funder + recommendationId + slot, or funder + assetId + side + timestamp slot).
 */
export function buildIdempotencyKey(components: (string | number | null | undefined)[], delimiter = ":"): string {
  const parts = components
    .map((c) => (c == null ? "" : String(c).trim()))
    .filter((p) => p.length > 0);
  return parts.join(delimiter) || `empty_${Date.now()}`;
}

/** Normalize price/size for idempotency (avoid float noise). */
function norm(n: number, decimals: number): string {
  return Number.isFinite(n) ? n.toFixed(decimals) : "0";
}

/**
 * Build idempotency key for runtime-generated intents. Same inputs => same key.
 * Slot (e.g. 60s) allows same rec to create a new intent after a minute.
 */
export function buildRuntimeIntentIdempotencyKey(params: {
  funderAddress: string;
  source: string;
  recommendationId?: string | null;
  assetId: string;
  side: string;
  orderType: string;
  limitPrice: number;
  requestedSize: number;
  slotSeconds?: number;
}): string {
  const slot = params.slotSeconds != null && params.slotSeconds > 0
    ? Math.floor(Date.now() / (params.slotSeconds * 1000))
    : null;
  return buildIdempotencyKey([
    params.funderAddress.toLowerCase().trim(),
    params.source,
    params.recommendationId ?? "",
    params.assetId,
    params.side,
    params.orderType,
    norm(params.limitPrice, 4),
    norm(params.requestedSize, 4),
    slot ?? "",
  ]);
}

/**
 * Build idempotency key for API/manual order placement. Same inputs => same key.
 * Use when creating OrderIntent from place-order API so duplicate requests (e.g. retry) return the same intent.
 */
export function buildApiOrderIdempotencyKey(params: {
  funderAddress: string;
  assetId: string;
  side: string;
  orderType: string;
  limitPrice: number;
  requestedSize: number;
  recommendationId?: string | null;
  clientOrderId?: string | null;
}): string {
  return buildIdempotencyKey([
    params.funderAddress.toLowerCase().trim(),
    "api",
    params.recommendationId ?? "",
    params.assetId,
    params.side,
    params.orderType,
    norm(params.limitPrice, 4),
    norm(params.requestedSize, 4),
    params.clientOrderId ?? "",
  ]);
}

/**
 * Result of a create-or-get by unique key: either the existing row id or the newly created id,
 * and a flag indicating whether it was a duplicate (existing).
 */
export interface CreateOrGetResult<T = string> {
  id: T;
  existing: boolean;
}

/**
 * Execute a create callback; if it throws a unique constraint violation, run the get callback
 * and return the existing id. If get returns null, rethrow the original error.
 * Other errors are not caught.
 */
export async function createOrGetByUniqueKey<TId = string>(params: {
  create: () => Promise<TId>;
  getExisting: () => Promise<TId | null>;
}): Promise<CreateOrGetResult<TId>> {
  try {
    const id = await params.create();
    return { id, existing: false };
  } catch (e) {
    if (!isPrismaUniqueViolation(e)) throw e;
    const existingId = await params.getExisting();
    if (existingId == null) throw e;
    return { id: existingId, existing: true };
  }
}
