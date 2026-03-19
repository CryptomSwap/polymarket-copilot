import type { RuntimeEventBus } from "../events/runtime-event-bus";
import { createRuntimeEventId } from "../events/runtime-events";
import type { RiskLimitHitEvent } from "../events/runtime-events";
import type { BotDecisionContext } from "../bot-runtime/bot-decision-types";
import type { BotDecisionOutput } from "../bot-runtime/bot-decision-types";
import type { RuntimeRiskState, RuntimeRiskLimits } from "./runtime-risk-engine";
import { DEFAULT_RUNTIME_RISK_LIMITS } from "./runtime-risk-engine";

/**
 * Runtime guardrails: hard checks before order submission.
 * Evaluates BotDecisionContext, risk state, and optional freshness/phase; returns verdict and reason codes.
 * Final order admission depends on freshness truth (market/user/reconciliation) and runtime phase, not just connectivity.
 */

export type GuardrailVerdict =
  | "allowed"
  | "blocked"
  | "requires_reduction"
  | "cancel_only"
  | "frozen";

/** Machine-readable reason codes for audit and Order Manager. */
export const GUARDRAIL_REASON_CODES = {
  KILL_SWITCH_GLOBAL: "kill_switch_global",
  KILL_SWITCH_ASSET: "kill_switch_asset",
  MARKET_STALE: "market_stale",
  MARKET_DEGRADED: "market_degraded",
  MARKET_HEALTH_UNKNOWN: "market_health_unknown",
  POSITION_DEGRADED: "position_degraded",
  POSITION_RECONCILING: "position_reconciling",
  EXCHANGE_UNHEALTHY: "exchange_unhealthy",
  LIQUIDITY_BELOW_THRESHOLD: "liquidity_below_threshold",
  SPREAD_BELOW_THRESHOLD: "spread_below_threshold",
  NOT_TRADABLE: "not_tradable",
  EXPOSURE_TOTAL_BREACH: "exposure_total_breach",
  EXPOSURE_PER_ASSET_BREACH: "exposure_per_asset_breach",
  INVENTORY_PER_ASSET_BREACH: "inventory_per_asset_breach",
  WORKING_ORDERS_BREACH: "working_orders_breach",
  DEGRADED_SAFE_MODE: "degraded_safe_mode",
  // Freshness / phase (order admission depends on these)
  MARKET_DATA_STALE: "market_data_stale",
  USER_DATA_STALE: "user_data_stale",
  RECONCILIATION_STALE: "reconciliation_stale",
  RUNTIME_REBUILDING: "runtime_rebuilding",
  RUNTIME_RECONCILING: "runtime_reconciling",
  WATCHDOG_KILL_SWITCH: "watchdog_kill_switch",
  EXCHANGE_TRUTH_UNVERIFIED: "exchange_truth_unverified",
  // Exchange-truth authority: block new entry when truth stale/unavailable and working orders exist
  EXCHANGE_TRUTH_STALE: "exchange_truth_stale",
  EXCHANGE_TRUTH_UNAVAILABLE: "exchange_truth_unavailable",
  EXCHANGE_TRUTH_ORDERS_STALE: "exchange_truth_orders_stale",
  EXCHANGE_TRUTH_FILLS_STALE: "exchange_truth_fills_stale",
  // Execution failure containment: ambiguous outcome blocks new entry for asset
  ASSET_EXECUTION_FROZEN: "asset_execution_frozen",
  EXECUTION_VERIFICATION_REQUIRED: "execution_verification_required",
  SUBMIT_AMBIGUOUS: "submit_ambiguous",
  CANCEL_AMBIGUOUS: "cancel_ambiguous",
  REPLACE_AMBIGUOUS: "replace_ambiguous",
} as const;

export type GuardrailReasonCode = (typeof GUARDRAIL_REASON_CODES)[keyof typeof GUARDRAIL_REASON_CODES];

export interface GuardrailEvaluationResult {
  verdict: GuardrailVerdict;
  reasonCodes: GuardrailReasonCode[];
  /** Human-readable summary. */
  reason?: string;
}

