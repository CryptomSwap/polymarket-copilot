/**
 * Reconcile local OrderIntent/ExecutedOrder with synced UserOrder and fills.
 * Supports partial fill state; persists OrderReconciliationSnapshot.
 * TODO: Live WS events can trigger reconcile updates.
 */

import { prisma } from "@/lib/db";

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
export async function reconcileOrders(funderAddress: string): Promise<ReconcileResult> {
  const funder = funderAddress.toLowerCase();
  const errors: string[] = [];
  let reconciled = 0;
  let mismatches = 0;

  const executed = await prisma.executedOrder.findMany({
    where: { funderAddress: funder },
    orderBy: { createdAt: "desc" },
  });

  const userOrders = await prisma.userOrder.findMany({
    where: { funderAddress: funder },
  });
  const remoteByOrderId = new Map<string, (typeof userOrders)[0]>();
  for (const o of userOrders) {
    remoteByOrderId.set(o.orderId, o);
  }

  for (const local of executed) {
    try {
      const remote = remoteByOrderId.get(local.polymarketOrderId);
      const localStatus = local.status ?? "submitted";
      const remoteStatus = remote?.status ?? null;

      const originalSize = remote ? parseNum(remote.originalSize) : parseNum(local.size);
      const sizeMatched = remote ? parseNum(remote.sizeMatched) : 0;
      const filledSize = sizeMatched;
      const remainingSize = Math.max(0, originalSize - sizeMatched);
      let avgFillPrice: number | null = null;
      const fillsForAsset = await prisma.userFill.findMany({
        where: { funderAddress: funder, assetId: local.assetId, market: local.marketId },
      });
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

      const existing = await prisma.orderReconciliationSnapshot.findFirst({
        where: { funderAddress: funder, polymarketOrderId: local.polymarketOrderId },
      });
      const data = {
        localStatus,
        remoteStatus: remoteStatus ?? undefined,
        filledSize: toStr(filledSize),
        remainingSize: toStr(remainingSize),
        avgFillPrice: avgFillPrice != null ? toStr(avgFillPrice) : undefined,
        mismatch,
        detailsJson: JSON.stringify(details),
      };
      if (existing) {
        await prisma.orderReconciliationSnapshot.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await prisma.orderReconciliationSnapshot.create({
          data: {
            funderAddress: funder,
            polymarketOrderId: local.polymarketOrderId,
            ...data,
          },
        });
      }
      reconciled++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return { reconciled, mismatches, errors };
}
