/**
 * Core bot runtime decision types.
 * Bot runtime decides desired actions only; it does not place orders directly.
 */

// ---------- Per-asset runtime state (read-only view for scheduling/cooldown) ----------

export type BotAssetMode =
  | "idle"
  | "watching"
  | "quoting"
  | "entering"
  | "exiting"
  | "cooldown"
  | "halted";

export interface BotAssetRuntimeState {
  assetId: string;
  lastEvaluatedAt: Date | null;
  lastDecisionAt: Date | null;
  cooldownUntil: Date | null;
  activeIntentId: string | null;
  lastSignal: string | null;
  mode: BotAssetMode;
}

// ---------- Decision context (built by BotDecisionContextBuilder) ----------

export interface BotDecisionContext {
  funderAddress: string;
  strategyId: string;
  asOf: Date;
  explanation?: string;
  metadata?: Record<string, unknown>;
  /** Asset under evaluation (if asset-scoped). */
  assetId?: string;
  /** Current asset live state from Market State Engine. */
  assetLiveState?: unknown;
  /** Current runtime position for this asset (if any). */
  position?: unknown;
  /** Open orders for this asset (if available). */
  openOrders?: unknown[];
  /** Current risk state snapshot. */
  riskState?: unknown;
  /** Current regime state (stub-friendly). */
  regimeState?: RegimeStateStub;
  /** Strategy config (stub-friendly). */
  strategyConfig?: StrategyConfigStub;
}

/** Stub-friendly regime input for decision layer. */
export interface RegimeStateStub {
  regime: string;
  confidence?: number;
  updatedAt?: Date;
}

/** Stub-friendly strategy config. */
export interface StrategyConfigStub {
  strategyId: string;
  enabled: boolean;
  maxPositionSize?: number;
  maxOrdersPerAsset?: number;
  cooldownMs?: number;
}

// ---------- Decision actions and output ----------

export type BotDecisionActionKind =
  | "NOOP"
  | "PLACE_ENTRY"
  | "PLACE_EXIT"
  | "UPDATE_QUOTES"
  | "CANCEL_ORDERS"
  | "REDUCE_RISK";

export interface BotDecisionOutput {
  action: BotDecisionActionKind;
  assetId: string;
  marketId?: string;
  /** For PLACE_ENTRY / PLACE_EXIT / UPDATE_QUOTES: side and size/price. */
  side?: "BUY" | "SELL";
  size?: number;
  limitPrice?: number;
  /** Optional intent id for idempotency. */
  intentId?: string;
  /** Human-readable reason. */
  reason?: string;
}

export interface BotDecisionEnvelope {
  context: BotDecisionContext;
  decisions: StrategyDecision[];
  /** Outputs from this evaluation (actions the bot would take). */
  outputs?: BotDecisionOutput[];
}

// ---------- Legacy / compatibility ----------

export type StrategyDecisionKind = "open" | "reduce" | "exit" | "rebalance" | "do_nothing";

export interface StrategyDecision {
  kind: StrategyDecisionKind;
  assetId: string;
  marketId: string;
  outcome: string;
  side: "BUY" | "SELL";
  size: number;
  limitPrice: number;
  maxRiskBudget?: number;
}
