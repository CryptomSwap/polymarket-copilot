# Paper Trading – Architecture & Deliverables

## Architecture summary

Paper trading runs **live** but **never submits real orders**. It uses the same shadow model and feature pipeline as the offline backtest (target `labelGoodDecision12h`, threshold 0.3).

1. **Candidate source**  
   Candidates come from **recommendations + decision snapshots** (same as bot dry-run): allowed policy states only (e.g. `ALLOW_SMALL`, `ALLOW_NORMAL`), with `assetId` resolved via `SyncedAsset` (marketId + outcome).

2. **Scoring**  
   For each candidate we build a `ShadowScoreInput` (policy, size, execution/quality/portfolio defaults), call `scoreShadowCandidate()`, and get a probability from the active/approved shadow model (`logistic_regression_shadow`).

3. **Open**  
   When `score >= threshold` (default 0.3) and there is **no open or recently closed** paper trade for that asset (cooldown, default 12h), we create a `PaperTrade` row with status `open`, recording `entryPrice`, `entryTime`, `side`, `score`, `threshold`, `modelRunId`, etc. No exchange order is placed.

4. **Close**  
   A separate job finds open paper trades with `entryTime + 12h <= now`, fetches the 12h price from `MarketPriceSnapshot`, computes markout with the same `markout(side, price0, price12h)` logic as offline evaluation, and updates the row: `status=closed`, `exitPrice`, `exitTime`, `markout12h`, `pnlPct`.

5. **Isolation**  
   Real order paths (`placeLimitOrder`, execution policy, live adapter) are unchanged. Paper trading only reads recommendations/decision/markets and writes `PaperTrade`; it does not touch `OrderIntent`, `ExecutedOrder`, or the CLOB.

---

## Files changed / added

| Path | Description |
|------|-------------|
| `prisma/schema.prisma` | Added `PaperTrade` model. |
| `prisma/migrations/20260316000000_add_paper_trade/migration.sql` | Migration for `PaperTrade` table and indexes. |
| `lib/paper-trading/config.ts` | Config: `PAPER_TRADING_ENABLED`, `PAPER_TRADING_THRESHOLD`, `PAPER_TRADING_COOLDOWN_HOURS`. |
| `lib/paper-trading/candidates.ts` | Builds paper candidates from recommendations + decision snapshots and `ShadowScoreInput`. |
| `lib/paper-trading/engine.ts` | `runPaperTradingTick()` (score + open), `closePaperTradesAt12h()` (markout + close). |
| `lib/paper-trading/index.ts` | Re-exports config, engine, candidates. |
| `app/api/paper-trading/summary/route.ts` | GET summary stats (total, open, closed, win rate, avg/cumulative PnL, threshold, modelRunId). |
| `app/api/paper-trading/trades/route.ts` | GET recent trades (query: limit, status, modelRunId, from, to). |
| `app/api/paper-trading/open/route.ts` | GET open paper trades. |
| `app/api/paper-trading/equity/route.ts` | GET equity curve (cumulative PnL % over time). |
| `app/api/paper-trading/diagnostics/route.ts` | GET diagnostics (enabled, last scoring, threshold, target label). |
| `app/api/paper-trading/tick/route.ts` | POST run one paper-trading tick (score candidates, open if ≥ threshold). |
| `app/api/paper-trading/close-due/route.ts` | POST close paper trades past 12h horizon. |
| `app/(dashboard)/paper-trading/page.tsx` | Dashboard UI: cards, equity chart, open/closed tables, filters, diagnostics, tick/close-due buttons. |
| `components/dashboard/dashboard-shell.tsx` | Added title for `/paper-trading`. |
| `components/dashboard/sidebar.tsx` | Added “Paper trading” nav item and `LineChart` icon. |
| `.env.example` | Commented `PAPER_TRADING_*` env vars. |
| `docs/PAPER_TRADING.md` | This file. |

---

## Activating the shadow model

Paper trading (and shadow scoring) need an **ACTIVE** or **APPROVED** shadow model. If you see *"No ACTIVE or APPROVED shadow model"*:

1. **Where status is read from**  
   `getActiveOrApprovedShadowModel()` in `lib/ml/shadow-score/score-live.ts` loads from the **`MlModelRun`** table: `modelType = "logistic_regression_shadow"` and `status IN ('ACTIVE', 'APPROVED')`, ordered by `updatedAt` desc.

