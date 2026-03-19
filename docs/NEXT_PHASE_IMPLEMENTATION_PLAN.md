# Polymarket Copilot — Next Phase Implementation Plan

**Project root:** `C:\Users\User\Polymarket\polymarket-copilot`  
**Current state:** Canonical position resolution ✓ | Held-market backfill ✓ | Portfolio Intelligence v1 ✓ | Recommendation Engine v2 ✓ | Action-first, portfolio-aware recommendations UI ✓  

**Goals:** Implement in order: (1) Alert Engine, (2) Recommendation diagnostics/explainability, (3) Portfolio timeline, (4) Position thesis tracking, (5) Recommendation summary strip, then prepare for a constrained, policy-driven automatic trade bot with strong trust, diagnostics, and guardrails.

---

## Principles

- **Surgical and additive:** New modules and routes; minimal changes to existing engines.
- **Reuse:** Portfolio Intelligence, Recommendation Engine, resolution, and backfill stay as sources of truth.
- **Deterministic, explainable rules:** Prefer rule-based logic with clear reasons over black-box scoring.
- **No live automated trading yet:** Build diagnostics, policies, and guardrails first; bot is “prep” only.

---

## Phase 1: Alert Engine

### Objective

Centralize and extend alerts beyond current **DriftAlert** (order/position sync mismatches). Add a dedicated **Alert Engine** that can emit portfolio-, recommendation-, and market-condition alerts from existing intelligence, with deterministic rules and a single feed for the UI.

### Current state

- **DriftAlert** in `prisma/schema.prisma`; created in `lib/live/drift.ts` (order/position/websocket drift).
- **GET /api/live/alerts** and **POST /api/live/alerts/resolve**; portfolio page and ops page consume drift alerts.

### Implementation plan

1. **Introduce an Alert Engine (lib layer)**  
   - New: `lib/alerts/engine.ts`.  
   - Inputs: funder, optional fresh `getPortfolioIntelligence()`, optional top recommendations, optional market/position context.  
   - Output: list of **alert items** (type, severity, title, message, entity refs, optional `driftAlertId` if from existing DriftAlert).  
   - Rules (deterministic):  
     - Map existing DriftAlerts (unresolved) to engine alert format.  
     - From Portfolio Intelligence: HIGH_CONCENTRATION, NEAR_RESOLUTION_CLUSTER, STALE_SYNC_CLUSTER, UNRESOLVED_CATALOG_POSITIONS, LARGE_LOSS, LARGE_GAIN → one alert per flag (or one summary alert for cluster types).  
     - Optional: “Recommendation quality blocker” (e.g. sync_first) when intelligence has unresolved/stale and user has open recommendations.  
   - No new persistence for “engine” alerts; they are computed. Persisted alerts remain DriftAlert; engine can attach `driftAlertId` when the item comes from DriftAlert.

2. **Schema**  
   - **No new tables.** Optionally add `source` to `DriftAlert` (e.g. `"drift" | "engine"`) in a later iteration if you want to persist engine-generated alerts (for now, engine = computed only).

3. **API**  
   - **New: GET /api/alerts/feed** (or **GET /api/alerts**).  
   - Query: `?resolved=false&limit=50&source=all` (source: `all | drift | engine`).  
   - Behavior:  
     - If `source=drift` or `all`: fetch DriftAlerts (existing logic).  
     - If `source=engine` or `all`: call Alert Engine, merge with drift (by id/dedup).  
   - Response: `{ alerts: AlertFeedItem[], driftOnly?: boolean }`.  
   - **Existing:** Keep **GET /api/live/alerts** and **POST /api/live/alerts/resolve** unchanged for backward compatibility.

4. **UI**  
   - **Portfolio page** (`app/(dashboard)/portfolio/page.tsx`): Option to fetch `/api/alerts/feed` instead of or in addition to `/api/live/alerts`; render engine alerts (e.g. “High concentration”, “Stale sync”) with same card/section.  
   - **Ops page** (`app/(dashboard)/ops/page.tsx`): Add engine alerts to the same list or a second section.  
   - **Dashboard home**: Optional small “Alerts” strip (e.g. count + link to portfolio/ops) using feed.

