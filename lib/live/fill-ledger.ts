/**
 * Legacy fill ledger: direct Prisma writes for recording fills and applied state.
 *
 * PREFERRED PATH: Use the execution-ledger service (recordFillAndReturnDedupResult, getAppliedFillsForRebuild)
 * for fill persistence and rebuild. The runtime fill path (e.g. user-feed-to-runtime) uses execution-ledger.
 * This module is still used by debug scripts and some tests; new code should use lib/execution-ledger.
 * See docs/ARCHITECTURE_CONSOLIDATION.md and audit-dumps/architecture-consolidation-cleanup-map.md.
 */

import { prisma } from "@/lib/db";

export type FillLedgerSource = "user_feed" | "replay";

export interface RecordFillParams {
  funderAddress: string;
  exchangeFillId: string;
  clientOrderId?: string | null;
  exchangeOrderId?: string | null;
  assetId: string;
  marketId: string;
  side: string;
  size: number;
  price: number;
  filledAt: Date;
  source: FillLedgerSource;
  payloadJson?: string | null;
}

export interface RecordFillResult {
  /** True if this was a new insert; false if duplicate (already present). */
  recorded: boolean;
  /** DB id of the row (existing or newly created). */
  id: string;
}

/**
 * Record a fill durably. If (funderAddress, exchangeFillId) already exists, returns recorded: false.
 * Call this before applying lifecycle/position so duplicates are skipped.
 */
export async function recordFill(params: RecordFillParams): Promise<RecordFillResult> {
  const {
    funderAddress,
    exchangeFillId,
    clientOrderId,
    exchangeOrderId,
    assetId,
    marketId,
    side,
    size,
    price,
    filledAt,
    source,
    payloadJson,
  } = params;
  const now = new Date();
  const normalizedFunder = funderAddress.toLowerCase();

  const existing = await prisma.fillLedgerEntry.findUnique({
    where: {
      funderAddress_exchangeFillId: { funderAddress: normalizedFunder, exchangeFillId },
    },
  });
  if (existing) {
    return { recorded: false, id: existing.id };
  }

  const created = await prisma.fillLedgerEntry.create({
    data: {
      funderAddress: normalizedFunder,
      exchangeFillId,
      clientOrderId: clientOrderId ?? null,
      exchangeOrderId: exchangeOrderId ?? null,
      assetId,
      marketId,
      side,
      size,
      price,
      filledAt,
      source,
      appliedToRuntimePosition: false,
      payloadJson: payloadJson ?? null,
      updatedAt: now,
    },
  });
  return { recorded: true, id: created.id };
}

/**
 * Mark a ledger entry as applied to runtime position. Idempotent.
 * Provide either id or (funderAddress + exchangeFillId).
 */
export async function markFillAppliedToPosition(by: { id?: string; funderAddress?: string; exchangeFillId?: string }): Promise<void> {
  const now = new Date();
  if (by.id) {
    await prisma.fillLedgerEntry.updateMany({
      where: { id: by.id, appliedToRuntimePosition: false },
      data: { appliedToRuntimePosition: true, appliedAt: now, updatedAt: now },
    });
    return;
  }
  const funder = by.funderAddress?.toLowerCase();
  const exchangeFillId = by.exchangeFillId;
  if (funder && exchangeFillId) {
    await prisma.fillLedgerEntry.updateMany({
      where: { funderAddress: funder, exchangeFillId, appliedToRuntimePosition: false },
      data: { appliedToRuntimePosition: true, appliedAt: now, updatedAt: now },
    });
  }
}

/**
 * Return whether the given fill has already been applied to runtime position.
 */
export async function isFillAppliedToPosition(funderAddress: string, exchangeFillId: string): Promise<boolean> {
  const funder = funderAddress.toLowerCase();
  const row = await prisma.fillLedgerEntry.findUnique({
    where: { funderAddress_exchangeFillId: { funderAddress: funder, exchangeFillId } },
    select: { appliedToRuntimePosition: true },
  });
  return row?.appliedToRuntimePosition ?? false;
}

export interface UnappliedFillEntry {
  id: string;
  funderAddress: string;
  exchangeFillId: string;
  assetId: string;
  marketId: string;
  side: string;
  size: number;
  price: number;
  filledAt: Date;
  outcome: string;
}