2. **How a run gets ACTIVE or APPROVED**  
   - **ACTIVE:** `POST /api/ml/activate-run` with body `{ "runId": "<id>" }`. This sets that run to ACTIVE and demotes any other ACTIVE run of the same `modelType` to VALIDATED (only one ACTIVE shadow at a time).  
   - **APPROVED:** `POST /api/ml/approve-run` with body `{ "runId": "<id>" }` sets the run to APPROVED (no demotion).

3. **Exact command to activate the latest trained shadow model** (no need to look up the run id):
   ```bash
   curl -X POST http://localhost:3000/api/ml/activate-latest-shadow
   ```
   This finds the latest shadow run (by `updatedAt`) and activates it. If no shadow run exists, the response tells you to train first.

4. **Activate a specific run by id** (e.g. from dashboard or `GET /api/ml/runs`):
   ```bash
   curl -X POST http://localhost:3000/api/ml/activate-run -H "Content-Type: application/json" -d "{\"runId\":\"YOUR_RUN_ID\"}"
   ```

5. **Train a shadow model first** (if you have none):
   ```bash
   npm run train:shadow-model -- --target=labelGoodDecision12h
   ```
   Then activate it with the command in step 3.

---

## Decision snapshots (why "filtering_removed_all_no_decision_snapshot")

Paper trading candidates require **recommendations + decision snapshots**. If diagnostics show `filtering_removed_all_no_decision_snapshot`, recommendations exist but none have a `DecisionPolicySnapshot`, so no candidates reach the shadow model.

### 1. Where decision snapshots are generated

- **Code:** `lib/decision/recompute.ts` → `recomputeDecisions(funderAddress?)`.
- **Behavior:** For a given funder it loads recommendations (where `marketSignal.funderAddress = funder`), builds portfolio risk and setup profiles, then for each recommendation runs the staged decision engine (`evaluateDecisionStaged`) and **upserts** a `DecisionPolicySnapshot` row (one per recommendation per funder). The snapshot stores: `policyState`, `blendedScore`, `sizeMultiplier`, `finalSuggestedSize`, `reasoningJson`. The `reasoningJson` includes an **inputSummary** with: market state (marketId), liquidity/spread (liquidityScore), momentum (momentumScore), portfolio state (themeExposurePct, topThemeConcentrationPct), and time to close (timeToCloseHours from market endDate). So each snapshot is created using market state, liquidity, momentum, time to close, and portfolio state; paper trading can build shadow features from these without the real execution engine.

### 2. Job that creates them

- **Job name:** `decision_recompute` (in `lib/ops/scheduled-jobs.ts`).
- **Interval:** 15 minutes.
- **What it runs:** `recomputeDecisions()` with no argument, so it uses **funder resolution**: connected wallet/creds first, then **any funder that has recommendations** (so it runs even when no wallet is connected, for paper trading).
- **Verify it’s running:** Check worker logs for `Scheduled job started: decision_recompute` and `Scheduled job finished: decision_recompute`. If the worker is not running, snapshots are not created unless you trigger them manually.

### 3. Paper-trading–compatible snapshot generation

- **Funder resolution:** `getFunderForDecisionRecompute()` (used by `recomputeDecisions` when no funder is passed) returns: (1) connected wallet/creds funder, or (2) the funder of any recommendation. So decision recompute (and thus snapshot generation) works for paper trading even when the real execution engine or wallet is not in use.
- **Paper trading tick** uses the same resolution: `getFunderForDecisionRecompute()` in the tick route so the same funder that has recommendations (and can have snapshots) is used to load candidates. Paper trading can therefore build shadow features and run ticks without the real execution engine running.

### 4. Snapshot content (for shadow features)

Each snapshot’s `reasoningJson` includes an **inputSummary** with:

- **market state:** `marketId`
- **liquidity/spread:** `liquidityScore` (from `MarketSignal`)
- **momentum:** `momentumScore` (from `MarketSignal`)
- **portfolio state:** `themeExposurePct`, `topThemeConcentrationPct`, `portfolioState: "derived"`
- **time to close:** `timeToCloseHours` (from `SyncedMarket.endDate`)

