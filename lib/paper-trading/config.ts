import * as fs from "fs";
import * as path from "path";
import {
  DEFAULT_PAPER_SIZE_SCORE_TIERS,
  parsePaperSizeScoreTiersJson,
  type PaperSizeScoreTier,
} from "./paper-roi-admission";

/**
 * Paper trading configuration. No real orders; threshold, cooldowns, and risk limits control when we open/avoid duplicate paper trades.
 */

const ENV_PAPER_TRADING_ENABLED = "PAPER_TRADING_ENABLED";
const ENV_PAPER_TRADING_THRESHOLD = "PAPER_TRADING_THRESHOLD";
const ENV_PAPER_TRADING_COOLDOWN_HOURS = "PAPER_TRADING_COOLDOWN_HOURS";
const ENV_PAPER_TRADING_COOLDOWN_MARKET_HOURS = "PAPER_TRADING_COOLDOWN_MARKET_HOURS";
const ENV_PAPER_TRADING_MIN_SCORE_BUFFER = "PAPER_TRADING_MIN_SCORE_BUFFER";
const ENV_PAPER_TRADING_MAX_OPEN_TOTAL = "PAPER_TRADING_MAX_OPEN_TOTAL";
const ENV_PAPER_TRADING_MAX_OPEN_PER_MARKET = "PAPER_TRADING_MAX_OPEN_PER_MARKET";
const ENV_PAPER_TRADING_MAX_OPEN_PER_THEME = "PAPER_TRADING_MAX_OPEN_PER_THEME";
const ENV_PAPER_TRADING_MAX_OPEN_PER_CATEGORY = "PAPER_TRADING_MAX_OPEN_PER_CATEGORY";
const ENV_PAPER_TRADING_MAX_DAILY_NEW_TRADES = "PAPER_TRADING_MAX_DAILY_NEW_TRADES";
const ENV_PAPER_TRADING_ALLOW_REVIEW_REQUIRED = "PAPER_TRADING_ALLOW_REVIEW_REQUIRED";
const ENV_PAPER_TRADING_ALLOW_BLOCK_EDGE_TOO_SMALL = "PAPER_TRADING_ALLOW_BLOCK_EDGE_TOO_SMALL";
const ENV_PAPER_TRADING_ALLOW_BLOCK_LOW_LIQUIDITY = "PAPER_TRADING_ALLOW_BLOCK_LOW_LIQUIDITY";
const ENV_PAPER_TRADING_ALLOW_BLOCK_CROWDED = "PAPER_TRADING_ALLOW_BLOCK_CROWDED";
const ENV_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_PER_TICK =
  "PAPER_TRADING_RELAXED_CONCENTRATION_MAX_PER_TICK";
const ENV_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_PER_DAY =
  "PAPER_TRADING_RELAXED_CONCENTRATION_MAX_PER_DAY";
const ENV_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_OPEN_PER_MARKET =
  "PAPER_TRADING_RELAXED_CONCENTRATION_MAX_OPEN_PER_MARKET";
const ENV_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_OPEN_PER_THEME =
  "PAPER_TRADING_RELAXED_CONCENTRATION_MAX_OPEN_PER_THEME";
const ENV_PAPER_TRADING_RELAXED_CONCENTRATION_STAKE_NOTIONAL =
  "PAPER_TRADING_RELAXED_CONCENTRATION_STAKE_NOTIONAL";
const ENV_PAPER_TRADING_SHADOW_LOOKBACK_MINUTES = "PAPER_TRADING_SHADOW_LOOKBACK_MINUTES";
const ENV_PAPER_TICK_SHADOW_FUNDER_FALLBACK = "PAPER_TICK_SHADOW_FUNDER_FALLBACK";
const ENV_PAPER_TICK_SHADOW_EXTENDED_LOOKBACK_MINUTES = "PAPER_TICK_SHADOW_EXTENDED_LOOKBACK_MINUTES";

