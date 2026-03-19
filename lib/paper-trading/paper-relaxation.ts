/**
 * Paper-only policy relaxation: allow scoring and paper trades from a narrow
 * allowlisted subset of BLOCKED staged decisions. Does not change real execution.
 * Salvaged candidates get a conservative paper-only stake and full provenance.
 */

export const PAPER_RELAXATION_VERSION = "paper_relax_v1";

/** Block reasons that may be salvaged for paper-only (no real execution). */
export const allowedPaperBlockReasons: readonly string[] = [
  "Edge too small for action.",
  "Liquidity too low for suggested size.",
] as const;

/** Exact strings that are explicitly disallowed for salvage (e.g. crowded). */
const DISALLOWED_REASONS_EXACT = ["Market crowded or low liquidity."] as const;

/** Substrings that indicate portfolio/theme/concentration/behavior/review/eligibility/risk blockers (not allowlisted). Do not include phrases that match allowed reasons. */
const DISALLOWED_PATTERNS = [
  "market crowded",
  "theme concentration",
  "concentration",
  "exceeds limit",
  "portfolio",
  "overconcentrated",
  "behavior",
  "review",
  "rejected",
  "eligibility",
  "chase",
  "blocked",
  "quality",
  "risk",
  "exposure",
  "saturation",
  "no-trade",
  "no_trade",
  "watch",
];

export type PaperRelaxationReason =
  | "edge_too_small"
  | "liquidity_too_low"
  | "multi_allowed"
  | "concentration_high"
  | null;
export type PaperPolicyMode = "normal" | "relaxed_block_candidate" | "rejected";

export interface StagedDecisionForRelaxation {
  policyState: string;
  finalSuggestedSize: string | null | undefined;
  reasoningJson: string | null | undefined;
}

export interface PaperRelaxationEligibilityResult {
  eligible: boolean;
  mode: PaperPolicyMode;
  relaxationReason: PaperRelaxationReason;
  originalBlockingReasons: string[];
  acceptedBlockingReasons: string[];
  rejectionReason?: string;
}

interface SnapshotReasonContext {
  blockReason: string | null;
  blockers: string[];
  portfolioFitReasons: string[];
}

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse all blocking reasons from a snapshot's reasoningJson (blockReason + blockers array).
 */
export function parseBlockingReasonsFromSnapshot(snapshot: {
  reasoningJson: string | null | undefined;
}): string[] {
  if (!snapshot.reasoningJson?.trim()) return [];
  try {
    const o = JSON.parse(snapshot.reasoningJson) as Record<string, unknown>;
    const reasons: string[] = [];
    if (typeof o.blockReason === "string" && o.blockReason.trim()) {
      reasons.push(o.blockReason.trim());
    }
    if (Array.isArray(o.blockers)) {
      for (const b of o.blockers as string[]) {
        if (typeof b === "string" && b.trim() && !reasons.includes(b.trim())) {
          reasons.push(b.trim());
        }
      }
    }
    return reasons;
  } catch {
    return [];
  }
}

function parseSnapshotReasonContext(snapshot: {
  reasoningJson: string | null | undefined;
}): SnapshotReasonContext {
  if (!snapshot.reasoningJson?.trim()) {
    return { blockReason: null, blockers: [], portfolioFitReasons: [] };
  }
  try {
    const o = JSON.parse(snapshot.reasoningJson) as Record<string, unknown>;
    return {
      blockReason: typeof o.blockReason === "string" && o.blockReason.trim() ? o.blockReason.trim() : null,
      blockers: Array.isArray(o.blockers) ? (o.blockers as string[]).filter((x) => typeof x === "string" && x.trim()) : [],
      portfolioFitReasons: Array.isArray(o.portfolioFitReasons)
        ? (o.portfolioFitReasons as string[]).filter((x) => typeof x === "string" && x.trim())
        : [],
    };
  } catch {
    return { blockReason: null, blockers: [], portfolioFitReasons: [] };
  }
}

function isAllowedReason(reason: string): boolean {
  return allowedPaperBlockReasons.includes(reason as (typeof allowedPaperBlockReasons)[number]);
}

function isDisallowedReason(reason: string): boolean {
  const r = reason.toLowerCase();
  if (DISALLOWED_REASONS_EXACT.some((d) => reason.trim() === d)) return true;
  return DISALLOWED_PATTERNS.some((p) => r.includes(p));
}