Volatility is not currently stored in the snapshot; the staged engine uses liquidity, news, and portfolio for market quality. Shadow feature building uses the snapshot’s `policyState`, `sizeMultiplier`, `finalSuggestedSize` and recommendation/market data; it does not depend on the live execution path.

### 5. Manual command / endpoint for testing

- **Endpoint:** `POST /api/paper-trading/ensure-decision-snapshots`
- **Body (optional):** `{ "funderAddress": "0x..." }` to force a funder; otherwise the same funder resolution as above is used.
- **Example:**
  ```bash
  curl -X POST http://localhost:3000/api/paper-trading/ensure-decision-snapshots
  ```
- **Response:** `{ "success": true, "funderAddress": "...", "snapshotsUpserted": N, "profilesCreated", "profilesUpdated", "errors": [] }`
- **Dashboard:** On the paper trading page, if diagnostics show `filtering_removed_all_no_decision_snapshot`, use the **Generate decision snapshots** button to call this endpoint and then re-run a tick.

---

## Block report (why recommendations are BLOCK)

When paper trading shows **policyStateCounts = BLOCK=400** and **afterPolicyFilter = 0**, the issue is upstream: the staged decision engine is setting **policyState = BLOCK** and **finalSuggestedSize = 0** for every recommendation. That happens when any of the following apply:

1. **Eligibility:** `blockedReason`, `qualityBlocker`, review rejected, or chase setup with low conviction (`lib/decision/stages/eligibility.ts`).
2. **Theme concentration:** `topThemeConcentrationPct >= 50%` (evaluate-staged.ts).
3. **Portfolio fit block:** high theme exposure, high concentration, behavior flags, or portfolio overconcentrated (`lib/decision/stages/portfolio-fit.ts`: TOP_CONC_BLOCK=50, THEME_EXPOSURE_BLOCK=30, BEHAVIOR_PENALTY_BLOCK=0.25, PORTFOLIO_PENALTY_BLOCK=0.3).
4. **Market quality block:** liquidity too low (&lt; 0.15), or OVERCROWDED_THEME signal (`lib/decision/stages/market-quality.ts`).
5. **Low blended score:** no explicit block reason but `blendedScore < 0.5` (or &lt; 0.4) so policy becomes BLOCK.

**Sizing** returns 0 when eligibility is not eligible, or portfolio fit is block, or market quality block (`lib/decision/stages/sizing.ts`), so **finalSuggestedSize = 0** is a consequence of being blocked.

**Inspect block reasons (aggregate):**
```bash
curl -s "http://localhost:3000/api/decision/block-report" | jq '.'
```
Optional: `?funderAddress=0x...` to scope to a funder. Response includes: `byPolicyState`, `byBlockReason`, `byCategory` (eligibility, theme_concentration, portfolio_fit, market_quality, liquidity, low_score, no_trade_watch, unknown), `liquidityRelatedCount`, `riskRelatedCount`, `portfolioThemeConcentrationCount`, `missingOrQualityCount`, `sampleBlocked` (per-snapshot: recommendationId, policyState, finalSuggestedSize, blockReason, blockers, marketQualityReasons, portfolioFitReasons, category).

On the paper trading dashboard, open **"Block report (why recommendations are BLOCK)"** in the diagnostics card to load and view a summary.

**Paper-only relaxation:** The current code does **not** add a paper-only relaxation for BLOCK reasons; the same staged policy runs for both real execution and paper. If the block report shows that most blocks are e.g. theme concentration or liquidity, you can either relax thresholds in the staged engine (affects real execution) or add a separate paper-only path that allows certain BLOCK reasons for scoring only (no real orders). The block report is intended to inform that decision.

---

## Migration

- **Added:** `prisma/migrations/20260316000000_add_paper_trade/migration.sql`  
- **Apply:**  
  - If your DB and shadow DB are in a good state:  
    `npx prisma migrate deploy`  
  - Or create only (if you hit shadow DB issues): the migration file is already present; apply it manually or fix the shadow DB and run `npx prisma migrate dev` again.  
- **Generate client:**  
  `npx prisma generate`

---

## Routes and pages