/** Optional freshness/phase input so guardrails can block when data is not trustworthy. */
export interface GuardrailFreshnessInput {
  /** Current runtime phase: starting | rebuilding | reconciling | ready | degraded | stopped. */
  runtimePhase: string;
  /** Market stream has recent real data (not just heartbeat). */
  marketDataFresh: boolean;
  /** User stream has recent real data. */
  userDataFresh: boolean;
  /** Runtime vs exchange reconciliation recently succeeded. */
  reconciliationFresh: boolean;
  /** Kill switch tripped by watchdog (e.g. stream silence). */
  watchdogKillSwitch?: boolean;
  /** Count of working/open orders (for user_data_stale and exchange truth: block new when > 0 and stale). */
  openOrderCount?: number;
  /** Exchange truth: authoritative orders/fills pull is healthy and recent. */
  exchangeTruthHealthy?: boolean;
  /** When true, exchange pull failed or no credentials (use EXCHANGE_TRUTH_UNAVAILABLE). */
  exchangeTruthUnavailable?: boolean;
  /** When true, block new entry if working orders exist and exchange truth is stale or unavailable. */
  blockOnStaleExchangeTruthWithWorkingOrders?: boolean;
  /** Asset IDs for which execution is frozen (ambiguous submit/cancel/replace). */
  executionFrozenAssetIds?: ReadonlySet<string>;
  /** When true, containment suggests force cancel_only or frozen (repeated ambiguity). */
  executionContainmentForceCancelOnlyOrFrozen?: boolean;
}

export interface GuardrailEvaluationOptions {
  freshness?: GuardrailFreshnessInput | null;
  /** When true (e.g. paper-mode shadow collection), do not block on MARKET_DEGRADED or NOT_TRADABLE so strategy-relaxed intents can become allowed/submitted. */
  allowDegradedAndNotTradableForPaper?: boolean;
  /** Optional diagnostic callback when market-health block runs: receives option and computed skip. Caller can log to verify option is applied (e.g. first N intents). */
  guardrailDiagnosticLog?: (data: {
    allowDegradedAndNotTradableForPaper: boolean;
    skipMarketHealthForPaper: boolean;
  }) => void;
}

export interface RuntimeGuardrails {
  evaluate(
    context: BotDecisionContext,
    riskState: RuntimeRiskState,
    proposedAction?: BotDecisionOutput | null,
    options?: GuardrailEvaluationOptions | null
  ): GuardrailEvaluationResult;
}

const EVENT_SOURCE = "risk_engine" as const;

function emitLimitHit(
  eventBus: RuntimeEventBus | undefined,
  funderAddress: string,
  limitType: string,
  currentValue: number,
  limitValue: number
): void {
  if (!eventBus) return;
  const event: RiskLimitHitEvent = {
    id: createRuntimeEventId(),
    type: "risk.limit_hit",
    source: EVENT_SOURCE,
    occurredAt: new Date(),
    payload: {
      funderAddress,
      limitType,
      currentValue,
      limitValue,
      breachedAt: new Date(),
    },
  };
  eventBus.publish(event);
}

/** Type-safe view of asset live state (from context.assetLiveState). */
interface AssetLiveStateView {
  health?: { isStale?: boolean; isDegraded?: boolean };
  liquidity?: { qualityScore?: number | null; isTradable?: boolean };
  quote?: { spreadBps?: number | null };
}

/** Type-safe view of runtime position (from context.position). */
interface PositionStateView {
  confidence?: string;
  netShares?: number;
  exposureNotional?: number;
}

function getAssetLiveState(ctx: BotDecisionContext): AssetLiveStateView | null {
  const a = ctx.assetLiveState;
  if (a == null || typeof a !== "object") return null;
  return a as AssetLiveStateView;
}

function getPositionState(ctx: BotDecisionContext): PositionStateView | null {
  const p = ctx.position;
  if (p == null || typeof p !== "object") return null;
  return p as PositionStateView;
}