### Files to add

| File | Purpose |
|------|--------|
| `lib/alerts/engine.ts` | Alert Engine: rules, merge with drift, return feed items |
| `lib/alerts/types.ts` | Types: AlertFeedItem, AlertType, AlertSeverity, entity refs |
| `app/api/alerts/feed/route.ts` | GET feed (drift + engine) |

### Files to change

| File | Change |
|------|--------|
| `app/(dashboard)/portfolio/page.tsx` | Fetch feed (or keep live/alerts and add engine feed), render engine alerts |
| `app/(dashboard)/ops/page.tsx` | Include engine alerts in list |
| Optional: `components/dashboard/header.tsx` or dashboard home | Alert count + link |

### Acceptance criteria (Phase 1) — Implemented

- [x] Alert Engine returns a list of alert items (drift + portfolio-intelligence–based) for a funder.
- [x] GET /api/alerts/feed returns merged alerts (drift + engine); existing /api/live/alerts still works.
- [x] Portfolio and Ops pages show both drift and engine alerts with clear labels (e.g. “Sync”, “Portfolio”).
- [x] All rules in the engine are documented (e.g. in code comments or a short doc).

**Implementation:** `lib/alerts/types.ts` (feed types), `lib/alerts/engine.ts` (`getAlertFeed()`), `app/api/alerts/feed/route.ts` (GET feed). Engine alerts are computed from portfolio intelligence flags (HIGH_CONCENTRATION, NEAR_RESOLUTION_CLUSTER, STALE_SYNC_CLUSTER, UNRESOLVED_CATALOG_POSITIONS, LARGE_LOSS, LARGE_GAIN); no new DB tables. Regression: `lib/alerts/__tests__/feed.test.ts` (invoked from portfolio-api-regression-tests).

---

## Phase 2: Recommendation diagnostics / explainability

### Objective

Surface **why** a recommendation got its action and primaryActionType (rationale, portfolio impact, risk/timing, quality blockers) in a structured, explainable way in the UI and API, and add optional “diagnostic blocks” for power users.

### Current state

- **Recommendation engine v2** already produces `rationale`, `portfolioImpact`, `riskNote`, `timingNote`, `qualityBlocker` (in `lib/polymarket/recommendations.ts` and persisted on `Recommendation`).
- **Recommendation detail** (`app/(dashboard)/recommendations/[id]/page.tsx`) shows `recommendationDiagnostics` (isHeld, category/theme exposure %, timeToResolutionDays, nearResolution/stale/unresolved counts) and a “Diagnostics / explainability” collapsible.
- **GET /api/recommendations/[id]** returns `recommendationDiagnostics` and the v2 fields.

### Implementation plan

1. **Structured explanation payload (API + lib)**  
   - In `lib/polymarket/recommendations.ts` (or a small `lib/polymarket/recommendation-explainability.ts`), add a function that, given a RecommendationRowV2 + context (e.g. same context used for v2), returns an **explanation object**:  
     - `primaryActionType`, `rationale`, `portfolioImpact`, `riskNote`, `timingNote`, `qualityBlocker` (already there).  
     - **Blocks:** e.g. `blocks: { edge: string, concentration: string, timing: string, liquidity: string }` — short, deterministic one-liners per dimension.  
   - Keep logic deterministic (same inputs → same blocks). Reuse thresholds from recommendations.ts (e.g. OVERLAP_AVOID_PCT, NEAR_RESOLUTION_DAYS).

2. **API**  
   - **GET /api/recommendations/[id]** already returns diagnostics and v2 fields.  
   - **Add** an optional query: `?explain=1`. When present, compute and return `explanationBlocks` (and optionally a single `explanationSummary` string) in the same response.  
   - Alternatively: **GET /api/recommendations/[id]/explain** that returns only `{ explanationBlocks, explanationSummary, recommendationId }` (callable from detail page without loading full rec).

