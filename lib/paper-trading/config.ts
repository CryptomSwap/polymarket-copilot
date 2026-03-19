import * as fs from "fs";
import * as path from "path";

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

/** Default score threshold (e.g. labelGoodDecision12h probability). */
export const DEFAULT_PAPER_TRADING_THRESHOLD = 0.3;

/** Cooldown: do not open another paper trade for same asset within this many hours. */
export const DEFAULT_PAPER_TRADING_COOLDOWN_HOURS = 12;

/** Cooldown for same market (optional; 0 = no market cooldown). */
export const DEFAULT_PAPER_TRADING_COOLDOWN_MARKET_HOURS = 0;

/** Optional min score above threshold (e.g. 0.05 => require score >= threshold + 0.05). */
export const DEFAULT_PAPER_TRADING_MIN_SCORE_BUFFER = 0;

/** Max open paper trades globally (0 or unset = no limit). */
export const DEFAULT_PAPER_TRADING_MAX_OPEN_TOTAL = 0;

/** Max open paper trades per market (0 = no limit). */
export const DEFAULT_PAPER_TRADING_MAX_OPEN_PER_MARKET = 0;

/** Max open paper trades per theme (0 = no limit). */
export const DEFAULT_PAPER_TRADING_MAX_OPEN_PER_THEME = 0;

/** Max open paper trades per category (0 = no limit). */
export const DEFAULT_PAPER_TRADING_MAX_OPEN_PER_CATEGORY = 0;

/** Max new paper trades opened per calendar day (0 = no limit). */
export const DEFAULT_PAPER_TRADING_MAX_DAILY_NEW_TRADES = 0;
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
  source: string;
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
    source: optimizer ? "env+optimizer_override" : "env",
  };
}
