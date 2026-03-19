# Execution Quality Guardrails

## Purpose

The execution-quality layer is a **conservative market-microstructure guard** that blocks or warns on unsafe execution conditions before order submission. It answers:

- Is the market tradable right now?
- What is the likely slippage from available book/depth data?
- Are spread, depth, and quote freshness acceptable?

This is a **pre-trade safeguard**: it does not score alpha or strategy; it evaluates whether the current quote/depth state is safe to execute against.

## What Data Is Used

| Input | Source | Used For |
|-------|--------|----------|
| `bestBid` / `bestAsk` | Market state (quote) | Spread, mid, crossed-book check, slippage estimate |
| `bidDepth` / `askDepth` | Market state (depth), top-of-book sizes | Depth sufficiency vs intended size |
| `spreadBps` | Quote or derived from bid/ask | Wide-spread block/warn |
| `quoteAgeMs` | `quote.updatedAt` vs now | Stale-quote block, degraded-quote warn |
| `intendedPrice` / `intendedSize` / `side` | Order intent | Depth check (same-side depth vs size), price-far-from-market check |
| `liquidityScore` / `isTradable` | Market state (liquidity) | Optional block/warn when below threshold or not tradable |

All inputs are optional where the type allows; **missing critical data leads to block or warn**, not invented certainty.

## What Is Estimated vs Measured

- **Measured**: Spread (from bid/ask), spread bps, depth (top-of-book sizes), quote age. These come from the live market state store.
- **Estimated**: Slippage and fill quality. Slippage is a **rough** estimate: for a BUY we use (bestAsk − mid) / mid in bps; for a SELL, (mid − bestBid) / mid in bps. This is top-of-book only; we do not simulate full book or pretend precision. `estimatedFillQuality` is a label (low/moderate/high/unknown) derived from that slippage estimate.

We do **not** fake full-depth analytics when only top-of-book data exists.

## Spread / Depth / Slippage Assumptions

- **Spread**: In basis points; thresholds are centralized in `lib/execution-quality/config.ts` (e.g. warn at 400 bps, block at 1500 bps). Crossed book (bid ≥ ask) always blocks.
- **Depth**: Same-side depth (ask for BUY, bid for SELL) is compared to `intendedSize`. If depth &lt; `intendedSize * DEPTH_BLOCK_RATIO` (e.g. 0.3) → block; if &lt; `DEPTH_MIN_RATIO` (e.g. 0.6) → warn. No deep orderbook math; we only use top-of-book sizes when available.
- **Slippage**: Conservative. If the estimated slippage (bps) exceeds a block threshold, we block; above a warn threshold we warn. Values are labeled approximate in the snapshot.

## Block vs Warn Philosophy

- **Block**: Order must not be submitted. Examples: missing quote, crossed book, quote too stale, spread too wide, insufficient depth, intended price far from market, estimated slippage too high, not tradable, liquidity score below block threshold.
- **Warn**: Condition is degraded but not necessarily fatal; policy may still allow with warnings. Examples: quote age degraded, wide spread (below block threshold), depth low, estimated slippage moderate, liquidity low.

The execution policy receives the execution-quality result and **blocks** when `qualityState === "block"` by adding `execution_quality:<reason>` to its blocking reasons.

## Where This Feeds

1. **Execution policy**  
   The runtime builds an execution-quality result from the asset’s live state (quote, depth, liquidity) and the order’s side, size, and limit price. That result is passed as `executionQuality` into the execution policy. If `qualityState === "block"`, the policy fails the liquidity check and does not allow submission.

2. **Decision engine (staged)**  
   The staged decision engine’s **market-quality stage** today uses a `liquidityScore` (and related signals) from recommendations. It does **not** yet consume the execution-quality module directly. Execution quality is enforced at submission time via the execution policy; the decision stage remains focused on recommendation-level market quality. A future, low-risk change could feed execution-quality signals into the market-quality stage if desired.

3. **Operator / API**  
   - **GET /api/ops/execution-quality?assetId=...&side=BUY&intendedPrice=0.5&intendedSize=10**  
     Returns the current execution-quality evaluation for that asset and order parameters using the live market state engine. Exposes: tradable, qualityState, blockingReasons, warnings, estimatedSlippage, spread, spreadBps, depthSufficiency, quoteFreshnessState, estimatedFillQuality, evaluatedAt.

## Known Limits

- **Partial book**: Only top-of-book depth is used. We do not have full depth; depth sufficiency is a conservative check against top-of-book size.
- **Quote age**: When `quote.updatedAt` is missing, we cannot compute quote age; we may still block on missing quote or missing best bid/ask for the side.
- **Slippage**: Approximate only; real fill may be worse if the book is thin or moves.
- **API/manual path**: The API order path (`lib/polymarket/trading.ts`) does not yet run execution-quality evaluation before calling the CLOB; it relies on execution policy only where the runtime path is used. Manual/API orders that bypass the runtime do not get this guard unless we add a similar call there later.

## Thresholds (in code)

Defined in `lib/execution-quality/evaluate.ts`:

- `QUOTE_STALE_MS` (e.g. 60_000): quote older than this → block  
- `QUOTE_DEGRADED_MS` (e.g. 30_000): quote older than this → warn  
- `SPREAD_BPS_WARN` / `SPREAD_BPS_BLOCK` (e.g. 400 / 1500)  
- `DEPTH_MIN_RATIO` / `DEPTH_BLOCK_RATIO` (e.g. 0.6 / 0.3)  
- `PRICE_FAR_FRACTION` (e.g. 0.05): intended price &gt; 5% away from best → block  
- `SLIPPAGE_BPS_WARN` / `SLIPPAGE_BPS_BLOCK` (e.g. 200 / 500)  
- `LIQUIDITY_SCORE_WARN` / `LIQUIDITY_SCORE_BLOCK` (e.g. 0.25 / 0.15)

These are conservative defaults; adjust in code as needed for your risk tolerance.