| Method | Route | Description |
|--------|--------|-------------|
| GET | `/api/paper-trading/summary` | Summary stats (total, open, closed, win rate, avg/cumulative PnL, threshold, modelRunId); supports optional `botType` filter and returns `perBotSummary` keyed by `botType`. |
| GET | `/api/paper-trading/trades?limit=50&status=open|closed&modelRunId=...&from=...&to=...` | Recent paper trades. |
| GET | `/api/paper-trading/open` | Open paper trades only. |
| GET | `/api/paper-trading/equity?points=100&modelRunId=...` | Equity curve (cumulative PnL %). |
| GET | `/api/paper-trading/diagnostics` | Enabled, last scoring time, threshold, active target label, cooldown. |
| POST | `/api/paper-trading/ensure-decision-snapshots` | Generate decision snapshots for all recommendations (paper-trading compatible; use when diagnostics show no_decision_snapshot). |
| POST | `/api/paper-trading/tick` | Run one tick (score + open). |
| POST | `/api/paper-trading/close-due` | Close trades past 12h. |
| GET | `/api/decision/block-report?funderAddress=0x...` | Aggregate report on why snapshots are BLOCK: counts by block reason, category (eligibility, theme_concentration, portfolio_fit, market_quality, liquidity, low_score), and sample rows. Use when all recommendations are BLOCK and paper trading has 0 candidates. |

**Dashboard URL (in-app):**  
`/paper-trading`  
(e.g. `http://localhost:3000/paper-trading` when the app is running.)

---

## Bot profiles (multi-bot paper trading)

Paper trading now supports **multiple paper bots** sharing the same runtime, safety layer, and candidate universe, but with **separate profiles and tagged results**.

- **Profiles module:** `lib/paper-trading/bot-profiles.ts`
  - `BotProfile` type: per-bot overrides for threshold, minScoreBuffer, allowed policy states, review-required behavior, relaxation allowlist, price bands, excluded themes/categories, cooldowns, and risk limits.
  - Built-in profiles:
    - `strict_quality` – conservative, no REVIEW_REQUIRED, no relaxation, avoids longshots/near-certains.
    - `relaxed_edge` – exploratory, includes REVIEW_REQUIRED and relaxed BLOCK candidates with moderate limits.
    - `tail_extremes` – focuses on longshots and near-certains with tighter per-market caps.
  - `getActiveBotProfiles()` selects `enabled` profiles.

- **Per-bot candidates:** `getPaperTradingCandidatesForProfile(profile, funderAddress)` in `lib/paper-trading/candidates.ts`
  - Applies profile-level filters:
    - Allowed policy states and REVIEW_REQUIRED behavior.
    - Paper relaxation allowed/disabled and allowed relaxation reasons.
    - Entry price bands (reusing `lib/paper-trading/price-bands.ts`).
    - Excluded themes and categories.
  - Preserves existing relaxation provenance fields and diagnostics.

- **Per-bot engine semantics:** `runPaperTradingTick` in `lib/paper-trading/engine.ts`
  - Iterates active bot profiles and opens paper trades **per profile**, with:
    - Per-bot risk limits and cooldowns (cooldowns and counts are scoped by `botType`).
    - Dedupe key includes `botType`, so one bot does not suppress another bot’s experiment.
  - **PaperTrade tagging** (Prisma model):
    - `botType`, `botVersion`, `targetLabel`, and `entryPriceBand` (shared price-band helper).
  - Tick result includes `perBotResults` for diagnostics; legacy top-level fields remain.

- **APIs:**
  - `GET /api/paper-trading/summary`
    - Optional `botType` query param.
    - Response includes `perBotSummary` keyed by `botType` while preserving existing aggregates.
  - `GET /api/paper-trading/diagnostics`
    - Response includes `lastTickPerBotSummary` (per-bot opened/skipped/candidate counts, score stats, cooldown/risk-limit rejections, relaxation counts).

- **Reporting tool:** `tools/create-paper-bot-profile-report.ts`
  - `npx tsx tools/create-paper-bot-profile-report.ts`
  - Writes `dump/paper-bot-profile-report.json` and `.md` with:
    - Global paper config snapshot.
    - All configured profiles (effective thresholds/limits, relaxation settings, filters).
    - Latest per-bot open/closed/total counts from `PaperTrade`.

## Commands to run

1. **Install (if needed)**  
   `npm install`

