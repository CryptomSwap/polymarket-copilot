/**
 * Exit preview: effect on exposure, realized/unrealized lock-in, concentration relief.
 * Validates size and side. Manual only; no autonomous exits.
 */

import { prisma } from "@/lib/db";

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export type ExitType = "TRIM" | "REDUCE" | "EXIT" | "TAKE_PROFIT" | "THESIS_BROKEN";

export interface ExitPreviewInput {
  funderAddress: string;
  assetId: string;
  marketId: string;
  exitType: ExitType;
  size: string;
  limitPrice: string;
  recommendationId?: string | null;
}

export interface ExitPreviewResult {
  valid: boolean;
  validationErrors: string[];
  positionSize: number;
  exitSize: number;
  remainingSize: number;
  avgEntry: number;
  limitPrice: number;
  /** Estimated realized PnL from this exit (exitSize * (limitPrice - avgEntry) for long) */
  estimatedRealizedPnl: number;
  /** Current unrealized on the exiting size that will lock in */
  unrealizedLockIn: number;
  /** Theme exposure before */
  themeExposureBefore: number;
  /** Theme exposure after (estimated) */
  themeExposureAfter: number;
  /** Total exposure before */
  totalExposureBefore: number;
  /** Total exposure after (estimated) */
  totalExposureAfter: number;
  /** Concentration % (theme/total) before */
  concentrationPctBefore: number;
  /** Concentration % after */
  concentrationPctAfter: number;
  marketTitle: string | null;
  theme: string | null;
  warnings: string[];
}

/**
 * Build exit preview. Validates that position exists, size <= position size, side is SELL for long.
 */
export async function buildExitPreview(input: ExitPreviewInput): Promise<ExitPreviewResult> {
  const { funderAddress, assetId, marketId, exitType, size, limitPrice } = input;
  const validationErrors: string[] = [];
  const sizeNum = parseNum(size);
  const priceNum = parseNum(limitPrice);

  const position = await prisma.derivedPosition.findUnique({
    where: { funderAddress_assetId: { funderAddress: funderAddress.toLowerCase(), assetId } },
  });

  if (!position) {
    return {
      valid: false,
      validationErrors: ["Position not found for this funder and asset."],
      positionSize: 0,
      exitSize: 0,
      remainingSize: 0,
      avgEntry: 0,
      limitPrice: priceNum,
      estimatedRealizedPnl: 0,
      unrealizedLockIn: 0,
      themeExposureBefore: 0,
      themeExposureAfter: 0,
      totalExposureBefore: 0,
      totalExposureAfter: 0,
      concentrationPctBefore: 0,
      concentrationPctAfter: 0,
      marketTitle: null,
      theme: null,
      warnings: [],
    };
  }

  const positionSize = parseNum(position.size);
  const avgEntry = parseNum(position.avgEntry);
  const lastPrice = parseNum(position.lastPrice);
  const theme = position.theme ?? "Other";

  if (position.side?.toUpperCase() !== "BUY" && position.side?.toLowerCase() !== "yes") {
    validationErrors.push("Exit preview assumes long (BUY/YES) position; other sides need validation.");
  }
  if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
    validationErrors.push("Exit size must be a positive number.");
  }
  if (sizeNum > positionSize) {
    validationErrors.push(`Exit size (${sizeNum}) exceeds position size (${positionSize}).`);
  }
  if (!Number.isFinite(priceNum) || priceNum <= 0 || priceNum >= 1) {
    validationErrors.push("Limit price must be between 0 and 1 (exclusive).");
  }

  const exitSize = Math.min(sizeNum, positionSize);
  const remainingSize = Math.max(0, positionSize - exitSize);

  const estimatedRealizedPnl = exitSize * (priceNum - avgEntry);
  const unrealizedLockIn = exitSize * (lastPrice - avgEntry);

  const positions = await prisma.derivedPosition.findMany({
    where: { funderAddress: funderAddress.toLowerCase() },
  });
  let totalExposureBefore = 0;
  const byTheme = new Map<string, number>();
  for (const p of positions) {
    const mv = parseNum(p.marketValue);
    totalExposureBefore += mv;
    const t = p.theme ?? "Other";
    byTheme.set(t, (byTheme.get(t) ?? 0) + mv);
  }
  const themeExposureBefore = byTheme.get(theme) ?? 0;
  const concentrationPctBefore = totalExposureBefore > 0 ? (themeExposureBefore / totalExposureBefore) * 100 : 0;

  const exitValue = exitSize * priceNum;
  const totalExposureAfter = totalExposureBefore - exitValue;
  const themeExposureAfter = Math.max(0, themeExposureBefore - exitValue);
  const concentrationPctAfter = totalExposureAfter > 0 ? (themeExposureAfter / totalExposureAfter) * 100 : 0;

  const market = await prisma.syncedMarket.findUnique({
    where: { id: position.marketId },
  });
  const marketTitle = market?.title ?? position.marketTitle ?? null;

  const warnings: string[] = [];
  if (exitSize >= positionSize) {
    warnings.push("Full exit; position will be closed.");
  }
  if (priceNum < lastPrice) {
    warnings.push("Limit price below last price; fill may be delayed or not occur.");
  }

  return {
    valid: validationErrors.length === 0,
    validationErrors,
    positionSize,
    exitSize,
    remainingSize,
    avgEntry,
    limitPrice: priceNum,
    estimatedRealizedPnl,
    unrealizedLockIn,
    themeExposureBefore,
    themeExposureAfter,
    totalExposureBefore,
    totalExposureAfter,
    concentrationPctBefore,
    concentrationPctAfter,
    marketTitle,
    theme,
    warnings,
  };
}
