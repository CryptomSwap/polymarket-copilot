import type { RuntimeEventBus } from "../events/runtime-event-bus";
import { createRuntimeEventId } from "../events/runtime-events";
import type { RiskLimitHitEvent } from "../events/runtime-events";
import type { BotDecisionContext } from "../bot-runtime/bot-decision-types";
import type { BotDecisionOutput } from "../bot-runtime/bot-decision-types";
import type { RuntimeRiskState, RuntimeRiskLimits } from "./runtime-risk-engine";
import { DEFAULT_RUNTIME_RISK_LIMITS } from "./runtime-risk-engine";

/**
 * Runtime guardrails: hard checks before order submission.
 * Evaluates BotDecisionContext and proposed action; returns allowed / blocked / requires_reduction.
 * Emits risk.limit_hit when a limit breach causes block/reduce.
 */

export type GuardrailVerdict = "allowed" | "blocked" | "requires_reduction";

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
} as const;

export type GuardrailReasonCode = (typeof GUARDRAIL_REASON_CODES)[keyof typeof GUARDRAIL_REASON_CODES];

export interface GuardrailEvaluationResult {
  verdict: GuardrailVerdict;
  reasonCodes: GuardrailReasonCode[];
  /** Human-readable summary. */
  reason?: string;
}

export interface RuntimeGuardrails {
  evaluate(
    context: BotDecisionContext,
    riskState: RuntimeRiskState,
    proposedAction?: BotDecisionOutput | null
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
    proposedAction?: BotDecisionOutput | null
  ): GuardrailEvaluationResult {
    const codes: GuardrailReasonCode[] = [];
    const limits = riskState.limits;
    const funderAddress = context.funderAddress ?? "";
    const assetId = context.assetId ?? "";

    if (!riskState.globalAutomationEnabled) {
      codes.push(GUARDRAIL_REASON_CODES.KILL_SWITCH_GLOBAL);
    }
    if (assetId && riskState.haltedAssetIds.includes(assetId)) {
      codes.push(GUARDRAIL_REASON_CODES.KILL_SWITCH_ASSET);
    }
    if (riskState.exchangeHealth === "unhealthy") {
      codes.push(GUARDRAIL_REASON_CODES.EXCHANGE_UNHEALTHY);
    }
    if (riskState.degradedSafeMode && proposedAction?.action === "PLACE_ENTRY") {
      codes.push(GUARDRAIL_REASON_CODES.DEGRADED_SAFE_MODE);
    }

    const asset = getAssetLiveState(context);
    if (asset && riskState.marketStateHealthGatingEnabled) {
      if (asset.health?.isStale) codes.push(GUARDRAIL_REASON_CODES.MARKET_STALE);
      if (asset.health?.isDegraded) codes.push(GUARDRAIL_REASON_CODES.MARKET_DEGRADED);
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
      if (asset.liquidity?.isTradable === false) {
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

    const blocked = codes.some(
      (c) =>
        c === GUARDRAIL_REASON_CODES.KILL_SWITCH_GLOBAL ||
        c === GUARDRAIL_REASON_CODES.KILL_SWITCH_ASSET ||
        c === GUARDRAIL_REASON_CODES.EXCHANGE_UNHEALTHY ||
        c === GUARDRAIL_REASON_CODES.MARKET_STALE ||
        c === GUARDRAIL_REASON_CODES.MARKET_DEGRADED ||
        c === GUARDRAIL_REASON_CODES.POSITION_DEGRADED
    );
    const reduceOnly =
      codes.includes(GUARDRAIL_REASON_CODES.DEGRADED_SAFE_MODE) ||
      codes.some(
        (c) =>
          c === GUARDRAIL_REASON_CODES.EXPOSURE_TOTAL_BREACH ||
          c === GUARDRAIL_REASON_CODES.WORKING_ORDERS_BREACH
      );

    let verdict: GuardrailVerdict = "allowed";
    if (blocked || codes.length > 0) {
      verdict = blocked ? "blocked" : reduceOnly ? "requires_reduction" : "blocked";
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
    _proposedAction?: BotDecisionOutput | null
  ): GuardrailEvaluationResult {
    return { verdict: "allowed", reasonCodes: [] };
  }
}
