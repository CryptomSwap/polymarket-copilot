# Bot Architecture v1 — Constrained, Policy-Driven (No Live Execution)

**Goal:** A bot layer that can eventually act on recommendation engine outputs safely. **v1 is suggest-only / dry-run only; no live auto-trading.**

---

## 1. Current architecture (grounding)

- **Recommendation engine v2** (`lib/polymarket/recommendations.ts`): Signals → actions (STRONG_BUY, BUY_SMALL, WATCH, NO_TRADE, TRIM, EXIT) and `primaryActionType` (add, review_existing, trim, hedge, avoid, monitor, sync_first). Portfolio-aware.
- **Decision layer** (`lib/decision/policy.ts`, `recompute.ts`): Blended score + policy → `DecisionPolicySnapshot` (policyState, sizeMultiplier, finalSuggestedSize). States: BLOCK, REVIEW_REQUIRED, ALLOW_SMALL, ALLOW_NORMAL, ALLOW_HIGH_CONVICTION, TRIM, EXIT.
- **Order flow:** Manual only. `POST /api/orders/place` → `buildOrderPreview` → `runPreflightChecks` → `placeLimitOrder` (requires `POLYMARKET_SIGNER_PRIVATE_KEY`). OrderIntent + ExecutedOrder persisted.
- **Portfolio intelligence** (`lib/portfolio/intelligence.ts`): Summary (resolved/unresolved/stale/near-resolution counts), buckets (by theme/category), flags.
- **Preflight** (`lib/polymarket/preflight.ts`): Market/asset, tick size, market active. No geoblock/allowance yet.

---

## 2. Bot policy layer (where it sits)

```
Recommendations (v2)  →  Decision (policy + snapshot)  →  [BOT LAYER]  →  (future: executor)  →  placeLimitOrder
                                                              ↑
                                                    Guardrails + dry-run
                                                    No execution in v1
```

The bot layer:

1. **Consumes** recommendation + decision snapshot (and optionally portfolio intelligence, preflight).
2. **Produces** a list of *candidates* (would-be orders) with an *execution key* each.
3. **Runs guardrails** per candidate; returns allowed/blocked + reason.
4. **v1:** Output is dry-run only (API returns result; no call to `placeLimitOrder`).
5. **Future:** An executor could take dry-run output and, if enabled and within policy, call place with idempotency (e.g. dedupe by execution key).

---

## 3. Suggested modules / files

| Path | Purpose |
|------|--------|
| `lib/bot/types.ts` | BotMode, BotGuardrailConfig, BotCandidate, GuardrailResult, DryRunResult, executionKey(). |
| `lib/bot/guardrails.ts` | checkGuardrails(funder, candidate, config) → GuardrailResult. All 6 guardrails. |
| `lib/bot/dry-run.ts` | runDryRun(funder, config?) → DryRunResult. Build candidates from recs + decision, run guardrails. |
| `app/api/bot/dry-run/route.ts` | GET /api/bot/dry-run. Returns dry-run result. |
| `docs/TRADING_GUARDRAILS.md` | Human-readable guardrail list and “no live execution” statement. |
| `docs/BOT_ARCHITECTURE_V1.md` | This document. |

**Not added (intentionally):**

- No executor module (no code that calls `placeLimitOrder` from the bot).
- No cron or worker that places orders.
- No schema change required for v1 (config is in-code default; future: optional `TradingPolicyConfig` or env).

---

## 4. Bot decision flow (v1)

1. **Funder** from `getFunderForRecompute()`.
2. **Load recommendations** for funder with `decisionSnapshots` (funder-scoped).
3. **Filter to candidates:**  
   - Has decision snapshot.  
   - `policyState` ∈ { ALLOW_SMALL, ALLOW_NORMAL, ALLOW_HIGH_CONVICTION, TRIM, EXIT }.  
   - Skip `primaryActionType` avoid / sync_first.  
   - Resolve asset from marketId + outcome.  
   - For BUY, skip if `finalSuggestedSize` ≤ 0.
4. **Build BotCandidate** per row: recommendationId, marketId, assetId, outcome, side, limitPrice (e.g. marketPrice), size (finalSuggestedSize), policyState, marketTitle, marketTheme.
5. **For each candidate:** run `checkGuardrails(funder, candidate, config)`.
6. **Return DryRunResult:** mode, funderAddress, at, config, candidates (candidate + executionKey + guardrail), summary (total, allowed, blocked).

---

## 5. Guardrails (detailed)

| # | Guardrail | Implementation |
|---|-----------|----------------|
| 1 | Never trade unresolved catalog markets | Market and asset must exist in SyncedMarket / SyncedAsset. |
| 2 | Never trade on stale sync | Portfolio intelligence: block if stalePositions > 0 (and optionally blockUnresolvedCatalog). |
| 3 | Never exceed per-market cap | buildOrderPreview → concentrationImpact.postTopPct vs config.perMarketCapPct (default 50%). |
| 4 | Never exceed per-theme cap | concentrationImpact.postThemePct vs config.perThemeCapPct (default 50%). |
| 5 | Never add near resolution unless allowed | For BUY/add: market.endDate within nearResolutionBlockHours (72); block unless allowNearResolutionAdd. |
| 6 | Never duplicate strongly overlapping thesis | For BUY/add: theme exposure from PI buckets ≥ duplicateThesisThemeCapPct (40%) → block. |
| 7 | Idempotent execution keys | executionKey(candidate) = recommendationId:assetId:side:size:limitPrice. Future executor must dedupe. |

---

## 6. Dry-run output shape

```ts
interface DryRunResult {
  mode: "dry_run";
  funderAddress: string;
  at: string; // ISO
  config: BotGuardrailConfig;
  candidates: Array<{
    candidate: BotCandidate;
    executionKey: string;
    guardrail: GuardrailResult; // { allowed, reason, failures }
  }>;
  summary: { total: number; allowed: number; blocked: number };
}
```

`BotCandidate`: recommendationId, marketId, assetId, outcome, side, limitPrice, size, primaryActionType, policyState, finalSuggestedSize, marketTitle, marketTheme.

`GuardrailResult`: allowed (boolean), reason (string), failures (string[]).

---

## 7. APIs

| Method | Path | Purpose |
|--------|------|--------|
| GET | /api/bot/dry-run | Returns DryRunResult. No body. No orders placed. |

**No** POST that places orders from the bot. Order placement stays in `POST /api/orders/place` with explicit payload (manual or future, separate enable).

---

## 8. Schema additions (optional, future)

For a future “bot config” or policy knobs in DB:

- **TradingPolicyConfig** (or key-value): e.g. `dryRunOnly`, `perMarketCapPct`, `perThemeCapPct`, `allowNearResolutionAdd`, `maxDailyTrades`.  
- v1 uses in-code defaults only; no migration required.

---

## 9. Path to safe automation (later)

1. **Keep dry-run** as the default; all “bot” APIs return what *would* happen.
2. **Add an explicit “execute” switch** (e.g. env `BOT_EXECUTION_ENABLED=false` or DB flag) that is off by default.
3. **Executor module** (when added):  
   - Reads dry-run result (or recomputes same pipeline).  
   - Filters to `guardrail.allowed`.  
   - Optionally applies extra limits (e.g. max N per day).  
   - For each candidate, checks idempotency (e.g. no recent order with same executionKey).  
   - Only then calls existing `placeLimitOrder` path (or a wrapper that logs and then calls it).
4. **Audit:** Persist every bot decision (candidate + guardrail + execution key); optionally persist “would place” even in dry-run for audit trail.

This architecture keeps the project on a clear path to safe automation while ensuring **no live execution is enabled in v1**.