/** Paper-only: raise admission floor without changing profile threshold column semantics. */
const ENV_PAPER_TRADING_MIN_SCORE_OVERRIDE = "PAPER_TRADING_MIN_SCORE_OVERRIDE";
/** Alias for {@link ENV_PAPER_TRADING_MIN_SCORE_OVERRIDE} (same [0,1] semantics; trading key wins if both set). */
const ENV_PAPER_MIN_SCORE_OVERRIDE_GLOBAL = "PAPER_MIN_SCORE_OVERRIDE_GLOBAL";
const ENV_PAPER_TRADING_SIZE_BY_SCORE_ENABLED = "PAPER_TRADING_SIZE_BY_SCORE_ENABLED";
const ENV_PAPER_TRADING_SIZE_SCORE_BUCKETS_JSON = "PAPER_TRADING_SIZE_SCORE_BUCKETS_JSON";
const ENV_PAPER_TRADING_MAX_SPREAD_BPS = "PAPER_TRADING_MAX_SPREAD_BPS";
const ENV_PAPER_TRADING_MAX_ESTIMATED_SLIPPAGE_BPS = "PAPER_TRADING_MAX_ESTIMATED_SLIPPAGE_BPS";

/** Paper-only: logit temperature T for sigmoid(logit(p)/T); 1 = no effect. */
const ENV_PAPER_SHADOW_LOGIT_TEMPERATURE = "PAPER_SHADOW_LOGIT_TEMPERATURE";
/** Paper-only: use temperature-calibrated probability for threshold/sizing (raw still stored on PaperTrade + attribution). */
const ENV_PAPER_SHADOW_USE_CALIBRATED_SCORE_FOR_PAPER = "PAPER_SHADOW_USE_CALIBRATED_SCORE_FOR_PAPER";

export const DEFAULT_PAPER_SHADOW_LOGIT_TEMPERATURE = 1;

/** Default score threshold (e.g. labelGoodDecision12h probability). */
export const DEFAULT_PAPER_TRADING_THRESHOLD = 0.3;

/** Cooldown: do not open another paper trade for same asset within this many hours. */
export const DEFAULT_PAPER_TRADING_COOLDOWN_HOURS = 12;

/** Cooldown for same market (optional; 0 = no market cooldown). */
export const DEFAULT_PAPER_TRADING_COOLDOWN_MARKET_HOURS = 0;

/** ShadowCandidate createdAt window when loading tick candidates from runtime_automated submissions. */
export const DEFAULT_PAPER_TRADING_SHADOW_LOOKBACK_MINUTES = 30;

/** When primary funder returns zero rows, retry with this window (minutes). 0 = skip extended retry. */
export const DEFAULT_PAPER_TICK_SHADOW_EXTENDED_LOOKBACK_MINUTES = 720;

/** Optional min score above threshold (e.g. 0.05 => require score >= threshold + 0.05). */
export const DEFAULT_PAPER_TRADING_MIN_SCORE_BUFFER = 0;

/** Max open paper trades globally (0 = no limit; default enables a modest cap for paper capacity). */
/** Legacy / fallback cap; use env `PAPER_TRADING_MAX_OPEN_TOTAL`. Set ≥ sum of per-bot `maxOpenTotal` when all bots may run (e.g. 3×15=45). */
export const DEFAULT_PAPER_TRADING_MAX_OPEN_TOTAL = 45;

/** Max open paper trades per market (0 = no limit). */
export const DEFAULT_PAPER_TRADING_MAX_OPEN_PER_MARKET = 0;

/** Max open paper trades per theme (0 = no limit). */
export const DEFAULT_PAPER_TRADING_MAX_OPEN_PER_THEME = 0;

/** Max open paper trades per category (0 = no limit). */
export const DEFAULT_PAPER_TRADING_MAX_OPEN_PER_CATEGORY = 0;

/** Max new paper trades opened per calendar day (0 = no limit; default enables a modest daily cap). */
export const DEFAULT_PAPER_TRADING_MAX_DAILY_NEW_TRADES = 20;