/**
 * All fills for a funder from the durable ledger, ordered by filledAt.
 * Used to rebuild runtime position store from truth (e.g. after restart).
 */
export async function getFillsForRebuild(funderAddress: string): Promise<UnappliedFillEntry[]> {
  const funder = funderAddress.toLowerCase();
  let rows: Awaited<ReturnType<typeof prisma.fillLedgerEntry.findMany>>;
  try {
    rows = await prisma.fillLedgerEntry.findMany({
      where: { funderAddress: funder },
      orderBy: { filledAt: "asc" },
      select: {
        id: true,
        funderAddress: true,
        exchangeFillId: true,
        assetId: true,
        marketId: true,
        side: true,
        size: true,
        price: true,
        filledAt: true,
        payloadJson: true,
      },
    });
  } catch (e) {
    console.error("[fill-ledger] getFillsForRebuild Prisma error", {
      funderAddress,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
  console.info("[fill-ledger] getFillsForRebuild", { funderAddress, rowCount: rows.length });
  try {
    return rows.map((r, index) => {
      try {
        return {
          id: r.id,
          funderAddress: r.funderAddress,
          exchangeFillId: r.exchangeFillId,
          assetId: r.assetId,
          marketId: r.marketId,
          side: r.side,
          size: r.size,
          price: r.price,
          filledAt: r.filledAt,
          outcome: parseOutcomeFromPayload(r.payloadJson),
        };
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        throw new Error(
          `getFillsForRebuild parse failed at row index ${index} id=${r.id} assetId=${r.assetId} side=${r.side} size=${r.size} price=${r.price}: ${msg}`
        );
      }
    });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("getFillsForRebuild parse failed")) throw e;
    console.error("[fill-ledger] getFillsForRebuild map/parse error", {
      funderAddress,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

/**
 * List fills not yet applied to runtime position, for cold-start replay. Ordered by filledAt.
 */
export async function getUnappliedFills(funderAddress?: string): Promise<UnappliedFillEntry[]> {
  const where: { appliedToRuntimePosition: boolean; funderAddress?: string } = { appliedToRuntimePosition: false };
  if (funderAddress) {
    where.funderAddress = funderAddress.toLowerCase();
  }
  const rows = await prisma.fillLedgerEntry.findMany({
    where,
    orderBy: { filledAt: "asc" },
    select: {
      id: true,
      funderAddress: true,
      exchangeFillId: true,
      assetId: true,
      marketId: true,
      side: true,
      size: true,
      price: true,
      filledAt: true,
      payloadJson: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    funderAddress: r.funderAddress,
    exchangeFillId: r.exchangeFillId,
    assetId: r.assetId,
    marketId: r.marketId,
    side: r.side,
    size: r.size,
    price: r.price,
    filledAt: r.filledAt,
    outcome: parseOutcomeFromPayload(r.payloadJson),
  }));
}

function parseOutcomeFromPayload(payloadJson: string | null): string {
  if (!payloadJson) return "";
  try {
    const p = JSON.parse(payloadJson) as Record<string, unknown>;
    return (typeof p.outcome === "string" ? p.outcome : "") as string;
  } catch {
    return "";
  }
}

/** Normalized fill for position updater (from ledger entry). */
export interface LedgerFillForPosition {
  funderAddress: string;
  assetId: string;
  marketId: string;
  outcome: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  filledAt: Date;
}

export function ledgerEntryToPositionFill(entry: UnappliedFillEntry): LedgerFillForPosition {
  try {
    const filledAt =
      entry.filledAt instanceof Date ? entry.filledAt : new Date(entry.filledAt as unknown as string | number);
    const side = entry.side as "BUY" | "SELL";
    return {
      funderAddress: entry.funderAddress,
      assetId: entry.assetId,
      marketId: entry.marketId,
      outcome: entry.outcome ?? "",
      side,
      size: entry.size,
      price: entry.price,
      filledAt,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `ledgerEntryToPositionFill failed id=${entry.id} assetId=${entry.assetId} side=${entry.side} size=${entry.size} price=${entry.price}: ${msg}`
    );
  }
}
