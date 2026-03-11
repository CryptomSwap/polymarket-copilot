/**
 * Build RecommendationExecutionOutcome from OrderIntents/ExecutedOrders and recommendations.
 * Links recommendation -> intent -> executed order; compares suggested vs actual; pulls forward returns from evaluations.
 * Analytics only; no autonomous trading.
 * TODO: Post-trade journaling can consume outcomes when available.
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

export interface RebuildResult {
  created: number;
  updated: number;
  errors: string[];
}

/**
 * Infer suggested side from recommendation action (e.g. STRONG_BUY/BUY_SMALL -> BUY, TRIM/EXIT -> SELL).
 */
function suggestedSideFromAction(action: string): "BUY" | "SELL" {
  const u = action.toUpperCase();
  if (u.includes("BUY") || u === "WATCH") return "BUY";
  if (u.includes("TRIM") || u.includes("EXIT")) return "SELL";
  return "BUY";
}

/**
 * Rebuild execution outcomes for all order intents that have a recommendationId.
 */
export async function rebuildExecutionOutcomes(funderAddress?: string): Promise<RebuildResult> {
  const errors: string[] = [];
  let created = 0;
  let updated = 0;

  const intents = await prisma.orderIntent.findMany({
    where: {
      recommendationId: { not: null },
      ...(funderAddress ? { funderAddress: funderAddress.toLowerCase() } : {}),
    },
    include: { executedOrders: true },
    orderBy: { createdAt: "desc" },
  });

  for (const intent of intents) {
    const recId = intent.recommendationId;
    if (!recId) continue;

    try {
      const rec = await prisma.recommendation.findUnique({
        where: { id: recId },
        include: { marketSignal: true },
      });
      if (!rec) continue;

      const funder = intent.funderAddress;
      const suggestedSide = suggestedSideFromAction(rec.action);
      const suggestedSize = rec.suggestedSize;
      const suggestedPrice =
        rec.suggestedEntryMin && rec.suggestedEntryMax
          ? (parseNum(rec.suggestedEntryMin) + parseNum(rec.suggestedEntryMax)) / 2
          : parseNum(rec.marketSignal.marketPrice);

      const actualSide = intent.side;
      const actualSize = intent.size;
      const actualPrice = parseNum(intent.limitPrice);
      const exec = intent.executedOrders[0];

      const matchedSuggestedSide = actualSide.toUpperCase() === suggestedSide;
      const suggestedSizeNum = parseNum(suggestedSize);
      const actualSizeNum = parseNum(actualSize);
      const matchedSuggestedSize =
        suggestedSizeNum > 0 && actualSizeNum > 0
          ? Math.abs(actualSizeNum - suggestedSizeNum) / suggestedSizeNum < 0.2
          : null;
      const matchedSuggestedPrice =
        suggestedPrice > 0 && actualPrice > 0
          ? Math.abs(actualPrice - suggestedPrice) / suggestedPrice < 0.1
          : null;

      const overridden = !matchedSuggestedSize || !matchedSuggestedPrice;

      let slippage: string | null = null;
      if (suggestedPrice > 0 && actualPrice > 0) {
        const slip = (actualPrice - suggestedPrice) / suggestedPrice;
        slippage = toStr(slip);
      }

      let fillStatus: string | null = exec?.status ?? intent.status ?? null;

      let forwardReturn1h: string | null = null;
      let forwardReturn6h: string | null = null;
      let forwardReturn24h: string | null = null;
      const latestEval = await prisma.recommendationEvaluation.findFirst({
        where: { recommendationId: recId },
        orderBy: { evaluatedAt: "desc" },
      });
      if (latestEval) {
        forwardReturn1h = latestEval.priceChange1h;
        forwardReturn6h = latestEval.priceChange6h;
        forwardReturn24h = latestEval.priceChange24h;
      }

      const pnlIfActed =
        forwardReturn24h != null && actualSizeNum > 0 && actualPrice > 0
          ? toStr(parseNum(forwardReturn24h) * actualSizeNum * actualPrice)
          : null;
      const pnlIfIgnored = null;

      const existing = await prisma.recommendationExecutionOutcome.findFirst({
        where: { recommendationId: recId, orderIntentId: intent.id },
      });

      const data = {
        recommendationId: recId,
        funderAddress: funder,
        orderIntentId: intent.id,
        executedOrderId: exec?.id ?? null,
        actedOn: true,
        overridden,
        matchedSuggestedSide,
        matchedSuggestedSize: matchedSuggestedSize ?? false,
        matchedSuggestedPrice: matchedSuggestedPrice ?? false,
        suggestedSize,
        actualSize: intent.size,
        suggestedPrice: toStr(suggestedPrice),
        actualPrice: intent.limitPrice,
        slippage,
        fillStatus,
        forwardReturn1h,
        forwardReturn6h,
        forwardReturn24h,
        pnlIfActed,
        pnlIfIgnored,
      };

      if (existing) {
        await prisma.recommendationExecutionOutcome.update({
          where: { id: existing.id },
          data: {
            executedOrderId: data.executedOrderId,
            overridden: data.overridden,
            matchedSuggestedSide: data.matchedSuggestedSide,
            matchedSuggestedSize: data.matchedSuggestedSize,
            matchedSuggestedPrice: data.matchedSuggestedPrice,
            actualSize: data.actualSize,
            actualPrice: data.actualPrice,
            slippage: data.slippage,
            fillStatus: data.fillStatus,
            forwardReturn1h: data.forwardReturn1h,
            forwardReturn6h: data.forwardReturn6h,
            forwardReturn24h: data.forwardReturn24h,
            pnlIfActed: data.pnlIfActed,
            pnlIfIgnored: data.pnlIfIgnored,
          },
        });
        updated++;
      } else {
        await prisma.recommendationExecutionOutcome.create({
          data: {
            recommendationId: data.recommendationId,
            funderAddress: data.funderAddress,
            orderIntentId: data.orderIntentId ?? undefined,
            executedOrderId: data.executedOrderId ?? undefined,
            actedOn: data.actedOn,
            overridden: data.overridden,
            matchedSuggestedSide: data.matchedSuggestedSide,
            matchedSuggestedSize: data.matchedSuggestedSize,
            matchedSuggestedPrice: data.matchedSuggestedPrice,
            suggestedSize: data.suggestedSize ?? undefined,
            actualSize: data.actualSize ?? undefined,
            suggestedPrice: data.suggestedPrice ?? undefined,
            actualPrice: data.actualPrice ?? undefined,
            slippage: data.slippage ?? undefined,
            fillStatus: data.fillStatus ?? undefined,
            forwardReturn1h: data.forwardReturn1h ?? undefined,
            forwardReturn6h: data.forwardReturn6h ?? undefined,
            forwardReturn24h: data.forwardReturn24h ?? undefined,
            pnlIfActed: data.pnlIfActed ?? undefined,
            pnlIfIgnored: data.pnlIfIgnored ?? undefined,
          },
        });
        created++;
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return { created, updated, errors };
}
