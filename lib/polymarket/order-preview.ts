/**
 * Order preview: risk and impact before placement.
 * Computes current exposure, post-trade exposure, concentration, theme impact, reserved capital, warnings.
 * Manual approval only; no autonomous trading.
 */

import { prisma } from "@/lib/db";

const CONCENTRATION_WARN_PCT = 40;
const CONCENTRATION_BLOCK_PCT = 70;
const THEME_WARN_PCT = 50;

function parseNum(s: string): number {
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export interface OrderPreviewInput {
  funderAddress: string;
  marketId: string;
  assetId?: string; // optional; resolved from marketId + outcome if missing
  outcome: string;
  side: string; // BUY, SELL
  limitPrice: string;
  size: string;
  recommendationId?: string | null;
}

export interface RiskPreview {
  currentExposure: { assetMarketValue: number; assetSize: number; themeExposure: number; themeLabel: string };
  postTradeExposure: { assetMarketValue: number; assetSize: number; themeExposure: number };
  concentrationImpact: { currentTopPct: number; postTopPct: number; currentThemePct: number; postThemePct: number };
  themeImpact: { theme: string; currentPct: number; postPct: number; deltaPct: number };
  reservedCapitalImpact: { currentReserved: number; reservedForAsset: number };
  warnings: string[];
  blocked: boolean;
}

/**
 * Build risk preview for an order. Validates market/asset/side/price/size and returns warnings.
 */
export async function buildOrderPreview(input: OrderPreviewInput): Promise<{
  valid: boolean;
  validationErrors: string[];
  riskPreview: RiskPreview | null;
  marketTitle: string | null;
}> {
  const { funderAddress, marketId, outcome, side, limitPrice, size } = input;
  let assetId = input.assetId;
  const validationErrors: string[] = [];
  const price = parseNum(limitPrice);
  const sizeNum = parseNum(size);

  if (!marketId) {
    validationErrors.push("Missing marketId");
    return { valid: false, validationErrors, riskPreview: null, marketTitle: null };
  }
  if (!assetId) {
    const resolved = await prisma.syncedAsset.findFirst({
      where: { syncedMarketId: marketId, outcome: { equals: outcome, mode: "insensitive" } },
    });
    assetId = resolved?.tokenId ?? "";
  }
  if (!assetId) {
    validationErrors.push("Could not resolve assetId from marketId and outcome");
    return { valid: false, validationErrors, riskPreview: null, marketTitle: null };
  }
  if (side !== "BUY" && side !== "SELL") {
    validationErrors.push("Side must be BUY or SELL");
    return { valid: false, validationErrors, riskPreview: null, marketTitle: null };
  }
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    validationErrors.push("Limit price must be between 0 and 1 (exclusive)");
    return { valid: false, validationErrors, riskPreview: null, marketTitle: null };
  }
  if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
    validationErrors.push("Size must be a positive number");
    return { valid: false, validationErrors, riskPreview: null, marketTitle: null };
  }

  const asset = await prisma.syncedAsset.findFirst({
    where: { tokenId: assetId!, syncedMarketId: marketId },
    include: { syncedMarket: true },
  });
  if (!asset) {
    validationErrors.push("Asset or market not found");
    return { valid: false, validationErrors, riskPreview: null, marketTitle: null };
  }
  const marketTitle = asset.syncedMarket.title;

  const positions = await prisma.derivedPosition.findMany({
    where: { funderAddress },
  });
  const openOrders = await prisma.userOrder.findMany({
    where: { funderAddress },
  });

  let totalExposure = 0;
  const byTheme = new Map<string, number>();
  let assetMarketValue = 0;
  let assetSize = 0;
  let themeLabel = "Other";

  for (const p of positions) {
    const mv = parseNum(p.marketValue);
    totalExposure += mv;
    const theme = p.theme ?? "Other";
    byTheme.set(theme, (byTheme.get(theme) ?? 0) + mv);
    if (p.assetId === assetId!) {
      assetMarketValue = mv;
      assetSize = parseNum(p.size);
      themeLabel = theme;
    }
  }

  let currentThemeExposure = byTheme.get(themeLabel) ?? 0;
  const notional = sizeNum * price;
  let postAssetMarketValue = assetMarketValue;
  let postAssetSize = assetSize;
  if (side === "BUY") {
    postAssetSize = assetSize + sizeNum;
    postAssetMarketValue = assetMarketValue + notional;
  } else {
    postAssetSize = Math.max(0, assetSize - sizeNum);
    postAssetMarketValue = Math.max(0, assetMarketValue - notional);
  }
  const postThemeExposure = currentThemeExposure - assetMarketValue + postAssetMarketValue;
  const postTotalExposure = totalExposure - assetMarketValue + postAssetMarketValue;

  const topPositionValue = Math.max(
    ...positions.map((p) => parseNum(p.marketValue)),
    postAssetMarketValue
  );
  const currentTopPct = totalExposure > 0 ? (Math.max(...positions.map((p) => parseNum(p.marketValue)), 0) / totalExposure) * 100 : 0;
  const postTopPct = postTotalExposure > 0 ? (topPositionValue / postTotalExposure) * 100 : 0;
  const currentThemePct = totalExposure > 0 ? (currentThemeExposure / totalExposure) * 100 : 0;
  const postThemePct = postTotalExposure > 0 ? (postThemeExposure / postTotalExposure) * 100 : 0;

  let currentReserved = 0;
  let reservedForAsset = 0;
  for (const o of openOrders) {
    const rem = parseNum(o.originalSize) - parseNum(o.sizeMatched);
    if (rem <= 0) continue;
    const val = rem * parseNum(o.price);
    currentReserved += val;
    if (o.assetId === assetId!) reservedForAsset += val;
  }

  const warnings: string[] = [];
  if (side === "SELL" && sizeNum > assetSize) {
    warnings.push("Sell size exceeds current position; order may fail or partially fill.");
  }
  if (postThemePct >= CONCENTRATION_WARN_PCT && postThemePct > currentThemePct) {
    warnings.push(`Theme concentration would rise to ${postThemePct.toFixed(0)}% (warning above ${CONCENTRATION_WARN_PCT}%).`);
  }
  if (postTopPct >= CONCENTRATION_WARN_PCT) {
    warnings.push(`Top position concentration would be ${postTopPct.toFixed(0)}%.`);
  }
  let blocked = false;
  if (postThemePct >= CONCENTRATION_BLOCK_PCT || postTopPct >= CONCENTRATION_BLOCK_PCT) {
    warnings.push("Concentration would exceed safe threshold; consider reducing size.");
    blocked = true;
  }
  // TODO: Geoblock / allowance checks when available; plug in here.

  const riskPreview: RiskPreview = {
    currentExposure: {
      assetMarketValue,
      assetSize,
      themeExposure: currentThemeExposure,
      themeLabel,
    },
    postTradeExposure: {
      assetMarketValue: postAssetMarketValue,
      assetSize: postAssetSize,
      themeExposure: postThemeExposure,
    },
    concentrationImpact: {
      currentTopPct,
      postTopPct,
      currentThemePct,
      postThemePct,
    },
    themeImpact: {
      theme: themeLabel,
      currentPct: currentThemePct,
      postPct: postThemePct,
      deltaPct: postThemePct - currentThemePct,
    },
    reservedCapitalImpact: {
      currentReserved,
      reservedForAsset,
    },
    warnings,
    blocked,
  };

  return {
    valid: true,
    validationErrors: [],
    riskPreview,
    marketTitle,
  };
}