2. **Database**  
   - Apply migration:  
     `npx prisma migrate deploy`  
   - Regenerate client:  
     `npx prisma generate`

3. **Dev server**  
   `npm run dev`

4. **Paper trading loop (optional)**  
   - **Tick** (e.g. every 5–15 min):  
     `curl -X POST http://localhost:3000/api/paper-trading/tick`  
   - **Close due** (e.g. hourly):  
     `curl -X POST http://localhost:3000/api/paper-trading/close-due`  
   Or call these from a cron/scheduler; the dashboard also has “Run tick” and “Close due (12h)” buttons.

---

## Env / config flags

| Env var | Default | Description |
|---------|---------|-------------|
| `PAPER_TRADING_ENABLED` | `1` (enabled) | Set to `0` or `false` to disable opening new paper trades (tick no-ops for open). |
| `PAPER_TRADING_THRESHOLD` | `0.3` | Minimum shadow score to open a paper trade. |
| `PAPER_TRADING_COOLDOWN_HOURS` | `12` | No new open for same asset within this many hours after an open or a close. |

No other env vars are required for paper trading. Real order placement remains gated by existing runtime/execution policy (unchanged).

---

## Safety and correctness

- **Logging:** Open and close events are logged in the engine (`console.log` for open/close with id and key fields).
- **Idempotency:** Cooldown prevents duplicate opens for the same asset; close-due only updates trades that are still `open` and past 12h.
- **No real orders:** No code path in paper trading calls the exchange or `placeLimitOrder`; only `PaperTrade` and Prisma are written to.
- **Missing model:** If no ACTIVE/APPROVED shadow model exists, the tick returns `opened: 0` and an error message; the dashboard diagnostics show model/status so operators can see when the model is missing.

---

## Hardening (risk controls, dedupe, scheduling, diagnostics)

### Architecture summary (hardened)

- **Risk limits:** All configurable via env: max open total, max open per market/theme/category, max daily new trades, min score buffer above threshold, cooldown by asset (existing) and optional cooldown by market. Engine enforces before creating any paper trade.
- **Duplicate suppression:** Deterministic `dedupeKey` = `modelRunId|assetId|side|timeBucket` with `timeBucket` = floor(nowMs / cooldownWindowMs). Persisted on `PaperTrade` with unique constraint; create fails gracefully on duplicate (skipped). Same opportunity in the same cooldown window cannot create a second trade.
- **Scheduling:** `paper_trading_tick` and `paper_trading_close_due` added to scheduled jobs (e.g. worker); tick every 5 min, close-due every 1 h. Manual POST to `/api/paper-trading/tick` and `/api/paper-trading/close-due` still available. Last successful open tick time and last close tick time (and last result/error) stored in `PaperTradingState` and exposed in diagnostics.
- **Diagnostics:** Diagnostics API and dashboard show: enabled, threshold, all cooldowns and risk limits, last open/close tick at, last tick result/error, model run, target label, trade open rate in last 24h, close rate in last 24h.
- **Dashboard:** Date range and model run filter applied to summary, trades, and equity; average score of opened trades, average hold time for closed, pnl distribution (win/loss counts and buckets), win/loss counts; threshold and model run shown where relevant.
- **Safety:** No real orders; if no model or scoring fails, state is recorded in diagnostics and tick result; engine never touches real execution paths.

### Files changed (hardening)

| Path | Description |
|------|-------------|
| `prisma/schema.prisma` | `PaperTrade`: added `dedupeKey` (unique), `theme`, `category`. Added `PaperTradingState` model. |
| `prisma/migrations/20260316120000_paper_trading_harden/migration.sql` | Migration for new columns and `PaperTradingState` table. |
| `lib/paper-trading/config.ts` | Risk limits and new env vars (see below). |
| `lib/paper-trading/candidates.ts` | Added `theme`, `category` to candidate from `marketSignal`. |
| `lib/paper-trading/engine.ts` | Dedupe key build and unique check; risk limit checks; persist open/close tick state; theme/category on create. |
| `lib/ops/scheduled-jobs.ts` | Added `paper_trading_tick`, `paper_trading_close_due` jobs and intervals; executeJob cases. |
| `app/api/paper-trading/summary/route.ts` | Query params: from, to, modelRunId; response: averageScoreOfOpened, averageHoldTimeHours, pnlDistribution, winCount, lossCount. |
| `app/api/paper-trading/diagnostics/route.ts` | Full diagnostics: all config, last open/close tick at and result/error, tradeOpenRate24h, closeRate24h. |
| `app/api/paper-trading/trades/route.ts` | Response includes theme, category. |
| `app/api/paper-trading/equity/route.ts` | Query params: from, to (applied to exitTime). |
| `app/api/paper-trading/open/route.ts` | Response includes theme, category. |
| `app/(dashboard)/paper-trading/page.tsx` | Date range filter; model run and threshold everywhere; avg score, avg hold time, win/loss cards; pnl distribution card; expanded diagnostics. |
| `.env.example` | New paper trading env vars (see below). |
| `docs/PAPER_TRADING.md` | This hardening section. |

