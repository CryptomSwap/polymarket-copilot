/**
 * Paper-only asset/market cooldown helpers. Scoped to (botType, assetId) / (botType, marketId)
 * so multi-bot overflow is not blocked by another bot's history on the same asset.
 *
 * Invalid/empty bot keys fail closed (treat as "in cooldown") so Prisma never runs a
 * widened query if `botType` were missing (Prisma strips `undefined` from where clauses).
 */

import { prisma } from "@/lib/db";

/** Returns normalized bot key, or null if missing/blank (caller should fail closed). */
export function normalizePaperCooldownBotKey(botType: string): string | null {
  const s = String(botType ?? "").trim();
  return s.length > 0 ? s : null;
}

/** Where clause: open paper row for (assetId, botKey) only — used by tests and implementation. */
export function paperCooldownWhereOpenForAsset(assetId: string, botKey: string) {
  return { AND: [{ assetId }, { botType: botKey }, { status: "open" as const }] };
}

/** Where clause: recently closed paper row for (assetId, botKey) — exitTime >= cooldownSince. */
export function paperCooldownWhereRecentClosedForAsset(
  assetId: string,
  botKey: string,
  cooldownSince: Date
) {
  return {
    AND: [
      { assetId },
      { botType: botKey },
      { status: "closed" as const },
      { exitTime: { gte: cooldownSince } },
    ],
  };
}

/** Where clause: open paper row for (marketId, botKey) only. */
export function paperCooldownWhereOpenForMarket(marketId: string, botKey: string) {
  return { AND: [{ marketId }, { botType: botKey }, { status: "open" as const }] };
}

/** Where clause: recently closed paper row for (marketId, botKey). */
export function paperCooldownWhereRecentClosedForMarket(
  marketId: string,
  botKey: string,
  cooldownSince: Date
) {
  return {
    AND: [
      { marketId },
      { botType: botKey },
      { status: "closed" as const },
      { exitTime: { gte: cooldownSince } },
    ],
  };
}

/**
 * True if there is an open paper trade, or a closed trade within the cooldown window,
 * for this asset and bot only. Duration semantics unchanged from engine legacy behavior.
 */
export async function hasOpenOrRecentPaperTrade(
  botType: string,
  assetId: string,
  cooldownHours: number
): Promise<boolean> {
  const botKey = normalizePaperCooldownBotKey(botType);
  if (botKey == null) return true;

  const open = await prisma.paperTrade.findFirst({
    where: paperCooldownWhereOpenForAsset(assetId, botKey),
  });
  if (open) return true;

  const cooldownSince = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
  const recentClosed = await prisma.paperTrade.findFirst({
    where: paperCooldownWhereRecentClosedForAsset(assetId, botKey, cooldownSince),
  });
  return recentClosed != null;
}

/**
 * Market-level cooldown for paper trades, scoped to botType. Optional (0 = disabled).
 */
export async function hasOpenOrRecentPaperTradeForMarket(
  botType: string,
  marketId: string,
  cooldownMarketHours: number
): Promise<boolean> {
  if (cooldownMarketHours <= 0) return false;
  const botKey = normalizePaperCooldownBotKey(botType);
  if (botKey == null) return true;

  const open = await prisma.paperTrade.findFirst({
    where: paperCooldownWhereOpenForMarket(marketId, botKey),
  });
  if (open) return true;

  const cooldownSince = new Date(Date.now() - cooldownMarketHours * 60 * 60 * 1000);
  const recentClosed = await prisma.paperTrade.findFirst({
    where: paperCooldownWhereRecentClosedForMarket(marketId, botKey, cooldownSince),
  });
  return recentClosed != null;
}