/** Paper-only: max spread (bps) when `PAPER_TRADING_MAX_SPREAD_BPS` is unset (low-price markets need a looser cap). */
export const DEFAULT_PAPER_TRADING_MAX_SPREAD_BPS = 350;
export const DEFAULT_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_PER_TICK = 3;
export const DEFAULT_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_PER_DAY = 25;
export const DEFAULT_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_OPEN_PER_MARKET = 1;
export const DEFAULT_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_OPEN_PER_THEME = 8;
export const DEFAULT_PAPER_TRADING_RELAXED_CONCENTRATION_STAKE_NOTIONAL = 2;

export interface PaperTradingConfig {
  enabled: boolean;
  threshold: number;
  cooldownHours: number;
  cooldownMarketHours: number;
  minScoreBuffer: number;
  maxOpenTotal: number;
  maxOpenPerMarket: number;
  maxOpenPerTheme: number;
  maxOpenPerCategory: number;
  maxDailyNewTrades: number;
  /** If true, REVIEW_REQUIRED is treated as allowed for paper candidates (more candidates for shadow scoring; no real execution). */
  allowReviewRequired: boolean;
  /** Paper-only: allow BLOCK when blockReason is "Edge too small for action." (no real execution change). */
  allowBlockEdgeTooSmall: boolean;
  /** Paper-only: allow BLOCK when blockReason is "Liquidity too low for suggested size." (no real execution change). */
  allowBlockLowLiquidity: boolean;
  /** Paper-only: allow BLOCK when blockReason is "Market crowded or low liquidity." (default 0; no real execution change). */
  allowBlockCrowded: boolean;
  /** Paper-only caps for concentration-relaxed admissions. */
  relaxedConcentrationMaxPerTick: number;
  relaxedConcentrationMaxPerDay: number;
  relaxedConcentrationMaxOpenPerMarket: number;
  relaxedConcentrationMaxOpenPerTheme: number;
  /** Paper-only tiny stake used by concentration-relaxed candidates. */
  relaxedConcentrationStakeNotional: number;
  /** ShadowCandidate createdAt window for paper tick candidate load (runtime_automated, wasSubmitted). */
  shadowLookbackMinutes: number;
  /** If true and preferred funder has no rows, retry with top ShadowCandidate submitter in the window. */
  paperTickShadowFunderFallback: boolean;
  /** Wider createdAt window when primary lookback returns zero rows (0 = disabled). */
  shadowTickExtendedLookbackMinutes: number;
  source: string;

  /**
   * Paper-only: optional global floor on min admission score in [0,1]. Merged as max(baseMinScore, override).
   * Unset = no override (legacy behavior).
   */
  paperMinScoreOverrideGlobal: number | null;
  /** Paper-only: scale intendedSize by score tier when enabled. */
  paperSizeByScoreEnabled: boolean;
  /** Resolved tiers for score→size (defaults in code if JSON invalid/missing). */
  paperSizeScoreTiers: PaperSizeScoreTier[];
  /** Paper-only: max spread bps from execution quality; env unset uses {@link DEFAULT_PAPER_TRADING_MAX_SPREAD_BPS}. */
  paperMaxSpreadBps: number;
  /** Paper-only: max estimated slippage bps; null = guard off. */
  paperMaxEstimatedSlippageBps: number | null;

  /**
   * Paper-only: T in sigmoid(logit(raw)/T). 1 = identity on probability (still compute calibrated = raw).
   */
  paperShadowLogitTemperature: number;
  /**
   * When true, paper tick uses shadowMlScoreCalibrated for admission/sizing/traces; PaperTrade.score stays raw.
   */
  paperShadowUseCalibratedScoreForPaper: boolean;
}

type OptimizerGlobalOverrides = {
  relaxedConcentrationMaxPerTick?: number;
  relaxedConcentrationMaxPerDay?: number;
  relaxedConcentrationMaxOpenPerMarket?: number;
  relaxedConcentrationMaxOpenPerTheme?: number;
  relaxedConcentrationStakeNotional?: number;
};

