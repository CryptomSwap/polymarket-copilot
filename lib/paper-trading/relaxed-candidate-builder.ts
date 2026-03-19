/**
 * Paper-only: build a scoreable candidate from an already-eligible relaxed BLOCK snapshot.
 * Does not depend on live-actionability (avoid/sync_first); derives side/asset/price from recommendation + snapshot + synced data.
 */

import { prisma } from "@/lib/db";
import type { ShadowScoreInput } from "@/lib/ml/shadow-score/types";
import { getRelaxedPaperStake, PAPER_RELAXATION_VERSION } from "./paper-relaxation";
import type { PaperRelaxationReason, PaperPolicyMode } from "./paper-relaxation";

export type RelaxedDropReason =
  | "missingAssetResolution"
  | "missingSide"
  | "missingPriceContext"
  | "other";

export interface RelaxedContextInput {
  paperPolicyMode: PaperPolicyMode;
  paperRelaxationReason: PaperRelaxationReason;
  originalBlockingReasons: string[];
  acceptedBlockingReasons: string[];
}

interface RecWithSignal {
  id: string;
  primaryActionType: string | null;
  marketSignal: {
    marketId: string;
    outcome: string;
    side: string | null;
    marketPrice: string | null;
    theme: string | null;
    category: string | null;
  };
}

interface SnapshotRow {
  policyState: string | null;
  sizeMultiplier: string | null;
  finalSuggestedSize: string | null;
}

/** Candidate shape produced by the builder (compatible with PaperTradingCandidate). */
export interface BuiltRelaxedCandidate {
  recommendationId: string;
  marketId: string;
  assetId: string;
  outcome: string;
  side: string;
  entryPrice: string;
  intendedSize: string;
  theme: string | null;
  category: string | null;
  shadowInput: ShadowScoreInput;
  passedViaRelaxation: true;
  relaxedBlockReason: string;
  paperPolicyMode: PaperPolicyMode;
  paperRelaxationReason: PaperRelaxationReason;
  originalBlockingReasons: string[];
  paperEligibilityVersion: string;
  sourceDecisionState: string;
  derivationSource: string;
}

export type BuildRelaxedResult =
  | { ok: true; candidate: BuiltRelaxedCandidate; derivationSource: string }
  | { ok: false; rejectionReason: RelaxedDropReason };

const DERIVATION_SOURCE = "recommendation_market_signal";

/**
 * Build a paper-only candidate from an eligible relaxed BLOCK snapshot.
 * Uses recommendation + snapshot + synced asset; does not require primaryActionType to be live-executable.
 */
export async function buildRelaxedPaperCandidate(
  rec: RecWithSignal,
  snapshot: SnapshotRow,
  relaxedContext: RelaxedContextInput
): Promise<BuildRelaxedResult> {
  const marketId = rec.marketSignal?.marketId;
  const outcome = rec.marketSignal?.outcome ?? "";
  if (!marketId?.trim()) {
    return { ok: false, rejectionReason: "missingAssetResolution" };
  }

  const rawSide = (rec.marketSignal?.side ?? "").toString().trim().toUpperCase();
  if (!rawSide) {
    return { ok: false, rejectionReason: "missingSide" };
  }
  const side = rawSide === "SELL" ? "SELL" : "BUY";

  const price = (rec.marketSignal?.marketPrice ?? "").toString().trim();
  if (!price) {
    return { ok: false, rejectionReason: "missingPriceContext" };
  }

  const asset = await prisma.syncedAsset.findFirst({
    where: {
      syncedMarketId: marketId,
      outcome: outcome.trim() || undefined,
    },
  });
  if (!asset) {
    return { ok: false, rejectionReason: "missingAssetResolution" };
  }

  const effectiveSize = getRelaxedPaperStake(relaxedContext.paperRelaxationReason);
  const relaxedBlockReason =
    relaxedContext.acceptedBlockingReasons?.[0] ?? relaxedContext.originalBlockingReasons?.[0] ?? "relaxed";

  const shadowInput: ShadowScoreInput = {
    policyState: snapshot.policyState,
    sizeMultiplier: snapshot.sizeMultiplier ?? null,
    finalSuggestedSize: effectiveSize,
    eligibilityBlockersCount: 0,
    reducedSizeIndicator: false,
    blockedIndicator: true,
    executionAllow: true,
    executionWarningCount: 0,
    qualityState: "good",
    spreadBps: null,
    estimatedSlippage: null,
    tradable: true,
    grossExposure: null,
    totalOpenExposure: null,
    maxSingleMarketConcentrationPct: null,
    maxSingleThemeConcentrationPct: null,
    portfolioRiskFlagsCount: 0,
    runtimeWarningCount: 0,
    runtimeBlockingCount: 0,
    intendedPrice: price,
    intendedSize: effectiveSize,
    recommendationPresent: true,
    side,
  };

  const candidate: BuiltRelaxedCandidate = {
    recommendationId: rec.id,
    marketId,
    assetId: asset.tokenId,
    outcome,
    side,
    entryPrice: price,
    intendedSize: effectiveSize,
    theme: rec.marketSignal?.theme ?? null,
    category: rec.marketSignal?.category ?? null,
    shadowInput,
    passedViaRelaxation: true,
    relaxedBlockReason,
    paperPolicyMode: relaxedContext.paperPolicyMode,
    paperRelaxationReason: relaxedContext.paperRelaxationReason,
    originalBlockingReasons: relaxedContext.originalBlockingReasons,
    paperEligibilityVersion: PAPER_RELAXATION_VERSION,
    sourceDecisionState: (snapshot.policyState ?? "BLOCK").toString(),
    derivationSource: DERIVATION_SOURCE,
  };

  return { ok: true, candidate, derivationSource: DERIVATION_SOURCE };
}