function isConcentrationReason(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    r.includes("concentration") ||
    r.includes("theme exposure") ||
    r.includes("exceeds limit") ||
    r.includes("overconcentrated")
  );
}

/**
 * Classify whether a BLOCK staged decision is eligible for paper-only salvage.
 * Only eligible when every blocking reason is in the allowlist and none are disallowed.
 */
export function classifyPaperRelaxationEligibility(
  stagedDecision: StagedDecisionForRelaxation
): PaperRelaxationEligibilityResult {
  const ctx = parseSnapshotReasonContext(stagedDecision);
  const originalBlockingReasons = parseBlockingReasonsFromSnapshot(stagedDecision);
  const acceptedBlockingReasons: string[] = [];
  let relaxationReason: PaperRelaxationReason = null;

  if (stagedDecision.policyState !== "BLOCK") {
    return {
      eligible: false,
      mode: "rejected",
      relaxationReason: null,
      originalBlockingReasons,
      acceptedBlockingReasons: [],
      rejectionReason: "policy_state_not_block",
    };
  }

  const size = parseNum(stagedDecision.finalSuggestedSize);
  if (size > 0) {
    return {
      eligible: false,
      mode: "rejected",
      relaxationReason: null,
      originalBlockingReasons,
      acceptedBlockingReasons: [],
      rejectionReason: "final_suggested_size_non_zero",
    };
  }

  if (originalBlockingReasons.length === 0) {
    return {
      eligible: false,
      mode: "rejected",
      relaxationReason: null,
      originalBlockingReasons: [],
      acceptedBlockingReasons: [],
      rejectionReason: "no_blocking_reasons",
    };
  }

  const concentrationFromPortfolioFit = ctx.portfolioFitReasons.some((r) =>
    isConcentrationReason(r)
  );
  let hasConcentrationReason = concentrationFromPortfolioFit;
  for (const r of originalBlockingReasons) {
    if (isConcentrationReason(r)) {
      acceptedBlockingReasons.push(r);
      hasConcentrationReason = true;
      continue;
    }
    if (isDisallowedReason(r)) {
      return {
        eligible: false,
        mode: "rejected",
        relaxationReason: null,
        originalBlockingReasons,
        acceptedBlockingReasons: [],
        rejectionReason: `disallowed_block_reason: ${r.slice(0, 80)}`,
      };
    }
    if (!isAllowedReason(r)) {
      return {
        eligible: false,
        mode: "rejected",
        relaxationReason: null,
        originalBlockingReasons,
        acceptedBlockingReasons: [],
        rejectionReason: `block_reason_not_allowlisted: ${r.slice(0, 80)}`,
      };
    }
    acceptedBlockingReasons.push(r);
  }

  const hasEdge = originalBlockingReasons.some((x) => x === "Edge too small for action.");
  const hasLiq = originalBlockingReasons.some((x) => x === "Liquidity too low for suggested size.");
  if (hasConcentrationReason) relaxationReason = "concentration_high";
  else if (hasEdge && hasLiq) relaxationReason = "multi_allowed";
  else if (hasEdge) relaxationReason = "edge_too_small";
  else if (hasLiq) relaxationReason = "liquidity_too_low";

  return {
    eligible: true,
    mode: "relaxed_block_candidate",
    relaxationReason,
    originalBlockingReasons,
    acceptedBlockingReasons,
  };
}

/** Conservative fixed notional for paper-only stake on salvaged BLOCK candidates (isolated from live sizing). */
const RELAXED_PAPER_STAKE_NOTIONAL = 10;

/**
 * Return a conservative paper-only stake for salvaged BLOCK candidates.
 * Isolated from live sizing logic; must not be used for real execution.
 */
export function getRelaxedPaperStake(reason?: PaperRelaxationReason): string {
  const concentrationRaw =
    typeof process !== "undefined"
      ? process.env.PAPER_TRADING_RELAXED_CONCENTRATION_STAKE_NOTIONAL?.trim()
      : "";
  if (reason === "concentration_high") {
    const c = concentrationRaw ? Number(concentrationRaw) : NaN;
    if (Number.isFinite(c) && c > 0) return String(c);
    return "2";
  }
  const raw = typeof process !== "undefined" ? process.env.PAPER_TRADING_RELAXED_STAKE_NOTIONAL?.trim() : "";
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return String(parsed);
  return String(RELAXED_PAPER_STAKE_NOTIONAL);
}
