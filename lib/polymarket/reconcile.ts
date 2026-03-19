/**
 * Reconcile local OrderIntent/ExecutedOrder with synced UserOrder and fills (DB-based).
 * Supports partial fill state; persists OrderReconciliationSnapshot.
 * For runtime order lifecycle vs exchange truth (open orders from CLOB), see
 * lib/runtime/reconciliation/runtime-reconciliation.ts and runRuntimeReconciliation().
 * TODO: Live WS events can trigger reconcile updates.
 */

import { prisma } from "@/lib/db";
import { throwIfAborted } from "@/lib/ops/cancellation";

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

function toStr(n: number): string {
  return String(Number.isFinite(n) ? n : 0);
}

export interface ReconcileResult {
  reconciled: number;
  mismatches: number;
  errors: string[];
}

/**
 * Reconcile executed orders for a funder: compare local ExecutedOrder to UserOrder (synced), compute filled/remaining, flag mismatches.
 */
export async function reconcileOrders(
  funderAddress: string,
  opts?: { signal?: AbortSignal }
): Promise<ReconcileResult> {
  const funder = funderAddress.toLowerCase();
  const errors: string[] = [];
  let reconciled = 0;
  let mismatches = 0;

  const executed = await prisma.executedOrder.findMany({
    where: { funderAddress: funder },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const userOrders = await prisma.userOrder.findMany({
    where: { funderAddress: funder },
    select: { orderId: true, status: true, originalSize: true, sizeMatched: true },
  });
  const remoteByOrderId = new Map<string, (typeof userOrders)[0]>();
  for (const o of userOrders) {
    remoteByOrderId.set(o.orderId, o);
  }

  // Avoid N+1: prefetch fills once and group by (assetId, market).
  const fills = await prisma.userFill.findMany({
    where: { funderAddress: funder },
    select: { assetId: true, market: true, size: true, price: true },
  });
  const fillsByKey = new Map<string, Array<{ size: string; price: string }>>();
  for (const f of fills) {
    const key = `${String(f.assetId)}::${String(f.market)}`;
    const arr = fillsByKey.get(key) ?? [];
    arr.push({ size: f.size, price: f.price });
    fillsByKey.set(key, arr);
  }

  // Prefetch existing snapshots so we don't query per-order.
  const existing = await prisma.orderReconciliationSnapshot.findMany({
    where: { funderAddress: funder },
    select: { id: true, polymarketOrderId: true },
  });
  const existingByOrderId = new Map<string, string>();
  for (const row of existing) existingByOrderId.set(row.polymarketOrderId, row.id);

  for (const local of executed) {
    try {
      // Best-effort cancellation: Prisma queries can't be aborted, but we stop before starting new work.
      throwIfAborted(opts?.signal, "order_reconciliation");
      const remote = remoteByOrderId.get(local.polymarketOrderId);
      const localStatus = local.status ?? "submitted";
      const remoteStatus = remote?.status ?? null;

      const originalSize = remote ? parseNum(remote.originalSize) : parseNum(local.size);
      const sizeMatched = remote ? parseNum(remote.sizeMatched) : 0;
      const filledSize = sizeMatched;
      const remainingSize = Math.max(0, originalSize - sizeMatched);
      let avgFillPrice: number | null = null;
      const fillsForAsset = fillsByKey.get(`${String(local.assetId)}::${String(local.marketId)}`) ?? [];
      if (fillsForAsset.length > 0) {
        let totalValue = 0;
        let totalSize = 0;
        for (const f of fillsForAsset) {
          const sz = parseNum(f.size);
          const pr = parseNum(f.price);
          totalValue += sz * pr;
          totalSize += sz;
        }
        if (totalSize > 0) avgFillPrice = totalValue / totalSize;
      }

      const statusMismatch = remote != null && remoteStatus !== null && localStatus !== remoteStatus;
      const sizeMismatch = remote != null && Math.abs(parseNum(local.size) - originalSize) > 1e-6;
      const mismatch = statusMismatch || sizeMismatch;
      if (mismatch) mismatches++;

      const details: Record<string, unknown> = {
        localStatus,
        remoteStatus,
        originalSize: toStr(originalSize),
        filledSize: toStr(filledSize),
        remainingSize: toStr(remainingSize),
        hasRemote: !!remote,
      };

      const data = {
        localStatus,
        remoteStatus: remoteStatus ?? undefined,
        filledSize: toStr(filledSize),
        remainingSize: toStr(remainingSize),
        avgFillPrice: avgFillPrice != null ? toStr(avgFillPrice) : undefined,
        mismatch,
        detailsJson: JSON.stringify(details),
      };
      const snapshotId = existingByOrderId.get(local.polymarketOrderId) ?? null;
      if (snapshotId) {
        await prisma.orderReconciliationSnapshot.update({
          where: { id: snapshotId },
          data,
        });
      } else {
        const created = await prisma.orderReconciliationSnapshot.create({
          data: {
            funderAddress: funder,
            polymarketOrderId: local.polymarketOrderId,
            ...data,
          },
        });
        existingByOrderId.set(local.polymarketOrderId, created.id);
      }
      reconciled++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return { reconciled, mismatches, errors };
}
