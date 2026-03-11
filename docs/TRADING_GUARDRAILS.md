# Trading Guardrails (Bot v1)

**No live automated trading is enabled.** The bot layer is **dry-run / suggest-only**. These guardrails are applied when evaluating what *would* be placed.

## Guardrails (deterministic)

1. **Never trade unresolved catalog markets**  
   Market and asset must exist in `SyncedMarket` / `SyncedAsset`. No CLOB-only or unresolved condition IDs.

2. **Never trade on stale sync**  
   If portfolio intelligence reports stale positions (e.g. last sync > 24h), the candidate is blocked until sync is refreshed.

3. **Never exceed per-market cap**  
   Post-trade single-position concentration must not exceed configured cap (default 50%). Uses order-preview concentration logic.

4. **Never exceed per-theme cap**  
   Post-trade theme concentration must not exceed configured cap (default 50%).

5. **Never add near resolution unless explicitly allowed**  
   For BUY/add candidates, if market resolves within configured hours (default 72h), the candidate is blocked unless `allowNearResolutionAdd` is true.

6. **Never duplicate strongly overlapping thesis**  
   For BUY/add, if theme exposure is already above configured cap (default 40%), the candidate is blocked as duplicate-theme overlap.

7. **Idempotent execution keys**  
   Each candidate has a stable key `recommendationId:assetId:side:size:limitPrice`. A future executor must not place twice for the same key (e.g. dedupe by key within a time window).

## Config

See `lib/bot/types.ts` → `BotGuardrailConfig` and `DEFAULT_GUARDRAIL_CONFIG`. Overrides can be passed to `runDryRun(..., config)` or (future) from env or DB.

## APIs

- **GET /api/bot/dry-run** — Returns dry-run result: candidates, guardrail result per candidate, summary (allowed/blocked). No orders placed.

## Execution

- **Place order** is only via **POST /api/orders/place** with explicit request body (manual or future bot with explicit enable).
- The bot layer does **not** call `placeLimitOrder`. It only produces candidates and guardrail results.
