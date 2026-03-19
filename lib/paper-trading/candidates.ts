/**
 * Build paper-trading candidates from recommendations + decision snapshots.
 * Same source as bot dry-run: recommendations with allowed policy state; we add ShadowScoreInput shape for scoring.
 * Paper-only salvage path: BLOCK candidates with allowlisted reasons get a derived candidate with conservative stake (see paper-relaxation).
 */

import { prisma } from "@/lib/db";
import type { ShadowScoreInput } from "@/lib/ml/shadow-score/types";
import { getPaperTradingConfig } from "./config";
import { CORE_ALLOWED_POLICY_STATES, type BotProfile } from "./bot-profiles";
import { classifyEntryPriceBand, parseEntryPrice } from "./price-bands";
import {
  classifyPaperRelaxationEligibility,
  getRelaxedPaperStake,
  PAPER_RELAXATION_VERSION,
  type PaperRelaxationReason,
  type PaperPolicyMode,
} from "./paper-relaxation";
import { buildRelaxedPaperCandidate } from "./relaxed-candidate-builder";
import type { RelaxedDropReason } from "./relaxed-candidate-builder";

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export interface PaperTradingCandidate {
  recommendationId: string;
  marketId: string;
  assetId: string;
  outcome: string;
  side: string;
  entryPrice: string;
  intendedSize: string;
  theme: string | null;
  category: string | null;
  /** Decision policy state at snapshot time (e.g. ALLOW_NORMAL, REVIEW_REQUIRED, BLOCK). */
  sourceDecisionState?: string;
  /** Optional entry price band label (0.0-0.1, 0.1-0.3, etc.). */
  entryPriceBand?: string | null;
  /** Built for shadow model scoring. */
  shadowInput: ShadowScoreInput;
  /** True if this candidate was BLOCK but allowed via paper-only relaxation. */
  passedViaRelaxation?: boolean;
  /** Block reason overridden when passedViaRelaxation is true. */
  relaxedBlockReason?: string;
  /** Paper policy mode: normal | relaxed_block_candidate | rejected (only relaxed_block_candidate appears as candidate). */
  paperPolicyMode?: PaperPolicyMode;
  /** Relaxation reason when paperPolicyMode === relaxed_block_candidate. */
  paperRelaxationReason?: PaperRelaxationReason;
  /** Original blocking reasons from staged decision (for provenance). */
  originalBlockingReasons?: string[];
  /** Paper eligibility version (e.g. paper_relax_v1). */
  paperEligibilityVersion?: string;
  /** Source decision state (e.g. BLOCK) when salvaged. */
  sourceDecisionState?: string;
  /** How the relaxed candidate was derived (e.g. recommendation_market_signal). */
  derivationSource?: string;
}

interface CandidateLoadOptions {
  allowedPolicyStates?: string[];
  allowReviewRequired?: boolean;
  allowRelaxationReasons?: PaperRelaxationReason[] | null;
  allowPaperRelaxation?: boolean;
  allowedPriceBands?: string[] | null;
  excludedThemes?: string[];
  excludedCategories?: string[];
}

/** Sample row for snapshot-match diagnostics. */
export interface SnapshotMatchSample {
  recommendationId: string;
  funderUsed: string;
  snapshotExists: boolean;
  /** If no snapshot for funderUsed, these funders have snapshots for this recommendation. */
  snapshotFunderAddresses?: string[];
}

/** One row in sampleFilteredByPolicy. */
export interface PolicyFilterSample {
  recommendationId: string;
  policyState: string;
  finalSuggestedSize: string;
  /** e.g. "policy_state_not_allowed", "avoid_or_sync_first" */
  reason: string;
}