### Env vars added (hardening)

| Env var | Default | Description |
|---------|---------|-------------|
| `PAPER_TRADING_COOLDOWN_MARKET_HOURS` | `0` | Cooldown by market (no new open for same market within this many hours). 0 = disabled. |
| `PAPER_TRADING_MIN_SCORE_BUFFER` | `0` | Require score >= threshold + this value to open (e.g. 0.05). |
| `PAPER_TRADING_MAX_OPEN_TOTAL` | `0` | Max open paper trades globally. 0 = no limit. |
| `PAPER_TRADING_MAX_OPEN_PER_MARKET` | `0` | Max open per market. 0 = no limit. |
| `PAPER_TRADING_MAX_OPEN_PER_THEME` | `0` | Max open per theme. 0 = no limit. |
| `PAPER_TRADING_MAX_OPEN_PER_CATEGORY` | `0` | Max open per category. 0 = no limit. |
| `PAPER_TRADING_MAX_DAILY_NEW_TRADES` | `0` | Max new paper trades opened per calendar day. 0 = no limit. |

### Run commands (unchanged + scheduling)

- Apply new migration: `npx prisma migrate deploy`
- Generate client: `npx prisma generate`
- Run worker (to run scheduled paper tick / close-due): `npm run worker` (or your worker entry that uses `runScheduledJob("paper_trading_tick")` / `paper_trading_close_due`).
- Manual tick: `curl -X POST http://localhost:3000/api/paper-trading/tick`
- Manual close-due: `curl -X POST http://localhost:3000/api/paper-trading/close-due`

### Test steps: duplicate prevention and risk limits

1. **Duplicate prevention (dedupe key)**  
   - Run tick twice within the same cooldown window (e.g. within 1 minute) with the same candidate (same asset/side/model).  
   - Expected: First tick opens one paper trade; second tick opens zero (same dedupeKey already exists; unique constraint).  
   - Optional: Set `PAPER_TRADING_COOLDOWN_HOURS=0` and run tick multiple times in quick succession; only one trade per (modelRunId, assetId, side, timeBucket) should exist (bucket is 1h when cooldown=0 due to minimum bucket).

2. **Max open total**  
   - Set `PAPER_TRADING_MAX_OPEN_TOTAL=2`. Run tick until at least 2 open trades exist.  
   - Run tick again with more candidates. Expected: No new opens once open count is 2.

3. **Max open per market**  
   - Set `PAPER_TRADING_MAX_OPEN_PER_MARKET=1`. Have two candidates in the same market.  
   - Run tick. Expected: At most one open trade per market.

4. **Max daily new trades**  
   - Set `PAPER_TRADING_MAX_DAILY_NEW_TRADES=1`. Run tick twice on the same day.  
   - Expected: First tick opens one trade; second opens zero (daily limit reached).

5. **Min score buffer**  
   - Set `PAPER_TRADING_THRESHOLD=0.3` and `PAPER_TRADING_MIN_SCORE_BUFFER=0.1`.  
   - Run tick. Expected: Only candidates with score >= 0.4 open; score in [0.3, 0.4) are skipped.

6. **No model / scoring failure**  
   - Deactivate or remove the shadow model (or use a DB with no ACTIVE/APPROVED shadow run).  
   - Run tick. Expected: Response and diagnostics show error (no model); no paper trades created; no real orders.  
   - Check diagnostics: `lastOpenTickError` and last tick result should reflect the failure.
