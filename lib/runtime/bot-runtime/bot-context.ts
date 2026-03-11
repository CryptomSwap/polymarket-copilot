import type { MarketStateStore } from "../market-state/market-state-store";
import type { RuntimePositionStore } from "../positions/runtime-position-store";
import type { RuntimeRiskState } from "../risk/runtime-risk-engine";
import type { RuntimeOrderState } from "../order-manager/order-manager";
import type {
  BotDecisionContext,
  RegimeStateStub,
  StrategyConfigStub,
} from "./bot-decision-types";

/**
 * Per-tick bot runtime context view.
 * Provides read-only access to live market, positions, and risk state.
 */

export interface BotRuntimeContextDeps {
  marketStateStore: MarketStateStore;
  positionStore: RuntimePositionStore;
  /** Optional: provide open orders for an asset (e.g. from OrderLifecycleStore). */
  getOpenOrdersForAsset?: (funderAddress: string, assetId: string) => RuntimeOrderState[];
}

export interface BotRuntimeContextSnapshot {
  marketStateStore: MarketStateStore;
  positionStore: RuntimePositionStore;
  riskState: RuntimeRiskState;
  asOf: Date;
}

export interface BotRuntimeContextProvider {
  createSnapshot(): BotRuntimeContextSnapshot;
}

/**
 * Options for building a per-asset decision context.
 */
export interface BuildContextOptions {
  funderAddress: string;
  strategyId: string;
  assetId: string;
  asOf: Date;
  /** Optional regime state (stub-friendly). */
  regimeState?: RegimeStateStub | null;
  /** Optional strategy config (stub-friendly). */
  strategyConfig?: StrategyConfigStub | null;
  /** Optional: get open orders for this asset. */
  getOpenOrdersForAsset?: (funderAddress: string, assetId: string) => RuntimeOrderState[];
}

/**
 * Build a read-only BotDecisionContext for a single asset.
 * Gathers: asset live state, position, open orders, risk state, regime, strategy config.
 */
export function buildBotDecisionContext(
  snapshot: BotRuntimeContextSnapshot,
  options: BuildContextOptions
): BotDecisionContext {
  const { funderAddress, strategyId, assetId, asOf, regimeState, strategyConfig } = options;
  const assetLiveState = snapshot.marketStateStore.getAsset(assetId) ?? null;
  const position = snapshot.positionStore.getPosition(funderAddress, assetId) ?? null;
  const openOrders = options.getOpenOrdersForAsset?.(funderAddress, assetId) ?? [];

  return {
    funderAddress,
    strategyId,
    asOf,
    assetId,
    assetLiveState: assetLiveState ?? undefined,
    position: position ?? undefined,
    openOrders: openOrders.length > 0 ? openOrders : undefined,
    riskState: snapshot.riskState,
    regimeState: regimeState ?? undefined,
    strategyConfig: strategyConfig ?? undefined,
  };
}

/**
 * Minimal context provider stub that simply wraps underlying stores.
 */
export class DefaultBotRuntimeContextProvider implements BotRuntimeContextProvider {
  private readonly deps: BotRuntimeContextDeps;
  private riskState: RuntimeRiskState;

  constructor(deps: BotRuntimeContextDeps, initialRiskState: RuntimeRiskState) {
    this.deps = deps;
    this.riskState = initialRiskState;
  }

  updateRiskState(next: RuntimeRiskState): void {
    this.riskState = next;
  }

  createSnapshot(): BotRuntimeContextSnapshot {
    return {
      marketStateStore: this.deps.marketStateStore,
      positionStore: this.deps.positionStore,
      riskState: this.riskState,
      asOf: new Date(),
    };
  }

  /** Expose deps so runtime can pass getOpenOrdersForAsset when building context. */
  getDeps(): BotRuntimeContextDeps {
    return this.deps;
  }
}