/** Diagnostics when loading candidates: why count might be 0. */
export interface PaperTradingLoadDiagnostics {
  recommendationsFound: number;
  noDecisionSnapshot: number;
  afterPolicyFilter: number;
  noAssetResolve: number;
  zeroSizeBuy: number;
  candidatesLoaded: number;
  /** Human-readable reason when candidatesLoaded === 0. */
  zeroCandidatesReason: string;
  /** First few recommendations: id, funder used, whether a snapshot exists for (recId, funder), and if not which funders have snapshots. */
  sampleSnapshotCheck?: SnapshotMatchSample[];
  /** Counts by policyState (all recs with snapshot). */
  policyStateCounts?: Record<string, number>;
  /** Count excluded because policyState not in allowed list. */
  filteredByPolicyStateCount?: number;
  /** Count excluded because primaryActionType avoid or sync_first. */
  avoidedCount?: number;
  /** Count that passed policy filter (before asset/size). */
  allowedCount?: number;
  /** Count that passed policy but had zero finalSuggestedSize for BUY. */
  zeroSizeAfterPolicyCount?: number;
  /** First 5 filtered by policy (state or avoid) with reason. */
  sampleFilteredByPolicy?: PolicyFilterSample[];
  /** Number of BLOCK snapshots allowed through via paper-only relaxation (before asset/size filters). */
  relaxedBlockedCount?: number;
  /** Count per block reason that was relaxed. */
  relaxedByReasonCounts?: Record<string, number>;
  /** Number of final candidates that had passedViaRelaxation true. */
  candidatesPassedViaRelaxation?: number;
  /** Paper-only relaxation diagnostics (paper_relax_v1). */
  blockedCandidatesSeen?: number;
  paperRelaxationEligible?: number;
  paperRelaxationRejected?: number;
  paperRelaxationAccepted_edgeTooSmall?: number;
  paperRelaxationAccepted_liquidityTooLow?: number;
  paperRelaxationAccepted_multiAllowed?: number;
  paperRelaxationAccepted_concentrationHigh?: number;
  /** Relaxed candidate build diagnostics (pre-score). */
  relaxedCandidatesConsidered?: number;
  relaxedDropped_actionTypeAvoid?: number;
  relaxedDropped_actionTypeSyncFirst?: number;
  relaxedDropped_missingAssetResolution?: number;
  relaxedDropped_missingSide?: number;
  relaxedDropped_missingPriceContext?: number;
  relaxedDropped_other?: number;
  relaxedBuiltSuccessfully?: number;
}

