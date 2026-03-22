import type { PaperPolicyMode, PaperRelaxationReason } from "./paper-relaxation";
import { getPaperTradingConfig } from "./config";
import * as fs from "fs";
import * as path from "path";

/** Global paper exploration tuning (overrides per-profile values when set). */
const ENV_PAPER_EXPLORATION_BAND_BELOW_MIN_SCORE = "PAPER_EXPLORATION_BAND_BELOW_MIN_SCORE";
const ENV_PAPER_EXPLORATION_MAX_PER_TICK = "PAPER_EXPLORATION_MAX_PER_TICK";

function optionalPositiveFloatFromEnv(key: string): number | undefined {
  const raw = typeof process !== "undefined" ? process.env[key]?.trim() : "";
  if (!raw) return undefined;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function optionalNonNegIntFromEnv(key: string): number | undefined {
  const raw = typeof process !== "undefined" ? process.env[key]?.trim() : "";
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export type PriceBandLabel =
  | "0.0-0.1"
  | "0.1-0.3"
  | "0.3-0.7"
  | "0.7-0.9"
  | "0.9-1.0";

export interface BotProfile {
  botType: string;
  displayName: string;
  enabled: boolean;

  targetLabel?: string | null;
  botVersion?: string | null;

  threshold?: number;
  minScoreBuffer?: number;

  allowReviewRequired?: boolean;
  allowPaperRelaxation?: boolean;
  allowRelaxationReasons?: PaperRelaxationReason[];

  allowedPolicyStates?: string[];
  allowedPriceBands?: PriceBandLabel[];

  excludedThemes?: string[];
  excludedCategories?: string[];

  cooldownHours?: number;
  cooldownMarketHours?: number;
  maxOpenTotal?: number;
  maxOpenPerMarket?: number;
  maxOpenPerTheme?: number;
  maxOpenPerCategory?: number;
  maxDailyNewTrades?: number;

  /**
   * Paper-only exploration controls (optional, per-bot).
   * If unset, bot remains threshold-only for admission.
   */
  explorationEnabled?: boolean;
  /** Max score gap below minScore that can be considered for exploration (e.g. 0.02 => [minScore-0.02, minScore)). */
  explorationBandBelowMinScore?: number;
  /** Per-tick cap on exploration-admitted trades for this bot (0 or unset => no exploration opens). */
  explorationMaxPerTick?: number;
  /** Per-day cap on exploration-admitted trades for this bot (0 or unset => no explicit exploration daily cap). */
  explorationMaxPerDay?: number;

  notes?: string;
}

export interface EffectiveBotProfile {
  botType: string;
  displayName: string;
  enabled: boolean;
  targetLabel: string | null;
  botVersion: string | null;
  threshold: number;
  minScoreBuffer: number;
  allowReviewRequired: boolean;
  allowPaperRelaxation: boolean;
  allowRelaxationReasons: PaperRelaxationReason[] | null;
  allowedPolicyStates: string[] | null;
  allowedPriceBands: PriceBandLabel[] | null;
  excludedThemes: string[];
  excludedCategories: string[];
  cooldownHours: number;
  cooldownMarketHours: number;
  maxOpenTotal: number;
  maxOpenPerMarket: number;
  maxOpenPerTheme: number;
  maxOpenPerCategory: number;
  maxDailyNewTrades: number;
  notes: string | null;
  /** Whether this profile is effectively active after overrides are applied. */
  effectiveEnabled: boolean;
  /** Optional override metadata (e.g. env-based). */
  overrideSource?: "env" | null;

  /** Paper-only exploration controls (effective values). */
  explorationEnabled: boolean;
  explorationBandBelowMinScore: number;
  explorationMaxPerTick: number;
  explorationMaxPerDay: number;
}

export const CORE_ALLOWED_POLICY_STATES = [
  "ALLOW_SMALL",
  "ALLOW_NORMAL",
  "ALLOW_HIGH_CONVICTION",
  "TRIM",
  "EXIT",
] as const;

export const BOT_PROFILES: BotProfile[] = [
  {
    botType: "strict_quality",
    displayName: "Strict Quality",
    enabled: true,
    targetLabel: "labelGoodDecision12h",
    botVersion: "1.0.0",
    threshold: 0.35,
    minScoreBuffer: 0.05,
    /** Paper tick: allow REVIEW_REQUIRED pool (execution warn) so multi-bot is not starved; still conservative via threshold/relaxation off. */
    allowReviewRequired: true,
    allowPaperRelaxation: false,
    allowedPolicyStates: [...CORE_ALLOWED_POLICY_STATES],
    /** Full range so paper tick has candidates; scoring/thresholds still gate admission. */
    allowedPriceBands: ["0.0-0.1", "0.1-0.3", "0.3-0.7", "0.7-0.9", "0.9-1.0"],
    excludedThemes: [],
    excludedCategories: [],
    cooldownHours: 24,
    cooldownMarketHours: 12,
    maxOpenTotal: 15,
    maxOpenPerMarket: 1,
    maxOpenPerTheme: 20,
    maxOpenPerCategory: 40,
    maxDailyNewTrades: 20,
    notes:
      "Conservative, quality-focused bot: paper pool includes review-warn rows; no relaxation; threshold/minScore gate quality.",
  },
  {
    botType: "relaxed_edge",
    displayName: "Relaxed Edge",
    enabled: true,
    targetLabel: "labelGoodDecision12h",
    botVersion: "1.0.0",
    threshold: 0.3,
    minScoreBuffer: 0,
    allowReviewRequired: true,
    allowPaperRelaxation: true,
    allowRelaxationReasons: ["edge_too_small", "liquidity_too_low", "multi_allowed", "concentration_high"],
    allowedPolicyStates: [...CORE_ALLOWED_POLICY_STATES, "REVIEW_REQUIRED"],
    allowedPriceBands: ["0.0-0.1", "0.1-0.3", "0.3-0.7", "0.7-0.9", "0.9-1.0"],
    excludedThemes: [],
    excludedCategories: [],
    cooldownHours: 12,
    cooldownMarketHours: 4,
    maxOpenTotal: 15,
    maxOpenPerMarket: 3,
    maxOpenPerTheme: 50,
    maxOpenPerCategory: 80,
    maxDailyNewTrades: 20,
    // Paper-only exploration: narrow band below threshold with conservative caps.
    explorationEnabled: true,
    explorationBandBelowMinScore: 0.02,
    explorationMaxPerTick: 5,
    explorationMaxPerDay: 40,
    notes:
      "Exploratory bot that includes review-required and relaxed-block candidates with moderate risk controls.",
  },
  {
    botType: "tail_extremes",
    displayName: "Tail Extremes",
    enabled: true,
    targetLabel: "labelGoodDecision12h",
    botVersion: "1.0.0",
    threshold: 0.32,
    minScoreBuffer: 0.02,
    allowReviewRequired: true,
    allowPaperRelaxation: true,
    allowRelaxationReasons: ["edge_too_small", "multi_allowed", "concentration_high"],
    allowedPolicyStates: [...CORE_ALLOWED_POLICY_STATES],
    allowedPriceBands: ["0.0-0.1", "0.9-1.0"],
    excludedThemes: [],
    excludedCategories: [],
    cooldownHours: 24,
    cooldownMarketHours: 24,
    maxOpenTotal: 15,
    maxOpenPerMarket: 2,
    maxOpenPerTheme: 25,
    maxOpenPerCategory: 40,
    maxDailyNewTrades: 20,
    notes:
      "Longshot and near-certain tail experiment bot; focuses on extreme prices with stricter per-market limits.",
  },
];

type OptimizerBotOverrides = {
  threshold?: number;
  maxDailyNewTrades?: number;
  cooldownHours?: number;
  cooldownMarketHours?: number;
};

type OptimizerOverridesFile = {
  version: 1;
  botOverrides?: Record<string, OptimizerBotOverrides>;
};

function readOptimizerBotOverrides(): Record<string, OptimizerBotOverrides> {
  try {
    const file = path.join(process.cwd(), "dump", "paper-config-optimizer-overrides.json");
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as OptimizerOverridesFile;
    if (parsed?.version !== 1 || !parsed.botOverrides) return {};
    return parsed.botOverrides;
  } catch {
    return {};
  }
}

export async function getEffectiveBotProfiles(): Promise<EffectiveBotProfile[]> {
  const global = getPaperTradingConfig();
  const optimizerOverrides = readOptimizerBotOverrides();
  const envExplorationBand = optionalPositiveFloatFromEnv(ENV_PAPER_EXPLORATION_BAND_BELOW_MIN_SCORE);
  const envExplorationMaxPerTick = optionalNonNegIntFromEnv(ENV_PAPER_EXPLORATION_MAX_PER_TICK);

  return BOT_PROFILES.map((p) => {
    const o = optimizerOverrides[p.botType] ?? {};
    const envKeyEnabled = `PAPER_BOT_ENABLED_${p.botType.toUpperCase()}`;
    const envKeyDisabled = `PAPER_BOT_DISABLED_${p.botType.toUpperCase()}`;
    const rawEnabled = typeof process !== "undefined" ? process.env[envKeyEnabled]?.trim().toLowerCase() : "";
    const rawDisabled = typeof process !== "undefined" ? process.env[envKeyDisabled]?.trim().toLowerCase() : "";
    const overrideEnabled =
      rawEnabled === "1" || rawEnabled === "true"
        ? true
        : rawDisabled === "1" || rawDisabled === "true"
          ? false
          : null;
    const enabled = overrideEnabled != null ? overrideEnabled : p.enabled;
    const overrideSource = overrideEnabled != null ? "env" : null;

    const effective: EffectiveBotProfile = {
      botType: p.botType,
      displayName: p.displayName,
      enabled: p.enabled,
      targetLabel: p.targetLabel ?? null,
      botVersion: p.botVersion ?? null,
      threshold: o.threshold ?? p.threshold ?? global.threshold,
      minScoreBuffer: p.minScoreBuffer ?? global.minScoreBuffer,
      allowReviewRequired: p.allowReviewRequired ?? global.allowReviewRequired,
      allowPaperRelaxation: p.allowPaperRelaxation ?? true,
      allowRelaxationReasons: p.allowRelaxationReasons ?? null,
      allowedPolicyStates: p.allowedPolicyStates ?? null,
      allowedPriceBands: p.allowedPriceBands ?? null,
      excludedThemes: p.excludedThemes ?? [],
      excludedCategories: p.excludedCategories ?? [],
      cooldownHours: o.cooldownHours ?? p.cooldownHours ?? global.cooldownHours,
      cooldownMarketHours: o.cooldownMarketHours ?? p.cooldownMarketHours ?? global.cooldownMarketHours,
      maxOpenTotal: p.maxOpenTotal ?? global.maxOpenTotal,
      maxOpenPerMarket: p.maxOpenPerMarket ?? global.maxOpenPerMarket,
      maxOpenPerTheme: p.maxOpenPerTheme ?? global.maxOpenPerTheme,
      maxOpenPerCategory: p.maxOpenPerCategory ?? global.maxOpenPerCategory,
      maxDailyNewTrades: o.maxDailyNewTrades ?? p.maxDailyNewTrades ?? global.maxDailyNewTrades,
      notes: p.notes ?? null,
      effectiveEnabled: enabled,
      overrideSource,
      explorationEnabled: p.explorationEnabled ?? false,
      explorationBandBelowMinScore: envExplorationBand ?? p.explorationBandBelowMinScore ?? 0,
      explorationMaxPerTick:
        envExplorationMaxPerTick !== undefined ? envExplorationMaxPerTick : (p.explorationMaxPerTick ?? 0),
      explorationMaxPerDay: p.explorationMaxPerDay ?? 0,
    };
    return effective;
  });
}

export async function getActiveBotProfiles(): Promise<EffectiveBotProfile[]> {
  const effective = await getEffectiveBotProfiles();
  return effective.filter((p) => p.effectiveEnabled);
}

export function getBotProfile(botType: string): BotProfile | undefined {
  return BOT_PROFILES.find((p) => p.botType === botType);
}