type OptimizerOverridesFile = {
  version: 1;
  globalOverrides?: OptimizerGlobalOverrides;
};

function readOptimizerGlobalOverrides(): OptimizerGlobalOverrides | null {
  try {
    const file = path.join(process.cwd(), "dump", "paper-config-optimizer-overrides.json");
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as OptimizerOverridesFile;
    if (parsed?.version !== 1 || !parsed.globalOverrides) return null;
    return parsed.globalOverrides;
  } catch {
    return null;
  }
}

function parseIntEnv(key: string, defaultVal: number): number {
  const raw = typeof process !== "undefined" ? process.env[key]?.trim() : "";
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultVal;
}

function parseFloatEnv(key: string, defaultVal: number, min: number, max: number): number {
  const raw = typeof process !== "undefined" ? process.env[key]?.trim() : "";
  if (!raw) return defaultVal;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : defaultVal;
}

function parseBoolEnv(key: string, defaultVal: boolean): boolean {
  const raw = typeof process !== "undefined" ? process.env[key]?.trim().toLowerCase() : "";
  if (!raw) return defaultVal;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  return defaultVal;
}

/** Optional env: set = use value; empty = null (disabled). */
function parseOptionalFloatEnv01(key: string): number | null {
  const raw = typeof process !== "undefined" ? process.env[key]?.trim() : "";
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/** Optional non-negative bps cap; empty = null (guard off). */
function parseOptionalNonNegFloat(key: string): number | null {
  const raw = typeof process !== "undefined" ? process.env[key]?.trim() : "";
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function getPaperTradingConfig(): PaperTradingConfig {
  const rawEnabled = typeof process !== "undefined" ? process.env[ENV_PAPER_TRADING_ENABLED]?.trim().toLowerCase() : "";
  const enabled = rawEnabled === "0" || rawEnabled === "false" ? false : true;

  const threshold = parseFloatEnv(ENV_PAPER_TRADING_THRESHOLD, DEFAULT_PAPER_TRADING_THRESHOLD, 0, 1);
  const cooldownHours = parseIntEnv(ENV_PAPER_TRADING_COOLDOWN_HOURS, DEFAULT_PAPER_TRADING_COOLDOWN_HOURS);
  const cooldownMarketHours = parseIntEnv(ENV_PAPER_TRADING_COOLDOWN_MARKET_HOURS, DEFAULT_PAPER_TRADING_COOLDOWN_MARKET_HOURS);
  const minScoreBuffer = parseFloatEnv(ENV_PAPER_TRADING_MIN_SCORE_BUFFER, DEFAULT_PAPER_TRADING_MIN_SCORE_BUFFER, 0, 1);
  const maxOpenTotal = parseIntEnv(ENV_PAPER_TRADING_MAX_OPEN_TOTAL, DEFAULT_PAPER_TRADING_MAX_OPEN_TOTAL);
  const maxOpenPerMarket = parseIntEnv(ENV_PAPER_TRADING_MAX_OPEN_PER_MARKET, DEFAULT_PAPER_TRADING_MAX_OPEN_PER_MARKET);
  const maxOpenPerTheme = parseIntEnv(ENV_PAPER_TRADING_MAX_OPEN_PER_THEME, DEFAULT_PAPER_TRADING_MAX_OPEN_PER_THEME);
  const maxOpenPerCategory = parseIntEnv(ENV_PAPER_TRADING_MAX_OPEN_PER_CATEGORY, DEFAULT_PAPER_TRADING_MAX_OPEN_PER_CATEGORY);
  const maxDailyNewTrades = parseIntEnv(ENV_PAPER_TRADING_MAX_DAILY_NEW_TRADES, DEFAULT_PAPER_TRADING_MAX_DAILY_NEW_TRADES);
  const rawAllowReview = typeof process !== "undefined" ? process.env[ENV_PAPER_TRADING_ALLOW_REVIEW_REQUIRED]?.trim().toLowerCase() : "";
  const allowReviewRequired = rawAllowReview === "1" || rawAllowReview === "true";
  const rawEdge = typeof process !== "undefined" ? process.env[ENV_PAPER_TRADING_ALLOW_BLOCK_EDGE_TOO_SMALL]?.trim().toLowerCase() : "";
  const allowBlockEdgeTooSmall = rawEdge === "1" || rawEdge === "true";
  const rawLiq = typeof process !== "undefined" ? process.env[ENV_PAPER_TRADING_ALLOW_BLOCK_LOW_LIQUIDITY]?.trim().toLowerCase() : "";
  const allowBlockLowLiquidity = rawLiq === "1" || rawLiq === "true";
  const rawCrowded = typeof process !== "undefined" ? process.env[ENV_PAPER_TRADING_ALLOW_BLOCK_CROWDED]?.trim().toLowerCase() : "";
  const allowBlockCrowded = rawCrowded === "1" || rawCrowded === "true";
  const relaxedConcentrationMaxPerTick = parseIntEnv(
    ENV_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_PER_TICK,
    DEFAULT_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_PER_TICK
  );
  const relaxedConcentrationMaxPerDay = parseIntEnv(
    ENV_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_PER_DAY,
    DEFAULT_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_PER_DAY
  );
  const relaxedConcentrationMaxOpenPerMarket = parseIntEnv(
    ENV_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_OPEN_PER_MARKET,
    DEFAULT_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_OPEN_PER_MARKET
  );
  const relaxedConcentrationMaxOpenPerTheme = parseIntEnv(
    ENV_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_OPEN_PER_THEME,
    DEFAULT_PAPER_TRADING_RELAXED_CONCENTRATION_MAX_OPEN_PER_THEME
  );
  const relaxedConcentrationStakeNotional = parseFloatEnv(
    ENV_PAPER_TRADING_RELAXED_CONCENTRATION_STAKE_NOTIONAL,
    DEFAULT_PAPER_TRADING_RELAXED_CONCENTRATION_STAKE_NOTIONAL,
    0.01,
    1000
  );
  const shadowLookbackMinutes = parseIntEnv(
    ENV_PAPER_TRADING_SHADOW_LOOKBACK_MINUTES,
    DEFAULT_PAPER_TRADING_SHADOW_LOOKBACK_MINUTES
  );
  const paperTickShadowFunderFallback = parseBoolEnv(ENV_PAPER_TICK_SHADOW_FUNDER_FALLBACK, true);
  const shadowTickExtendedLookbackMinutes = parseIntEnv(
    ENV_PAPER_TICK_SHADOW_EXTENDED_LOOKBACK_MINUTES,
    DEFAULT_PAPER_TICK_SHADOW_EXTENDED_LOOKBACK_MINUTES
  );

  const paperMinScoreOverrideGlobal =
    parseOptionalFloatEnv01(ENV_PAPER_TRADING_MIN_SCORE_OVERRIDE) ??
    parseOptionalFloatEnv01(ENV_PAPER_MIN_SCORE_OVERRIDE_GLOBAL);
  const paperSizeByScoreEnabled = parseBoolEnv(ENV_PAPER_TRADING_SIZE_BY_SCORE_ENABLED, false);
  const bucketsRaw =
    typeof process !== "undefined" ? process.env[ENV_PAPER_TRADING_SIZE_SCORE_BUCKETS_JSON]?.trim() : "";
  const parsedTiers = bucketsRaw ? parsePaperSizeScoreTiersJson(bucketsRaw) : null;
  const paperSizeScoreTiers = parsedTiers ?? [...DEFAULT_PAPER_SIZE_SCORE_TIERS];
  const paperMaxSpreadBps =
    parseOptionalNonNegFloat(ENV_PAPER_TRADING_MAX_SPREAD_BPS) ?? DEFAULT_PAPER_TRADING_MAX_SPREAD_BPS;
  const paperMaxEstimatedSlippageBps = parseOptionalNonNegFloat(ENV_PAPER_TRADING_MAX_ESTIMATED_SLIPPAGE_BPS);

  const paperShadowLogitTemperature = parseFloatEnv(
    ENV_PAPER_SHADOW_LOGIT_TEMPERATURE,
    DEFAULT_PAPER_SHADOW_LOGIT_TEMPERATURE,
    0.05,
    50
  );
  const paperShadowUseCalibratedScoreForPaper = parseBoolEnv(
    ENV_PAPER_SHADOW_USE_CALIBRATED_SCORE_FOR_PAPER,
    false
  );

  const optimizer = readOptimizerGlobalOverrides();

  return {
    enabled,
    threshold,
    cooldownHours,
    cooldownMarketHours,
    minScoreBuffer,
    maxOpenTotal: maxOpenTotal <= 0 ? 0 : maxOpenTotal,
    maxOpenPerMarket: maxOpenPerMarket <= 0 ? 0 : maxOpenPerMarket,
    maxOpenPerTheme: maxOpenPerTheme <= 0 ? 0 : maxOpenPerTheme,
    maxOpenPerCategory: maxOpenPerCategory <= 0 ? 0 : maxOpenPerCategory,
    maxDailyNewTrades: maxDailyNewTrades <= 0 ? 0 : maxDailyNewTrades,
    allowReviewRequired,
    allowBlockEdgeTooSmall,
    allowBlockLowLiquidity,
    allowBlockCrowded,
    relaxedConcentrationMaxPerTick:
      (optimizer?.relaxedConcentrationMaxPerTick ?? relaxedConcentrationMaxPerTick) <= 0
        ? 0
        : (optimizer?.relaxedConcentrationMaxPerTick ?? relaxedConcentrationMaxPerTick),
    relaxedConcentrationMaxPerDay:
      (optimizer?.relaxedConcentrationMaxPerDay ?? relaxedConcentrationMaxPerDay) <= 0
        ? 0
        : (optimizer?.relaxedConcentrationMaxPerDay ?? relaxedConcentrationMaxPerDay),
    relaxedConcentrationMaxOpenPerMarket:
      (optimizer?.relaxedConcentrationMaxOpenPerMarket ?? relaxedConcentrationMaxOpenPerMarket) <= 0
        ? 0
        : (optimizer?.relaxedConcentrationMaxOpenPerMarket ?? relaxedConcentrationMaxOpenPerMarket),
    relaxedConcentrationMaxOpenPerTheme:
      (optimizer?.relaxedConcentrationMaxOpenPerTheme ?? relaxedConcentrationMaxOpenPerTheme) <= 0
        ? 0
        : (optimizer?.relaxedConcentrationMaxOpenPerTheme ?? relaxedConcentrationMaxOpenPerTheme),
    relaxedConcentrationStakeNotional:
      optimizer?.relaxedConcentrationStakeNotional ?? relaxedConcentrationStakeNotional,
    shadowLookbackMinutes: shadowLookbackMinutes <= 0 ? DEFAULT_PAPER_TRADING_SHADOW_LOOKBACK_MINUTES : shadowLookbackMinutes,
    paperTickShadowFunderFallback,
    shadowTickExtendedLookbackMinutes:
      shadowTickExtendedLookbackMinutes < 0 ? DEFAULT_PAPER_TICK_SHADOW_EXTENDED_LOOKBACK_MINUTES : shadowTickExtendedLookbackMinutes,
    source: optimizer ? "env+optimizer_override" : "env",
    paperMinScoreOverrideGlobal,
    paperSizeByScoreEnabled,
    paperSizeScoreTiers,
    paperMaxSpreadBps,
    paperMaxEstimatedSlippageBps,
    paperShadowLogitTemperature,
    paperShadowUseCalibratedScoreForPaper,
  };
}