3. **Schema**  
   - **No DB changes.** Explanation is computed from existing Recommendation + MarketSignal + portfolio intelligence.

4. **UI**  
   - **Recommendation detail page** (`app/(dashboard)/recommendations/[id]/page.tsx`):  
     - In “Diagnostics / explainability”, add a subsection “Why this action” with the v2 fields (rationale, portfolio impact, risk, timing, quality blocker) and, when `explain=1` or from /explain, show **explanation blocks** (e.g. Edge, Concentration, Timing, Liquidity) as small chips or lines.  
   - **Recommendations list** (`app/(dashboard)/recommendations/page.tsx`): Optional tooltip or expandable row with “Rationale” (one line) from `rationale` or `explanationSummary`.

### Files to add

| File | Purpose |
|------|--------|
| `lib/recommendations/explainability.ts` | **Implemented.** Build normalized explanation (summary, drivers, penalties, sizing, quality, review) from persisted rec + signal + evaluation + review. No new tables; read-only. |
| `app/api/recommendations/[id]/explain/route.ts` | **Implemented.** GET returns full explanation payload; 404 if recommendation not found. |

### Files to change

| File | Change |
|------|--------|
| `app/api/recommendations/[id]/route.ts` | Optional `explain=1` or include explanation in response; or add GET /api/recommendations/[id]/explain |
| `app/(dashboard)/recommendations/[id]/page.tsx` | “Why this action” subsection and explanation blocks |
| Optional: `app/(dashboard)/recommendations/page.tsx` | One-line rationale / summary on list |

### Acceptance criteria (Phase 2)

- [x] Explanation blocks (edge, concentration, timing, liquidity) are computed deterministically from rec + context (via `buildRecommendationExplanation` in `lib/recommendations/explainability.ts`).
- [x] Recommendation detail page shows “Why this action” with blocks and existing v2 fields.
- [x] API returns explanation via GET /api/recommendations/[id]/explain (read-only; 404 when not found).

---

## Phase 3: Portfolio timeline

### Objective

Show a **timeline of portfolio state over time** (exposure, PnL, position count, key events) so users can see evolution and correlate with decisions.

### Current state

- **PortfolioSnapshot** exists: totalOpenExposure, totalReservedExposure, realizedPnl, unrealizedPnl, openPositionsCount, openOrdersCount, topThemeConcentrationPct, topMarketConcentrationPct (DB columns; see concentration naming migration), yesExposure, noExposure, createdAt.  
- **recompute** writes one snapshot per run via `persistSnapshot` (`lib/polymarket/analytics.ts`).  
- **GET /api/portfolio/overview** returns the **latest** snapshot only (no history).

### Implementation plan

1. **Schema**  
   - **No change.** `PortfolioSnapshot` already has `createdAt`; use it for timeline.  
   - Ensure recompute (or a scheduled job) writes snapshots at a reasonable frequency (e.g. after each recompute; later, daily or on significant events).

2. **API**  
   - **New: GET /api/portfolio/timeline**  
   - Query: `?funder=...` (or use connected funder), `?from=ISO`, `?to=ISO`, `?limit=100`.  
   - Returns: `{ snapshots: PortfolioSnapshotSummary[], interval?: string }`.  
   - Each item: at least `createdAt`, `totalOpenExposure`, `unrealizedPnl`, `realizedPnl`, `openPositionsCount`, optionally `topThemeConcentrationPct`/`topMarketConcentrationPct` (API and DB columns), `yesExposure`, `noExposure`.  
   - Order: `createdAt` desc.  
   - If few snapshots exist, consider “synthetic” points from DerivedPosition history (optional, later): e.g. from UserFill dates; for MVP use only PortfolioSnapshot.

