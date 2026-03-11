/**
 * Preflight checks before order placement. No autonomous trading.
 * Block place when preflight fails unless explicitly overridden.
 * TODO: Geoblock/allowance when APIs available; automated exit only after reliability proven.
 */

import { prisma } from "@/lib/db";

const TICK_SIZE = 0.01;
const MIN_PRICE = 0.001;
const MAX_PRICE = 0.999;

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export interface PreflightInput {
  funderAddress: string;
  recommendationId?: string | null;
  marketId: string;
  assetId: string;
  limitPrice: string;
  size: string;
}

export interface PreflightResult {
  passed: boolean;
  preflightId: string;
  geoblockOk: boolean | null;
  balanceOk: boolean | null;
  allowanceOk: boolean | null;
  marketActiveOk: boolean | null;
  tickSizeOk: boolean | null;
  feeKnown: boolean | null;
  warnings: string[];
}

/**
 * Run preflight checks and persist TradePreflightCheck. Returns passed=false if any required check fails.
 */
export async function runPreflightChecks(input: PreflightInput): Promise<PreflightResult> {
  const warnings: string[] = [];
  let geoblockOk: boolean | null = null;
  let balanceOk: boolean | null = null;
  let allowanceOk: boolean | null = null;
  let marketActiveOk: boolean | null = null;
  let tickSizeOk: boolean | null = null;
  let feeKnown: boolean | null = null;

  const price = parseNum(input.limitPrice);
  const size = parseNum(input.size);

  if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) {
    warnings.push("Limit price must be between 0.001 and 0.999.");
  }
  if (!Number.isFinite(size) || size <= 0) {
    warnings.push("Size must be a positive number.");
  }

  const tickValid = Number.isFinite(price) && (Math.round(price / TICK_SIZE) * TICK_SIZE - price) < 1e-6;
  tickSizeOk = Number.isFinite(price) ? tickValid : null;
  if (Number.isFinite(price) && !tickValid) {
    warnings.push(`Price should align to tick size ${TICK_SIZE}.`);
  }

  const market = await prisma.syncedMarket.findUnique({
    where: { id: input.marketId },
  });
  if (!market) {
    warnings.push("Market not found.");
    marketActiveOk = false;
  } else {
    const closed = market.status?.toLowerCase() === "closed" || market.endDate != null && market.endDate <= new Date();
    marketActiveOk = !closed;
    if (closed) warnings.push("Market is closed or ended.");
  }

  const asset = await prisma.syncedAsset.findFirst({
    where: { syncedMarketId: input.marketId, tokenId: input.assetId },
  });
  if (!asset) {
    warnings.push("Asset not found for market.");
  }

  if (geoblockOk === null) {
    geoblockOk = true;
  }
  if (balanceOk === null) {
    balanceOk = null;
    warnings.push("Balance check not available; confirm sufficient balance.");
  }
  if (allowanceOk === null) {
    allowanceOk = null;
    warnings.push("Allowance check not available; confirm proxy allowance if needed.");
  }
  if (feeKnown === null) {
    feeKnown = false;
    warnings.push("Fee impact not computed; consider exchange fees.");
  }

  const hasBlocking =
    !Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE ||
    !Number.isFinite(size) || size <= 0 ||
    !market ||
    marketActiveOk === false ||
    !asset;
  const passed = !hasBlocking;

  const preflight = await prisma.tradePreflightCheck.create({
    data: {
      funderAddress: input.funderAddress.toLowerCase(),
      recommendationId: input.recommendationId ?? undefined,
      marketId: input.marketId,
      assetId: input.assetId,
      passed,
      geoblockOk,
      balanceOk,
      allowanceOk,
      marketActiveOk,
      tickSizeOk,
      feeKnown,
      warningsJson: JSON.stringify(warnings),
    },
  });

  return {
    passed,
    preflightId: preflight.id,
    geoblockOk,
    balanceOk,
    allowanceOk,
    marketActiveOk,
    tickSizeOk,
    feeKnown,
    warnings,
  };
}
