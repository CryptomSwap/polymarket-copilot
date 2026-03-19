# Shadow-Mode Telemetry

## Purpose

Shadow-mode telemetry records **every trade candidate** (blocked or allowed) at decision time so the system can later evaluate decision quality, policy calibration, and execution assumptions **without placing real trades**. It answers:

- What would the bot have tried to do?
- What got blocked and why?
- Were blocked trades actually bad (missed opportunity) or good (avoided loss)?
- Were allowed trades favorable or unfavorable in hindsight?

This is **distinct from the execution ledger**: the ledger records durable order intents and executed orders (lifecycle). Shadow telemetry records **candidates** at the moment they become “serious” (including those that never create an intent or are blocked by policy).

## What Gets Recorded

Each **ShadowCandidate** row captures at minimum:

| Field | Description |
|-------|-------------|
| funderAddress | Funder for the candidate. |
| recommendationId | Optional; set when candidate comes from a recommendation. |
| orderIntentId | Optional; set when an OrderIntent was created (e.g. before policy block or when allowed). |
| assetId, marketId | Asset and market. |
| side, intendedPrice, intendedSize | Order parameters. |
| candidateSource | e.g. `runtime_automated` or `api`. |
| decisionSnapshotJson | Optional; decision context at decision time. |
| executionPolicySnapshotJson | Optional; execution policy result snapshot when policy was evaluated. |
| executionQualitySnapshotJson | Optional; execution quality (spread/depth/slippage) snapshot. |
| portfolioRiskSnapshotJson, runtimeSafetySnapshotJson | Optional; risk/safety context. |
| wasBlocked | True if the candidate was blocked (guardrails or execution policy). |
| blockingReasons | JSON array of reason codes (e.g. guardrail verdict codes, policy blocking reasons). |
| wasSubmitted | True if the order was submitted to the order manager (paper). |
| wasFilled | Optional; set later if fill status is known. |
| createdAt | When the candidate was recorded. |

Post-trade evaluation (separate process) fills:

- **evaluatedAt**, **markout1h** / **markout6h** / **markout24h**, **outcomeClassification** (good_block, bad_block, good_allow, bad_allow), **evaluationNotes**.

## At Which Runtime Points

1. **Guardrail block** (before any OrderIntent is created): when guardrails reject the proposed action, a shadow row is written with `wasBlocked: true`, `blockingReasons` from guardrail verdict/reason codes, no `orderIntentId`.
2. **Execution policy block** (after OrderIntent is created): when execution policy denies, a shadow row is written with `orderIntentId`, `wasBlocked: true`, `blockingReasons` from policy, and policy/execution-quality snapshots.
3. **Execution policy allow**: when policy allows, a shadow row is written with `orderIntentId`, `wasBlocked: false`, `wasSubmitted: true`, and policy/execution-quality snapshots.

All three happen in the **order.intent.created** handler in the stream runtime (worker). Recording is fire-and-forget (async, non-blocking) so the hot path is not blocked.

## Blocked vs Allowed Semantics

- **Blocked**: the candidate did **not** reach the order manager for submission. Either guardrails blocked before intent creation, or execution policy blocked after intent creation. `wasSubmitted` is false.
- **Allowed**: the candidate passed guardrails and execution policy and was handed to the order manager (`reconcileIntents`). `wasSubmitted` is true. Paper submission and fill state are tracked separately (execution ledger); shadow telemetry does not require immediate fill status.

## How This Differs From the Execution Ledger

| Aspect | Execution ledger | Shadow telemetry |
|--------|------------------|------------------|
| Scope | Order intents that are created and their executed orders/events. | Every candidate (including guardrail-blocked with no intent). |
| Purpose | Authoritative lifecycle and audit for intents/orders/fills. | Post-trade evaluation and calibration. |
| When written | When intents are created and when orders/fills/events occur. | At decision time (guardrail block, policy block, or policy allow). |
| Blocked candidates | Only “created then blocked” intents appear (with events). Guardrail-blocked never create an intent. | All blocked and allowed candidates appear. |

Shadow telemetry **complements** the ledger: it ensures we have a row for every “would have traded” decision, including those that never created an intent.