async function loadCandidatesInternal(
  funderAddress: string,
  opts: CandidateLoadOptions
): Promise<{ candidates: PaperTradingCandidate[]; loadDiagnostics: PaperTradingLoadDiagnostics }> {
  const funder = funderAddress.toLowerCase().trim();
  const config = getPaperTradingConfig();
  const baseAllowedStates = [...CORE_ALLOWED_POLICY_STATES];
  const allowReviewRequired = opts.allowReviewRequired ?? config.allowReviewRequired;
  const allowedPolicyStates = opts.allowedPolicyStates
    ? opts.allowedPolicyStates
    : allowReviewRequired
    ? [...baseAllowedStates, "REVIEW_REQUIRED"]
    : baseAllowedStates;
  const allowPaperRelaxation =
    opts.allowPaperRelaxation === undefined ? true : opts.allowPaperRelaxation;
  const allowedRelaxationReasons =
    opts.allowRelaxationReasons ??
    (["edge_too_small", "liquidity_too_low", "multi_allowed", "concentration_high"] as PaperRelaxationReason[]);

  const diag: PaperTradingLoadDiagnostics = {
    recommendationsFound: 0,
    noDecisionSnapshot: 0,
    afterPolicyFilter: 0,
    noAssetResolve: 0,
    zeroSizeBuy: 0,
    candidatesLoaded: 0,
    zeroCandidatesReason: "",
    policyStateCounts: {},
    filteredByPolicyStateCount: 0,
    avoidedCount: 0,
    allowedCount: 0,
    zeroSizeAfterPolicyCount: 0,
    sampleFilteredByPolicy: [],
    relaxedBlockedCount: 0,
    relaxedByReasonCounts: {},
    candidatesPassedViaRelaxation: 0,
    blockedCandidatesSeen: 0,
    paperRelaxationEligible: 0,
    paperRelaxationRejected: 0,
    paperRelaxationAccepted_edgeTooSmall: 0,
    paperRelaxationAccepted_liquidityTooLow: 0,
    paperRelaxationAccepted_multiAllowed: 0,
    paperRelaxationAccepted_concentrationHigh: 0,
    relaxedCandidatesConsidered: 0,
    relaxedDropped_actionTypeAvoid: 0,
    relaxedDropped_actionTypeSyncFirst: 0,
    relaxedDropped_missingAssetResolution: 0,
    relaxedDropped_missingSide: 0,
    relaxedDropped_missingPriceContext: 0,
    relaxedDropped_other: 0,
    relaxedBuiltSuccessfully: 0,
  };

  const recommendations = await prisma.recommendation.findMany({
    where: { marketSignal: { funderAddress: funder } },
    include: {
      marketSignal: true,
      decisionSnapshots: { where: { funderAddress: funder }, take: 1 },
    },
  });

  diag.recommendationsFound = recommendations.length;
  if (recommendations.length === 0) {
    diag.zeroCandidatesReason = "recommendation_source_empty";
    return { candidates: [], loadDiagnostics: { ...diag } };
  }

  const noSnapshotRecIds: string[] = [];
  const sampleFiltered: PolicyFilterSample[] = [];
  const out: PaperTradingCandidate[] = [];
  for (const rec of recommendations) {
    const snapshot = rec.decisionSnapshots[0];
    if (!snapshot) {
      diag.noDecisionSnapshot++;
      if (noSnapshotRecIds.length < 5) noSnapshotRecIds.push(rec.id);
      continue;
    }
    const state = snapshot.policyState ?? "UNKNOWN";
    diag.policyStateCounts![state] = (diag.policyStateCounts![state] ?? 0) + 1;

    let effectiveSize: string = snapshot.finalSuggestedSize ?? "";
    let relaxedContext: {
      paperPolicyMode: PaperPolicyMode;
      paperRelaxationReason: PaperRelaxationReason;
      originalBlockingReasons: string[];
      acceptedBlockingReasons: string[];
    } | null = null;

    if (!allowedPolicyStates.includes(state)) {
      if (state === "BLOCK") {
        diag.blockedCandidatesSeen!++;
        if (!allowPaperRelaxation) {
          diag.paperRelaxationRejected!++;
          diag.filteredByPolicyStateCount!++;
          if (sampleFiltered.length < 5) {
            sampleFiltered.push({
              recommendationId: rec.id,
              policyState: state,
              finalSuggestedSize: snapshot.finalSuggestedSize ?? "",
              reason: "paper_relaxation_disabled_for_profile",
            });
          }
          continue;
        }
        const eligibility = classifyPaperRelaxationEligibility({
          policyState: state,
          finalSuggestedSize: snapshot.finalSuggestedSize,
          reasoningJson: snapshot.reasoningJson,
        });
        if (
          !eligibility.eligible ||
          eligibility.mode !== "relaxed_block_candidate" ||
          (eligibility.relaxationReason &&
            !allowedRelaxationReasons.includes(eligibility.relaxationReason))
        ) {
          diag.paperRelaxationRejected!++;
          diag.filteredByPolicyStateCount!++;
          if (sampleFiltered.length < 5) {
            sampleFiltered.push({
              recommendationId: rec.id,
              policyState: state,
              finalSuggestedSize: snapshot.finalSuggestedSize ?? "",
              reason: eligibility.rejectionReason ?? "paper_relaxation_rejected",
            });
          }
          continue;
        }
        diag.paperRelaxationEligible!++;
        diag.relaxedBlockedCount!++;
        if (eligibility.relaxationReason === "edge_too_small") diag.paperRelaxationAccepted_edgeTooSmall!++;
        else if (eligibility.relaxationReason === "liquidity_too_low") diag.paperRelaxationAccepted_liquidityTooLow!++;
        else if (eligibility.relaxationReason === "multi_allowed") diag.paperRelaxationAccepted_multiAllowed!++;
        else if (eligibility.relaxationReason === "concentration_high")
          diag.paperRelaxationAccepted_concentrationHigh!++;
        for (const r of eligibility.acceptedBlockingReasons) {
          diag.relaxedByReasonCounts![r] = (diag.relaxedByReasonCounts![r] ?? 0) + 1;
        }
        effectiveSize = getRelaxedPaperStake(eligibility.relaxationReason);
        relaxedContext = {
          paperPolicyMode: "relaxed_block_candidate",
          paperRelaxationReason: eligibility.relaxationReason,
          originalBlockingReasons: eligibility.originalBlockingReasons,
          acceptedBlockingReasons: eligibility.acceptedBlockingReasons,
        };
      } else {
        diag.filteredByPolicyStateCount!++;
        if (sampleFiltered.length < 5) {
          sampleFiltered.push({
            recommendationId: rec.id,
            policyState: state,
            finalSuggestedSize: snapshot.finalSuggestedSize ?? "",
            reason: "policy_state_not_allowed",
          });
        }
        continue;
      }
    }

    if (relaxedContext) {
      diag.relaxedCandidatesConsidered!++;
      const buildResult = await buildRelaxedPaperCandidate(rec, snapshot, relaxedContext);
      if (!buildResult.ok) {
        const reason = buildResult.rejectionReason as RelaxedDropReason;
        if (reason === "missingAssetResolution") diag.relaxedDropped_missingAssetResolution!++;
        else if (reason === "missingSide") diag.relaxedDropped_missingSide!++;
        else if (reason === "missingPriceContext") diag.relaxedDropped_missingPriceContext!++;
        else diag.relaxedDropped_other!++;
        if (sampleFiltered.length < 5) {
          sampleFiltered.push({
            recommendationId: rec.id,
            policyState: state,
            finalSuggestedSize: snapshot.finalSuggestedSize ?? "",
            reason: `relaxed_derivation_failed:${reason}`,
          });
        }
        continue;
      }
      out.push(buildResult.candidate as PaperTradingCandidate);
      diag.relaxedBuiltSuccessfully!++;
      continue;
    }

    if (rec.primaryActionType === "avoid" || rec.primaryActionType === "sync_first") {
      diag.avoidedCount!++;
      if (sampleFiltered.length < 5) {
        sampleFiltered.push({
          recommendationId: rec.id,
          policyState: state,
          finalSuggestedSize: snapshot.finalSuggestedSize ?? "",
          reason: "avoid_or_sync_first",
        });
      }
      continue;
    }
    diag.afterPolicyFilter++;

    const asset = await prisma.syncedAsset.findFirst({
      where: {
        syncedMarketId: rec.marketSignal.marketId,
        outcome: rec.marketSignal.outcome,
      },
    });
    if (!asset) {
      diag.noAssetResolve++;
      continue;
    }

    const side = rec.marketSignal.side?.toUpperCase() === "SELL" ? "SELL" : "BUY";
    const price = rec.marketSignal.marketPrice;
    if (!relaxedContext && parseNum(effectiveSize) <= 0 && side === "BUY") {
      diag.zeroSizeBuy++;
      diag.zeroSizeAfterPolicyCount!++;
      continue;
    }

    const shadowInput: ShadowScoreInput = {
      policyState: snapshot.policyState,
      sizeMultiplier: snapshot.sizeMultiplier ?? null,
      finalSuggestedSize: effectiveSize,
      eligibilityBlockersCount: 0,
      reducedSizeIndicator: false,
      blockedIndicator: relaxedContext != null,
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

    const relaxedBlockReason =
      relaxedContext?.acceptedBlockingReasons?.[0] ?? relaxedContext?.originalBlockingReasons?.[0];

    const theme = rec.marketSignal.theme ?? null;
    const category = rec.marketSignal.category ?? null;
    const entryPriceNum = parseEntryPrice(price);
    const entryPriceBand = classifyEntryPriceBand(entryPriceNum);

    if (opts.allowedPriceBands && entryPriceBand && !opts.allowedPriceBands.includes(entryPriceBand)) {
      continue;
    }
    if (opts.excludedThemes && theme && opts.excludedThemes.includes(theme)) {
      continue;
    }
    if (opts.excludedCategories && category && opts.excludedCategories.includes(category)) {
      continue;
    }

    out.push({
      recommendationId: rec.id,
      marketId: rec.marketSignal.marketId,
      assetId: asset.tokenId,
      outcome: rec.marketSignal.outcome,
      side,
      entryPrice: price,
      intendedSize: effectiveSize,
      theme,
      category,
      sourceDecisionState: state,
      entryPriceBand,
      shadowInput,
      ...(relaxedContext && {
        passedViaRelaxation: true,
        relaxedBlockReason: relaxedBlockReason ?? "relaxed",
        paperPolicyMode: relaxedContext.paperPolicyMode,
        paperRelaxationReason: relaxedContext.paperRelaxationReason,
        originalBlockingReasons: relaxedContext.originalBlockingReasons,
        paperEligibilityVersion: PAPER_RELAXATION_VERSION,
      }),
    });
  }

  diag.candidatesPassedViaRelaxation = out.filter((c) => c.passedViaRelaxation).length;

  if (noSnapshotRecIds.length > 0) {
    const otherSnapshots = await prisma.decisionPolicySnapshot.findMany({
      where: { recommendationId: { in: noSnapshotRecIds } },
      select: { recommendationId: true, funderAddress: true },
    });
    const byRecId = new Map<string, string[]>();
    for (const s of otherSnapshots) {
      const list = byRecId.get(s.recommendationId) ?? [];
      list.push(s.funderAddress);
      byRecId.set(s.recommendationId, list);
    }
    diag.sampleSnapshotCheck = noSnapshotRecIds.slice(0, 5).map((rid) => ({
      recommendationId: rid,
      funderUsed: funder,
      snapshotExists: false,
      snapshotFunderAddresses: [...new Set(byRecId.get(rid) ?? [])],
    }));
  }

  diag.allowedCount = diag.afterPolicyFilter;
  diag.sampleFilteredByPolicy = sampleFiltered.length > 0 ? sampleFiltered : undefined;

  diag.candidatesLoaded = out.length;
  if (out.length === 0) {
    if (diag.noDecisionSnapshot === recommendations.length) {
      diag.zeroCandidatesReason = "filtering_removed_all_no_decision_snapshot";
    } else if (diag.afterPolicyFilter === 0) {
      diag.zeroCandidatesReason = "filtering_removed_all_policy_or_avoid";
    } else if (diag.noAssetResolve > 0 && diag.afterPolicyFilter === diag.noAssetResolve + diag.zeroSizeBuy) {
      diag.zeroCandidatesReason = "no_asset_resolve_or_zero_size";
    } else {
      diag.zeroCandidatesReason = "filtering_removed_all";
    }
  }
  return { candidates: out, loadDiagnostics: diag };
}

/**
 * Fetch recommendations with decision snapshots and resolve assetId; build ShadowScoreInput for each.
 * Returns candidates plus diagnostics so callers can see why no candidates (e.g. empty recs, filtering, no asset).
 */
export async function getPaperTradingCandidatesWithDiagnostics(
  funderAddress: string
): Promise<{ candidates: PaperTradingCandidate[]; loadDiagnostics: PaperTradingLoadDiagnostics }> {
  return loadCandidatesInternal(funderAddress, {});
}

/**
 * Fetch candidates only (no diagnostics). Delegates to getPaperTradingCandidatesWithDiagnostics.
 */
export async function getPaperTradingCandidates(
  funderAddress: string
): Promise<PaperTradingCandidate[]> {
  const { candidates } = await getPaperTradingCandidatesWithDiagnostics(funderAddress);
  return candidates;
}

/**
 * Profile-aware candidate loader. Applies profile-level filters (policy, review, relaxation, price bands, theme/category).
 */
export async function getPaperTradingCandidatesForProfile(
  profile: BotProfile,
  funderAddress: string
): Promise<{ candidates: PaperTradingCandidate[]; loadDiagnostics: PaperTradingLoadDiagnostics }> {
  const opts: CandidateLoadOptions = {
    allowedPolicyStates: profile.allowedPolicyStates,
    allowReviewRequired: profile.allowReviewRequired,
    allowRelaxationReasons: profile.allowRelaxationReasons ?? null,
    allowPaperRelaxation: profile.allowPaperRelaxation,
    allowedPriceBands: profile.allowedPriceBands ?? null,
    excludedThemes: profile.excludedThemes ?? [],
    excludedCategories: profile.excludedCategories ?? [],
  };
  return loadCandidatesInternal(funderAddress, opts);
}
