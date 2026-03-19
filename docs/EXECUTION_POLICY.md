# Execution Policy Gate

The execution policy is a **formal pre-trade gate** that every executable order path must pass before an order can be submitted to the paper order manager or any future live adapter. It is a single deterministic evaluator: no alpha scoring, no hidden weighting, fail closed when critical information is missing.

## Purpose

- **Safety, not alpha.** The gate inspects runtime safety, data freshness, exposure, recommendation quality, and order sanity. It is not a strategy or scoring layer; it only answers “is it safe to submit this order?”
- **Auditable.** Every evaluation produces a structured result with explicit blocking reasons and a snapshot suitable for persistence (e.g. `OrderIntent.executionPolicySnapshotJson` or lifecycle journal).
- **Conservative.** Missing critical data blocks. Soft deficiencies can warn but still allow when policy state is `allow` or `warn`.

## Strategy Scoring vs Execution Safety

| Strategy / alpha layer | Execution policy |
|------------------------|------------------|
| Decides *what* to do (size, side, price, timing) | Decides *whether* it is safe to execute |
| May use scores, confidence, regime | No scoring; only pass/fail and explicit reasons |
| Output: recommendations, signals | Output: allow/block + blockingReasons + snapshot |

The execution policy does not replace guardrails or risk limits; it runs **in addition** to them and adds a single, auditable checkpoint before submission.

## Check Categories

The evaluator runs six categories of checks. Each category returns `pass`/`blockReason`; any block leads to `allow: false`.

### A. Freshness

- **Market data freshness** – recent market feed data (not just heartbeat).
- **User/portfolio truth freshness** – recent user feed data.
- **Reconciliation freshness** – reconciliation recently succeeded.
- **Decision snapshot freshness** – if a decision snapshot timestamp is provided, it must be within `decisionSnapshotMaxAgeMs` (default 5 min).
- **Runtime phase** – `rebuilding`, `reconciling`, or `starting` blocks (runtime not ready).

Missing or stale critical freshness → block.

### B. Exposure / concentration

- **Total gross exposure** vs `maxTotalExposure`.
- **Per-asset notional** vs `maxNotionalPerAsset`.
- **Working order count** vs `maxConcurrentWorkingOrders`.

Breach of any configured limit → block.

### C. Liquidity / tradability

- **Market stale / degraded** – from asset live state health.
- **Not tradable** – `isTradable === false`.
- **Liquidity quality score** below minimum.
- **Spread** below minimum (when data available).

### D. Pricing / order sanity

- **Invalid side** – must be BUY or SELL.
- **Invalid size** – must be a finite positive number.
- **Invalid price** – must be finite; must be within `priceBand` (default 0–1 for probability markets).
- **Zero / negative / NaN** – rejected explicitly.

### E. Operational safety

- **Kill switch active** – global or asset halt.
- **Runtime degraded** – runtime status is degraded.
- **Reconciliation drift** – reconciliation not fresh or failed.
- **Exchange truth unavailable** – no recent exchange orders/fills truth.
- **Execution frozen for asset** – asset in failure containment.
- **Missing credentials** (when required).
- **Missing market/asset resolution** (when required).

### F. Recommendation quality

- **Recommendation blocked** – `recommendation.blocked === true`.
- **Blocked reason present** – `blockedReason` set (e.g. from strategy or approval flow).
- **Stale decision snapshot** – decision snapshot older than max age.
- **Not in executable state** – `recommendation.executable === false`.

When the input includes recommendation/decision data, failures here block.

## Block vs Warn

- **Block:** Any category returns `pass: false`. The order must **not** be submitted. `blockingReasons` list every reason; `allow` is false; `policyState` is `block`.
- **Warn:** All categories pass but the evaluator or caller adds non-blocking issues to `warnings`. `allow` remains true; `policyState` is `warn`. Used for operator visibility (e.g. soft freshness).
- **Allow:** All categories pass and no warnings. `policyState` is `allow`.

No hidden weighting: every block reason is explicit in `blockingReasons`.

## Current Runtime Integration

- **Call site:** `worker/stream-runtime.ts`, in the `order.intent.created` subscriber, **after** guardrails allow and **before** building the in-memory `OrderIntent` and calling `orderManager.reconcileIntents([intent])`.
- **Inputs:** Built from the same data used for guardrails: payload (order params), context (asset live state, position), risk state (exposure, limits, kill switch), freshness (market/user/reconcile, runtime phase), and operational (containment, exchange truth).
- **On block:** Intent is not submitted; a structured log is emitted (`Intent blocked by execution policy` with `blockingReasons`, `assetId`, `intentId`).
- **On allow:** Log `Execution policy allow`; append a lifecycle journal event `EXECUTION_POLICY_PASSED` with `payloadJson` = policy snapshot; then build intent and call `reconcileIntents`.

The snapshot is persisted in the order lifecycle journal (`execution_policy_passed` event). When OrderIntents are later created in the execution ledger, the same snapshot can be stored in `OrderIntent.executionPolicySnapshotJson`.

## Paths That Still Bypass the Gate

- **Manual / API order submission** that does not go through the `order.intent.created` → guardrails → execution policy → `reconcileIntents` path. Any such path should be identified and, when ready, wired through the same execution policy.
- **Reconciliation repair recommendations** (e.g. place/cancel from reconciliation) are today applied by the order manager; if they are ever fed as “intents” from a different code path, that path should also pass through the execution policy.
- **Rebuild-imported orders** and **repair-applied** flows do not re-evaluate the policy; they restore existing state.

See `audit-dumps/execution-policy-wiring-map.md` for the exact call site, inputs, persisted fields, and remaining bypasses.