3. **UI**  
   - **New section on Portfolio page** or **new route** `app/(dashboard)/portfolio/timeline/page.tsx`:  
     - Chart (e.g. line or area): X = time, Y = exposure and/or PnL (unrealized + realized).  
     - Optional: markers for “recompute” or “alert” events (from DriftAlert or Alert Engine) if you add a minimal event log.  
   - Use existing `PortfolioSnapshot`; no new tables.

### Files to add

| File | Purpose |
|------|--------|
| `lib/portfolio/timeline.ts` | **Implemented.** Normalized timeline from DriftAlert, BehaviorFlag, RecommendationLifecycleEvent, RecommendationExecutionOutcome, OrderReconciliationSnapshot, PostTradeJournalEntry, CopilotAlert. limit/since/source. |
| `app/api/portfolio/timeline/route.ts` | **Implemented.** GET limit, since, source. Read-only. |
| `app/(dashboard)/portfolio/timeline/page.tsx` | **Implemented.** Event feed + source filter. |
| `lib/portfolio/__tests__/timeline.test.ts` | **Implemented.** Shape, sort, filter tests. |

### Files to change

| File | Change |
|------|--------|
| `app/(dashboard)/portfolio/page.tsx` | Link to “Portfolio timeline” or embed minimal chart |
| Optional: `lib/polymarket/recompute.ts` or job | Ensure snapshots are written regularly (already done on recompute) |

### Acceptance criteria (Phase 3)

- [x] GET /api/portfolio/timeline returns event feed for funder (limit, since, source).
- [x] Portfolio timeline view shows chronological event feed with source filter.
- [x] No new DB tables; uses existing persistence (DriftAlert, BehaviorFlag, etc.).

---

## Phase 4: Position thesis tracking

### Objective

Let users attach a **thesis** (and optionally invalidation conditions) to a **position**, and surface it in portfolio and recommendation UIs. Different from MarketSignal.thesis (signal-level); this is “why I hold this position”.

### Current state

- **MarketSignal.thesis** = signal-level thesis.  
- **MarketNote** with `tag: "thesis"` exists; can store notes by marketId/slug.  
- **PositionDecisionSnapshot** has `decisionState` (e.g. THESIS_BROKEN), `reasoningJson`.  
- **ExitIntent** has `exitType` (e.g. THESIS_BROKEN).  
- No dedicated “position thesis” field on DerivedPosition or a separate table.

### Implementation plan

1. **Schema**  
   - **Option A (additive):** New model **PositionThesis** (or **PositionNote**):  
     - `funderAddress`, `assetId` (or `derivedPositionId`), `thesisText` (Text), `invalidationConditions` (Text, optional), `createdAt`, `updatedAt`.  
     - Unique per (funderAddress, assetId) or one-to-one with position.  
   - **Option B (reuse):** Use **MarketNote** with `tag: "position_thesis"` and a convention: store note per (marketId, outcome) or assetId in a JSON/metadata field. Then resolve position → market/slug and look up note.  
   - **Recommendation:** Option A for clarity and queryability: **PositionThesis** table with `funderAddress`, `assetId`, `thesisText`, `invalidationConditions` (optional), `createdAt`, `updatedAt`.  
   - **Prisma:** Add model; migration.

2. **API**  
   - **GET /api/portfolio/positions** (existing): Extend response so each position can include `thesis?: { thesisText, invalidationConditions, updatedAt }` when a PositionThesis exists.  
   - **GET /api/positions/[assetId]/thesis** or **GET /api/portfolio/position-thesis?assetId=...**: Return thesis for one position.  
   - **PUT/POST /api/portfolio/position-thesis**: Body `{ assetId, thesisText, invalidationConditions? }`. Upsert PositionThesis for funder.  
   - **DELETE** optional: clear thesis.

3. **Lib**  
   - New: `lib/portfolio/position-thesis.ts` — get/upsert/delete by funder + assetId.  
   - Called from API and from portfolio intelligence if you want “positions with thesis” in a bucket (optional).

