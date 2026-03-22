/**
 * Paper-only admission helpers: effective min score, score→size buckets, spread/slippage guards.
 * Live trading does not import this module.
 */

import type { PaperTradingConfig } from "./config";

export const DEFAULT_PAPER_SIZE_SCORE_TIERS: PaperSizeScoreTier[] = [
  { maxExclusive: 0.9, label: "small", multiplier: 0.5 },
  { maxExclusive: 0.98, label: "medium", multiplier: 1 },
  { maxExclusive: 1.000_000_1, label: "large", multiplier: 1.15 },
];

export interface PaperSizeScoreTier {
  maxExclusive: number;
  label: string;
  multiplier: number;
}

export interface EffectivePaperMinScoreResult {
  effectiveMinScore: number;
  baseMinScore: number;
  globalPaperMinScoreOverride: number | null;
  botPaperMinScoreOverride: number | null;
  admittedUnderTightenedPaperThreshold: boolean;
}

/**
 * Paper-only floor on admission min score: never below profile/base min; raises when overrides are set.
 */
export function computeEffectivePaperMinScore(args: {
  baseMinScore: number;
  globalOverride: number | null;
  botOverride: number | null;
}): EffectivePaperMinScoreResult {
  const baseMinScore = Number.isFinite(args.baseMinScore) ? args.baseMinScore : 0;
  let effective = baseMinScore;
  const g = args.globalOverride;
  const b = args.botOverride;
  if (g != null && Number.isFinite(g)) {
    effective = Math.max(effective, g);
  }
  if (b != null && Number.isFinite(b)) {
    effective = Math.max(effective, b);
  }
  return {
    effectiveMinScore: effective,
    baseMinScore,
    globalPaperMinScoreOverride: g,
    botPaperMinScoreOverride: b,
    admittedUnderTightenedPaperThreshold: effective > baseMinScore + 1e-12,
  };
}

/** Env: PAPER_BOT_MIN_SCORE_OVERRIDE_<BOTTYPE> e.g. RELAXED_EDGE */
export function readPaperBotMinScoreOverrideEnv(botType: string): number | null {
  const normalized = String(botType)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");
  const key = `PAPER_BOT_MIN_SCORE_OVERRIDE_${normalized}`;
  const raw = typeof process !== "undefined" ? process.env[key]?.trim() : "";
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export function parsePaperSizeScoreTiersJson(raw: string | null | undefined): PaperSizeScoreTier[] | null {
  if (raw == null || String(raw).trim() === "") return null;
  try {
    const arr = JSON.parse(String(raw)) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const out: PaperSizeScoreTier[] = [];
    for (const row of arr) {
      if (row == null || typeof row !== "object") return null;
      const o = row as Record<string, unknown>;
      const maxExclusive =
        typeof o.maxExclusive === "number"
          ? o.maxExclusive
          : typeof o.max === "number"
            ? o.max
            : parseFloat(String(o.maxExclusive ?? o.max ?? ""));
      const label = typeof o.label === "string" ? o.label : String(o.label ?? "");
      const multiplier =
        typeof o.multiplier === "number" ? o.multiplier : parseFloat(String(o.multiplier ?? ""));
      if (!Number.isFinite(maxExclusive) || label === "" || !Number.isFinite(multiplier)) return null;
      if (multiplier <= 0 || multiplier > 10) return null;
      out.push({ maxExclusive, label, multiplier });
    }
    out.sort((a, b) => a.maxExclusive - b.maxExclusive);
    return out;
  } catch {
    return null;
  }
}

/**
 * Tiers cover [floorMinScore, +∞) by maxExclusive boundaries. Use the same floor as admission for
 * threshold path; for exploration admits, pass explorationMinScore so sub-threshold scores still map.
 */
export function resolvePaperSizeBucket(
  score: number,
  floorMinScore: number,
  tiers: PaperSizeScoreTier[]
): { label: string; multiplier: number } | null {
  if (!Number.isFinite(score) || score < floorMinScore) return null;
  const sorted = tiers.length > 0 ? tiers : DEFAULT_PAPER_SIZE_SCORE_TIERS;
  for (const t of sorted) {
    if (score < t.maxExclusive) {
      return { label: t.label, multiplier: t.multiplier };
    }
  }
  const last = sorted[sorted.length - 1];
  return last ? { label: last.label, multiplier: last.multiplier } : null;
}

export type PaperLiquidityGuardFail = "spread" | "slippage";

/**
 * When max bps is null/undefined, guard is off. Missing spread/slippage at decision time does not block (no fabricated fail-closed on missing telemetry).
 */
export function evaluatePaperLiquidityGuards(
  spreadBps: number | null,
  estimatedSlippageBps: number | null,
  maxSpreadBps: number | null,
  maxEstimatedSlippageBps: number | null
): { ok: true } | { ok: false; reason: PaperLiquidityGuardFail } {
  if (maxSpreadBps != null && Number.isFinite(maxSpreadBps) && maxSpreadBps >= 0) {
    if (spreadBps != null && Number.isFinite(spreadBps) && spreadBps > maxSpreadBps) {
      return { ok: false, reason: "spread" };
    }
  }
  if (
    maxEstimatedSlippageBps != null &&
    Number.isFinite(maxEstimatedSlippageBps) &&
    maxEstimatedSlippageBps >= 0
  ) {
    if (
      estimatedSlippageBps != null &&
      Number.isFinite(estimatedSlippageBps) &&
      estimatedSlippageBps > maxEstimatedSlippageBps
    ) {
      return { ok: false, reason: "slippage" };
    }
  }
  return { ok: true };
}

export function applyPaperIntendedSizeMultiplier(intendedSizeStr: string, mult: number): string {
  const n = parseFloat(String(intendedSizeStr).trim());
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(mult) || mult <= 0) {
    return intendedSizeStr;
  }
  const scaled = n * mult;
  return String(Math.round(scaled * 1e6) / 1e6);
}

/** Effective min score for analytics when only global config applies (single-bot / reporting default). */
export function effectivePaperMinScoreFromConfig(cfg: PaperTradingConfig): number {
  const base = cfg.threshold + cfg.minScoreBuffer;
  return computeEffectivePaperMinScore({
    baseMinScore: base,
    globalOverride: cfg.paperMinScoreOverrideGlobal,
    botOverride: null,
  }).effectiveMinScore;
}
