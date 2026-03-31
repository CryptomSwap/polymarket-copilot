/**
 * Shared paper close loop: conditional `status = open` updates, markout resolution, paperClose metadata.
 * Used by hold-due closes and per-bot cap rebalance.
 */

import { prisma } from "@/lib/db";
import { markout } from "@/lib/shadow-evaluation/markout";
import { resolvePaperTradeCloseExitPrice } from "@/lib/polymarket/market-price-snapshot-lookup";
import { mergePaperCloseMetadata } from "./paper-close-helpers";

export type PaperTradeCloseRow = {
  id: string;
  botType: string;
  marketId: string;
  assetId: string;
  side: string;
  entryPrice: string;
  entryTime: Date;
  metadataJson: string | null;
  status: string;
  /** Open-time shadow score; optional (e.g. rebalance ordering when metadata has no admission score). */
  score?: number;
};

export type PaperTradeCloseHoldReason = {
  holdHours: number;
  reasonCode: string;
  /** If set, merged into `metadataJson.paperClose.closeReason`. */
  closeReason?: string;
};

function parseNum(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

/** Shared close loop: each trade closes at its own hold horizon and reason code. Idempotent via `updateMany` + `status: open`. */
export async function closeOpenPaperTradeRows(
  openTrades: PaperTradeCloseRow[],
  now: Date,
  resolveHoldAndReason: (t: PaperTradeCloseRow) => PaperTradeCloseHoldReason
): Promise<{
  closedCount: number;
  closedWithMarkout: number;
  closedWithoutMarkout: number;
  closedByBot: Record<string, number>;
  closedTradeIds: string[];
  errors: string[];
  closeReasonCounts: Record<string, number>;
}> {
  const errors: string[] = [];
  const closeReasonCounts: Record<string, number> = {};
  let closedCount = 0;
  let closedWithMarkout = 0;
  let closedWithoutMarkout = 0;
  const closedByBot: Record<string, number> = {};
  const closedTradeIds: string[] = [];

  for (const t of openTrades) {
    try {
      const {
        holdHours: maxHoldHours,
        reasonCode: resolvedReasonCode,
        closeReason: resolvedCloseReason,
      } = resolveHoldAndReason(t);
      const horizonMs = maxHoldHours * 60 * 60 * 1000;
      const atHorizon = new Date(t.entryTime.getTime() + horizonMs);
      const price0 = parseNum(t.entryPrice);

      if (price0 == null || price0 <= 0) {
        const exitTime = new Date();
        const um = await prisma.paperTrade.updateMany({
          where: { id: t.id, status: "open" },
          data: {
            status: "closed",
            exitTime,
            metadataJson: mergePaperCloseMetadata(t.metadataJson, {
              closeReason: "no_entry_price",
              exitTimeIso: now.toISOString(),
              closeReasonCode: resolvedReasonCode,
              maxHoldHours,
            }),
            updatedAt: exitTime,
          },
        });
        if (um.count === 0) continue;
        closedTradeIds.push(t.id);
        closedCount++;
        closedWithoutMarkout++;
        closedByBot[t.botType] = (closedByBot[t.botType] ?? 0) + 1;
        closeReasonCounts.no_entry_price = (closeReasonCounts.no_entry_price ?? 0) + 1;
        continue;
      }

      const exit = await resolvePaperTradeCloseExitPrice(t.marketId, t.assetId, atHorizon);
      if (!exit) {
        const exitTime = new Date();
        const um = await prisma.paperTrade.updateMany({
          where: { id: t.id, status: "open" },
          data: {
            status: "closed",
            exitTime,
            metadataJson: mergePaperCloseMetadata(t.metadataJson, {
              closeReason: "no_exit_price_snapshot",
              horizonAtIso: atHorizon.toISOString(),
              exitTimeIso: now.toISOString(),
              closeReasonCode: resolvedReasonCode,
              maxHoldHours,
            }),
            updatedAt: exitTime,
          },
        });
        if (um.count === 0) continue;
        closedTradeIds.push(t.id);
        closedCount++;
        closedWithoutMarkout++;
        closedByBot[t.botType] = (closedByBot[t.botType] ?? 0) + 1;
        closeReasonCounts.no_exit_price_snapshot = (closeReasonCounts.no_exit_price_snapshot ?? 0) + 1;
        console.warn(
          `[paper-trading] Closed paper trade id=${t.id} without markout (no MarketPriceSnapshot for market/asset)`
        );
        continue;
      }

      const m12 = markout(t.side, price0, exit.price);
      const pnlPct = m12 != null ? String(m12) : null;
      const exitTime = new Date();
      const markoutKey =
        exit.source === "lte"
          ? "markout_snapshot_lte"
          : exit.source === "gte_after_horizon"
            ? "markout_snapshot_gte_after_horizon"
            : "markout_snapshot_latest_any";
      closeReasonCounts[markoutKey] = (closeReasonCounts[markoutKey] ?? 0) + 1;

      const um = await prisma.paperTrade.updateMany({
        where: { id: t.id, status: "open" },
        data: {
          status: "closed",
          exitPrice: String(exit.price),
          exitTime,
          markout12h: pnlPct,
          pnlPct,
          pnlDollars: null,
          metadataJson: mergePaperCloseMetadata(t.metadataJson, {
            ...(resolvedCloseReason != null && resolvedCloseReason !== ""
              ? { closeReason: resolvedCloseReason }
              : {}),
            exitPriceSource: exit.source,
            snapshotCapturedAt: exit.snapshotCapturedAt,
            horizonAtIso: atHorizon.toISOString(),
            closeReasonCode: resolvedReasonCode,
            maxHoldHours,
          }),
          updatedAt: exitTime,
        },
      });
      if (um.count === 0) continue;
      closedTradeIds.push(t.id);
      closedCount++;
      closedByBot[t.botType] = (closedByBot[t.botType] ?? 0) + 1;
      if (pnlPct != null) closedWithMarkout++;
      else closedWithoutMarkout++;
      console.log(
        `[paper-trading] Closed paper trade id=${t.id} markout12h=${pnlPct} exitSource=${exit.source}`
      );
    } catch (e) {
      errors.push(`Trade ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    closedCount,
    closedWithMarkout,
    closedWithoutMarkout,
    closedByBot,
    closedTradeIds,
    errors,
    closeReasonCounts,
  };
}