4. **UI**  
   - **Portfolio page** (position detail sheet/card): Show “Your thesis” (thesisText) and “Invalidation” (invalidationConditions); Edit/Save button that calls PUT position-thesis.  
   - **Recommendation detail** (when the recommendation is for a market you already hold): Show “Position thesis” from PositionThesis for the linked position, if any.  
   - **Markets [slug] page**: When user has a position in that market, show position thesis from PositionThesis (resolve via assetId).

### Files to add

| File | Purpose |
|------|--------|
| `lib/portfolio/position-thesis.ts` | **Exists.** get/upsert by funder + assetId; **added** getPositionThesisForApi (stable empty shape + position context). |
| `app/api/portfolio/position-thesis/route.ts` | GET (list or by assetId) + PUT upsert (existing). |
| `app/api/portfolio/positions/[assetId]/thesis/route.ts` | **Implemented.** GET one thesis (404 if no position); PUT upsert (validated, ownership enforced). |
| `lib/portfolio/__tests__/position-thesis.test.ts` | **Implemented.** get/upsert, validation, ownership tests. |

### Files to change

| File | Change |
|------|--------|
| `app/(dashboard)/portfolio/page.tsx` | **Done.** Thesis panel uses PUT /api/portfolio/positions/[assetId]/thesis; persistence feedback. |
| `app/api/portfolio/positions/route.ts` | Already includes thesis in position payload. |

### Acceptance criteria (Phase 4)

- [x] PositionThesis is stored per (funder, assetId).
- [x] User can set/edit thesis (entry, status, exit reason, notes) from the portfolio UI.
- [x] Portfolio position detail shows stored thesis; recommendation UI can show via existing positions payload.
- [x] API allows read (GET positions/[assetId]/thesis) and write (PUT positions/[assetId]/thesis); validated, no cross-user access.

---

## Phase 5: Dashboard summary strip (+ optional Recommendation strip)

### Objective

A compact **summary strip** (dashboard and/or recommendations page) that shows: counts by primaryActionType (add / trim / avoid / monitor / etc.), top 1–2 bullets (e.g. “3 adds, 2 trims”), and a link to full list.

### Current state

- **Recommendations list** and **top** APIs return items with `primaryActionType`, `rationale`, etc.  
- **Recommendations widget** on dashboard shows top 5 with primary action labels.

### Implementation plan

1. **API**  
   - **New: GET /api/recommendations/summary**  
   - Returns: `{ byPrimaryAction: Record<PrimaryActionType, number>, topRationales: string[], total: number, linkTo: "/dashboard/recommendations" }`.  
   - Compute from same data as list (or a light query: count by primaryActionType, and 1–2 sample rationales).

2. **UI**  
   - **New component:** `components/dashboard/recommendation-summary-strip.tsx`:  
     - One line or small card: “3 Add, 2 Trim, 1 Avoid …” and “Key: &lt;rationale sample&gt;”.  
     - Link: “View all” → recommendations page.  
   - **Dashboard home** (`app/(dashboard)/page.tsx`): Add the strip below or next to existing recommendations widget.  
   - **Recommendations list page**: Optionally show the same strip at top (e.g. “Summary: 3 add, 2 trim”).

3. **Schema / lib**  
   - No new tables. Use existing Recommendation + primaryActionType.  
   - Optional: add a small function in `lib/polymarket/recommendations.ts` or in the route to compute summary from DB.

### Implemented: Dashboard summary strip

| File | Purpose |
|------|--------|
| `lib/dashboard/summary-strip.ts` | getDashboardSummaryStrip(): aggregate from intelligence, open orders, alert feed |
| `app/api/dashboard/summary-strip/route.ts` | GET compact payload; read-only |
| `components/dashboard/summary-strip.tsx` | Strip UI (positions, orders, %, unresolved, alerts, freshness, refresh) |
| `lib/dashboard/__tests__/summary-strip.test.ts` | Payload shape, aggregation, mixed-time |

Dashboard page renders SummaryStrip below title; Alerts section has id="alerts" for strip link.