export interface DefaultRuntimeGuardrailsOptions {
  eventBus?: RuntimeEventBus;
  limits?: Partial<RuntimeRiskLimits>;
}

/**
 * Guardrails implementation: checks kill switch, exchange health, market/position
 * health, liquidity, exposure limits, and degraded safe mode.
 */
export class DefaultRuntimeGuardrails implements RuntimeGuardrails {
  private readonly eventBus: RuntimeEventBus | undefined;
  private readonly limits: RuntimeRiskLimits;

  constructor(options: DefaultRuntimeGuardrailsOptions = {}) {
    this.eventBus = options.eventBus;
    this.limits = { ...DEFAULT_RUNTIME_RISK_LIMITS, ...options.limits };
  }

  evaluate(
    context: BotDecisionContext,
    riskState: RuntimeRiskState,
    proposedAction?: BotDecisionOutput | null,
    options?: GuardrailEvaluationOptions | null
  ): GuardrailEvaluationResult {
    const codes: GuardrailReasonCode[] = [];
    const limits = riskState.limits;
    const funderAddress = context.funderAddress ?? "";
    const assetId = context.assetId ?? "";
    const action = proposedAction?.action;
    const isNewEntryAction =
      action === "PLACE_ENTRY" || action === "UPDATE_QUOTES";
    const isReduceOrCancelAction =
      action === "CANCEL_ORDERS" || action === "REDUCE_RISK" || action === "PLACE_EXIT";

    if (!riskState.globalAutomationEnabled) {
      codes.push(GUARDRAIL_REASON_CODES.KILL_SWITCH_GLOBAL);
    }
    if (options?.freshness?.watchdogKillSwitch) {
      codes.push(GUARDRAIL_REASON_CODES.WATCHDOG_KILL_SWITCH);
    }
    if (assetId && riskState.haltedAssetIds.includes(assetId)) {
      codes.push(GUARDRAIL_REASON_CODES.KILL_SWITCH_ASSET);
    }
    if (options?.freshness?.executionFrozenAssetIds?.has(assetId)) {
      codes.push(GUARDRAIL_REASON_CODES.ASSET_EXECUTION_FROZEN);
    }
    if (options?.freshness?.executionContainmentForceCancelOnlyOrFrozen) {
      codes.push(GUARDRAIL_REASON_CODES.EXECUTION_VERIFICATION_REQUIRED);
    }
    if (riskState.exchangeHealth === "unhealthy") {
      codes.push(GUARDRAIL_REASON_CODES.EXCHANGE_UNHEALTHY);
    }
    if (riskState.degradedSafeMode && proposedAction?.action === "PLACE_ENTRY") {
      codes.push(GUARDRAIL_REASON_CODES.DEGRADED_SAFE_MODE);
    }

    const f = options?.freshness;
    if (f) {
      if (f.runtimePhase === "rebuilding") {
        codes.push(GUARDRAIL_REASON_CODES.RUNTIME_REBUILDING);
      }
      if (f.runtimePhase === "reconciling") {
        codes.push(GUARDRAIL_REASON_CODES.RUNTIME_RECONCILING);
      }
      if (
        f.runtimePhase === "rebuilding" ||
        f.runtimePhase === "reconciling" ||
        f.runtimePhase === "starting"
      ) {
        codes.push(GUARDRAIL_REASON_CODES.EXCHANGE_TRUTH_UNVERIFIED);
      }
      if (!f.marketDataFresh && isNewEntryAction) {
        codes.push(GUARDRAIL_REASON_CODES.MARKET_DATA_STALE);
      }
      if (!f.userDataFresh && isNewEntryAction) {
        const openCount = f.openOrderCount ?? 0;
        if (openCount > 0) {
          codes.push(GUARDRAIL_REASON_CODES.USER_DATA_STALE);
        }
      }
      if (!f.reconciliationFresh && isNewEntryAction) {
        codes.push(GUARDRAIL_REASON_CODES.RECONCILIATION_STALE);
      }
      // Exchange truth: block new entry when truth is stale or unavailable and we have working orders
      const blockOnStaleWithOrders = f.blockOnStaleExchangeTruthWithWorkingOrders !== false;
      const openCount = f.openOrderCount ?? 0;
      if (f.exchangeTruthUnavailable && blockOnStaleWithOrders && openCount > 0) {
        codes.push(GUARDRAIL_REASON_CODES.EXCHANGE_TRUTH_UNAVAILABLE);
      }
      if (f.exchangeTruthHealthy === false && blockOnStaleWithOrders && openCount > 0 && isNewEntryAction) {
        codes.push(GUARDRAIL_REASON_CODES.EXCHANGE_TRUTH_STALE);
      }
    }

    const asset = getAssetLiveState(context);
    const allowDegradedAndNotTradableForPaper = options?.allowDegradedAndNotTradableForPaper === true;
    const skipMarketHealthForPaper = allowDegradedAndNotTradableForPaper;
    if (asset && riskState.marketStateHealthGatingEnabled) {
      options?.guardrailDiagnosticLog?.({
        allowDegradedAndNotTradableForPaper,
        skipMarketHealthForPaper,
      });
      if (asset.health?.isStale && !skipMarketHealthForPaper) codes.push(GUARDRAIL_REASON_CODES.MARKET_STALE);
      if (asset.health?.isDegraded && !skipMarketHealthForPaper) codes.push(GUARDRAIL_REASON_CODES.MARKET_DEGRADED);
      const q = asset.liquidity?.qualityScore ?? 0;
      if (q < limits.minLiquidityQualityScore) {
        codes.push(GUARDRAIL_REASON_CODES.LIQUIDITY_BELOW_THRESHOLD);
        emitLimitHit(
          this.eventBus,
          funderAddress,
          "minLiquidityQualityScore",
          q,
          limits.minLiquidityQualityScore
        );
      }
      if (asset.liquidity?.isTradable === false && !skipMarketHealthForPaper) {
        codes.push(GUARDRAIL_REASON_CODES.NOT_TRADABLE);
      }
      const spreadBps = asset.quote?.spreadBps ?? 1e6;
      if (spreadBps < limits.minQuoteSpreadBps && limits.minQuoteSpreadBps > 0) {
        codes.push(GUARDRAIL_REASON_CODES.SPREAD_BELOW_THRESHOLD);
      }
    }

    const pos = getPositionState(context);
    if (pos?.confidence === "degraded") {
      codes.push(GUARDRAIL_REASON_CODES.POSITION_DEGRADED);
    }
    if (pos?.confidence === "reconciling") {
      codes.push(GUARDRAIL_REASON_CODES.POSITION_RECONCILING);
    }

    if (riskState.grossExposure > limits.maxTotalExposure) {
      codes.push(GUARDRAIL_REASON_CODES.EXPOSURE_TOTAL_BREACH);
      emitLimitHit(
        this.eventBus,
        funderAddress,
        "maxTotalExposure",
        riskState.grossExposure,
        limits.maxTotalExposure
      );
    }
    if (riskState.workingOrderCount >= limits.maxConcurrentWorkingOrders) {
      codes.push(GUARDRAIL_REASON_CODES.WORKING_ORDERS_BREACH);
      emitLimitHit(
        this.eventBus,
        funderAddress,
        "maxConcurrentWorkingOrders",
        riskState.workingOrderCount,
        limits.maxConcurrentWorkingOrders
      );
    }

    const posNotional = pos?.exposureNotional ?? 0;
    if (posNotional > limits.maxNotionalPerAsset) {
      codes.push(GUARDRAIL_REASON_CODES.EXPOSURE_PER_ASSET_BREACH);
      emitLimitHit(
        this.eventBus,
        funderAddress,
        "maxNotionalPerAsset",
        posNotional,
        limits.maxNotionalPerAsset
      );
    }
    const posShares = Math.abs(pos?.netShares ?? 0);
    if (posShares > limits.maxInventoryPerAsset) {
      codes.push(GUARDRAIL_REASON_CODES.INVENTORY_PER_ASSET_BREACH);
      emitLimitHit(
        this.eventBus,
        funderAddress,
        "maxInventoryPerAsset",
        posShares,
        limits.maxInventoryPerAsset
      );
    }

    const frozen =
      codes.includes(GUARDRAIL_REASON_CODES.RUNTIME_REBUILDING) ||
      codes.includes(GUARDRAIL_REASON_CODES.RUNTIME_RECONCILING) ||
      codes.includes(GUARDRAIL_REASON_CODES.EXCHANGE_TRUTH_UNVERIFIED) ||
      (options?.freshness?.executionContainmentForceCancelOnlyOrFrozen === true);
    const killSwitchOnly =
      codes.length > 0 &&
      codes.every(
        (c) =>
          c === GUARDRAIL_REASON_CODES.KILL_SWITCH_GLOBAL ||
          c === GUARDRAIL_REASON_CODES.WATCHDOG_KILL_SWITCH ||
          c === GUARDRAIL_REASON_CODES.KILL_SWITCH_ASSET
      );
    const hardBlock = codes.some(
      (c) =>
        c === GUARDRAIL_REASON_CODES.KILL_SWITCH_GLOBAL ||
        c === GUARDRAIL_REASON_CODES.WATCHDOG_KILL_SWITCH ||
        c === GUARDRAIL_REASON_CODES.KILL_SWITCH_ASSET ||
        c === GUARDRAIL_REASON_CODES.EXCHANGE_UNHEALTHY ||
        c === GUARDRAIL_REASON_CODES.MARKET_STALE ||
        c === GUARDRAIL_REASON_CODES.MARKET_DEGRADED ||
        c === GUARDRAIL_REASON_CODES.POSITION_DEGRADED ||
        c === GUARDRAIL_REASON_CODES.EXCHANGE_TRUTH_STALE ||
        c === GUARDRAIL_REASON_CODES.EXCHANGE_TRUTH_UNAVAILABLE ||
        c === GUARDRAIL_REASON_CODES.ASSET_EXECUTION_FROZEN
    );
    const freshnessBlockOnly =
      codes.length > 0 &&
      !frozen &&
      !hardBlock &&
      (codes.includes(GUARDRAIL_REASON_CODES.MARKET_DATA_STALE) ||
        codes.includes(GUARDRAIL_REASON_CODES.USER_DATA_STALE) ||
        codes.includes(GUARDRAIL_REASON_CODES.RECONCILIATION_STALE));
    const reduceOnly =
      codes.includes(GUARDRAIL_REASON_CODES.DEGRADED_SAFE_MODE) ||
      codes.some(
        (c) =>
          c === GUARDRAIL_REASON_CODES.EXPOSURE_TOTAL_BREACH ||
          c === GUARDRAIL_REASON_CODES.WORKING_ORDERS_BREACH
      );

    let verdict: GuardrailVerdict = "allowed";
    if (codes.length > 0) {
      if (frozen) {
        verdict = "frozen";
      } else if (killSwitchOnly) {
        verdict = "cancel_only";
      } else if (hardBlock) {
        verdict = "blocked";
      } else if (freshnessBlockOnly && isNewEntryAction) {
        verdict = "requires_reduction";
      } else if (reduceOnly) {
        verdict = "requires_reduction";
      } else {
        verdict = "blocked";
      }
    }

    return {
      verdict: codes.length === 0 ? "allowed" : verdict,
      reasonCodes: codes,
      reason: codes.length > 0 ? codes.join("; ") : undefined,
    };
  }
}

/** No-op guardrails: always allow. Use for testing or when risk is enforced elsewhere. */
export class NoopRuntimeGuardrails implements RuntimeGuardrails {
  evaluate(
    _context: BotDecisionContext,
    _riskState: RuntimeRiskState,
    _proposedAction?: BotDecisionOutput | null,
    _options?: GuardrailEvaluationOptions | null
  ): GuardrailEvaluationResult {
    return { verdict: "allowed", reasonCodes: [] };
  }
}
