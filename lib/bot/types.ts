/**
 * Bot v1 types: suggest-only / dry-run. No live execution.
 * Sits between recommendation engine + decision layer and (future) execution.
 */

export type BotMode = "dry_run" | "suggest_only";

/** Config for guardrails (env or future DB). All caps are percentages unless noted. */
export interface BotGuardrailConfig {
  /** Block if portfolio has any unresolved positions (catalog). */
  blockUnresolvedCatalog: boolean;
  /** Block if portfolio has stale sync (e.g. > 24h). */
  blockStaleSync: boolean;
  /** Max single-market concentration (post-trade) %. */
  perMarketCapPct: number;
  /** Max single-theme concentration (post-trade) %. */
  perThemeCapPct: number;
  /** Block new adds when market resolves within this many hours. */
  nearResolutionBlockHours: number;
  /** Allow add near resolution if explicitly allowed (override). */
  allowNearResolutionAdd: boolean;
  /** Max theme overlap % to consider "duplicate thesis" and block add. */
  duplicateThesisThemeCapPct: number;
}

export const DEFAULT_GUARDRAIL_CONFIG: BotGuardrailConfig = {
  blockUnresolvedCatalog: true,
  blockStaleSync: true,
  perMarketCapPct: 50,
  perThemeCapPct: 50,
  nearResolutionBlockHours: 72,
  allowNearResolutionAdd: false,
  duplicateThesisThemeCapPct: 40,
};

/** A single candidate action derived from a recommendation + decision (no order placed). */
export interface BotCandidate {
  recommendationId: string;
  marketId: string;
  assetId: string;
  outcome: string;
  side: "BUY" | "SELL";
  limitPrice: string;
  size: string;
  primaryActionType: string | null;
  policyState: string;
  finalSuggestedSize: string;
  marketTitle: string | null;
  /** Theme for duplicate-thesis / overlap guardrail (from signal). */
  marketTheme?: string | null;
}

/** Result of running guardrails on one candidate. */
export interface GuardrailResult {
  allowed: boolean;
  reason: string;
  failures: string[];
}

/** Idempotent execution key: same inputs → same key (no double-place). */
export function executionKey(candidate: BotCandidate): string {
  const parts = [
    candidate.recommendationId,
    candidate.assetId,
    candidate.side,
    candidate.size,
    candidate.limitPrice,
  ];
  return parts.join(":");
}

/** Dry-run output: what would be considered for placement, with guardrail results. No orders placed. */
export interface DryRunResult {
  mode: BotMode;
  funderAddress: string;
  at: string; // ISO
  config: BotGuardrailConfig;
  candidates: Array<{
    candidate: BotCandidate;
    executionKey: string;
    guardrail: GuardrailResult;
  }>;
  summary: {
    total: number;
    allowed: number;
    blocked: number;
  };
}