### Acceptance criteria (Phase 5 dashboard strip)

- [x] GET /api/dashboard/summary-strip returns compact portfolio-state payload.
- [x] Dashboard shows summary strip near top; mixed-time surfaced in payload and UI.
- [x] Strip is deterministic; no new tables; uses existing services.

### Optional (not yet implemented): Recommendation summary strip

- GET /api/recommendations/summary (byPrimaryAction + sample rationales).
- components/dashboard/recommendation-summary-strip.tsx.

---

## Phase 6: Prepare for automatic trade bot (constrained, policy-driven)

### Objective

**Do not implement live automated trading.** Add the minimal structure so a future bot can be built safely: policy configuration, guardrails, and diagnostics.

### Current state

- **DecisionPolicySnapshot** and **lib/decision/policy.ts** already apply hard rules (BLOCK, REVIEW_REQUIRED, ALLOW_SMALL, etc.) and size multipliers.  
- **TradePreflightCheck** exists for geoblock, balance, allowance, market active, etc.  
- **OrderIntent** and **ExecutedOrder** track intents and executions.  
- No “bot” or “automation” flag; no policy config stored in DB.

### Implementation plan

1. **Policy configuration (read-only for now)**  
   - **Schema:** Optional table **TradingPolicyConfig** (or a single row in a key-value table):  
     - e.g. `maxPositionSizePct`, `allowedPrimaryActions[]`, `requirePreflightPass`, `maxDailyTrades`, `dryRunOnly` (default true).  
   - **API:** GET /api/ops/policy-config (or /api/bot/policy) returns current config.  
   - **No execution.** Just so that when you later add a bot, it reads policy from one place.

2. **Guardrails (deterministic)**  
   - Document in code (or `docs/TRADING_GUARDRAILS.md`):  
     - Never place without DecisionPolicySnapshot and policyState in ALLOW_* or TRIM/EXIT.  
     - Never exceed maxPositionSizePct / maxDailyTrades when you add them.  
     - Always run TradePreflightCheck and require passed.  
     - Dry-run mode: log “would place” but do not call Polymarket place API.  
   - Add a small **lib/bot/guardrails.ts** (or under `lib/decision/`): function `checkGuardrails(intent, policyState, preflight, config) => { allowed: boolean, reason: string }`. No trading; just return allow/deny + reason.

3. **Diagnostics**  
   - **GET /api/recommendations/[id]** and decision APIs already return policy state and reasoning.  
   - Optional: **GET /api/ops/bot-readiness** (or /api/bot/readiness): Returns `{ preflightOk, policyConfigPresent, guardrailsSummary, dryRunRecommended: true }` — no live trading, just “what would the bot see”.

4. **UI**  
   - **Ops page** or **Settings**: Section “Trading policy (read-only)” showing current config and link to guardrails doc.  
   - Optional: “Bot readiness” card that calls bot-readiness and shows status.

### Files to add

| File | Purpose |
|------|--------|
| `lib/bot/guardrails.ts` or `lib/decision/guardrails.ts` | checkGuardrails(intent, policy, preflight, config) → allow + reason |
| `docs/TRADING_GUARDRAILS.md` | Document rules and dry-run requirement |
| `app/api/ops/policy-config/route.ts` or `app/api/bot/policy/route.ts` | GET policy config (from env or future table) |
| Optional: `app/api/ops/bot-readiness/route.ts` | GET readiness summary |

### Files to change

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Optional: TradingPolicyConfig or key-value for policy |
| `app/(dashboard)/ops/page.tsx` or settings | Show policy config + link to guardrails |

### Implemented: Bot-prep guardrails (read-only preflight)

- **lib/bot/guardrails.ts**: Added `getGuardrailsReadiness(funder)` — deterministic preflight summary from existing signals. Returns `ready`, `status` ("ready" | "caution" | "blocked"), `checks[]`, `asOf`, `notes`.
- **GET /api/bot/guardrails**: Read-only; returns preflight payload. No mutation; no new tables.
- **Checks**: Portfolio truth-model readiness, portfolio freshness, unresolved positions, high concentration (warn 35%+, block 55%+), stale sync, high-severity alerts, reconciliation mismatch, recommendation review readiness. Blocking vs caution: any `blocking: true` → status blocked; else any warn → caution; else ready.
- **UI**: **components/bot/guardrails-card.tsx** on Ops page; status (Ready / Caution / Blocked) and per-check list.
- **Tests**: lib/bot/__tests__/guardrails-readiness.test.ts; `npm run test:guardrails`.

### Acceptance criteria (Phase 6)

- [x] Bot-readiness preflight: GET /api/bot/guardrails returns deterministic summary; no trading.
- [x] Guardrails: checkGuardrails (per-candidate) and getGuardrailsReadiness (system preflight) in lib/bot/guardrails.ts.
- [x] Ops page shows Bot readiness card with ready/caution/blocked and checks.

---

## Suggested order of execution and dependencies

| Order | Phase | Deps | Notes |
|-------|--------|------|------|
| 1 | **Alert Engine** | None | Uses existing PI and DriftAlert; no schema change. |
| 2 | **Recommendation diagnostics / explainability** | None | Uses existing rec v2 and diagnostics. |
| 3 | **Portfolio timeline** | None | Uses existing PortfolioSnapshot. |
| 4 | **Position thesis tracking** | None | New table + API + UI. |
| 5 | **Recommendation summary strip** | None | Uses existing list/top data. |
| 6 | **Trade bot prep** | 1–5 optional | Config, guardrails, docs only. |

Phases 1–5 can be parallelized by different devs; 6 should follow after at least 1 and 2 are in place (alerts and explainability are critical for trust).

---

## Schema additions summary

| Phase | Schema change |
|-------|----------------|
| 1 | None (optional: DriftAlert.source later) |
| 2 | None |
| 3 | None |
| 4 | **PositionThesis**: funderAddress, assetId, thesisText, invalidationConditions?, createdAt, updatedAt |
| 5 | None |
| 6 | Optional: **TradingPolicyConfig** or key-value row |

---

## API additions summary

| Phase | New/updated API |
|-------|------------------|
| 1 | **GET /api/alerts/feed** (merge drift + engine) |
| 2 | **GET /api/recommendations/[id]?explain=1** or **GET /api/recommendations/[id]/explain** |
| 3 | **GET /api/portfolio/timeline** |
| 4 | **GET/POST/PUT /api/portfolio/position-thesis** (and positions response extended) |
| 5 | **GET /api/recommendations/summary** |
| 6 | **GET /api/ops/policy-config**, **GET /api/ops/bot-readiness** (optional) |

---

## UI additions summary

| Phase | UI change |
|-------|-----------|
| 1 | Portfolio + Ops: show engine alerts; optional dashboard alert strip |
| 2 | Recommendation detail: “Why this action” + explanation blocks |
| 3 | Portfolio timeline page or section: chart of exposure/PnL over time |
| 4 | Portfolio position detail: thesis + invalidation edit; rec/market pages: show position thesis |
| 5 | Dashboard + optional list: recommendation summary strip |
| 6 | Ops/Settings: policy config + readiness card + link to guardrails doc |

---

## Risk and constraints

- **Alert Engine:** Keep rules simple and logged so false positives can be tuned.
- **Explainability:** Stay consistent with existing recommendation thresholds to avoid confusion.
- **Timeline:** If snapshot history is sparse, document that “synthetic” fill-based timeline is a possible future extension.
- **Position thesis:** One thesis per position (e.g. overwrite on edit); optional “history” later.
- **Bot prep:** No order placement; only config, guardrails, and diagnostics.

This plan keeps the architecture additive, reuses Portfolio Intelligence and Recommendation Engine v2, and prioritizes deterministic, explainable rules and strong diagnostics before any automated trading.
