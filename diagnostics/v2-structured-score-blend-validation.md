# V2 Structured Score Blend Validation

- Generated: 2026-03-31T11:31Z
- Scope: read-only validation of post-blend scoring behavior

## Commands run

```powershell
docker compose --profile postgres up -d postgres app worker
docker compose exec worker npx tsx tools/run-paper-tick-v2.ts
docker compose exec worker npx tsx tools/create-v2-structured-live-regime-report.ts
```

## Artifacts used

- `diagnostics/v2-structured-live-evidence-pack.md`
- `diagnostics/v2-structured-live-evidence-pack.json`
- tick stdout from `tools/run-paper-tick-v2.ts` (inside `worker`)

## Findings (facts only)

### A) Global score monotonicity

- Top score bucket did **not** outperform mid bucket in latest closed cohort.
- From evidence pack:
  - `[0.400, 0.600)`: avg markout `0.003982`
  - `[0.800, 1.000]`: avg markout `-0.004676`
- Top-vs-bottom inversion did **not** disappear:
  - top 12 avg markout `-0.008386` vs bottom 12 `0.004783`
- Before-vs-after direct comparison is **not available** from a preserved pre-change artifact in repo.

### B) In-band ranking preservation

- `0.1-0.2`: high-half beat low-half
  - high-half avg outcome `0.002246`, win rate `75%`
  - low-half avg outcome `0.000000`, win rate `0%`
- `0.2-0.3`: insufficient sample (`count=0`)
- `0.3-0.4`: insufficient sample (`count=2`)

### C) Admission / flow

- Latest fresh V2 tick admitted candidates:
  - `trades opened: 24`
- Dominant reject reason in that tick:
  - `liquidity_spread: 6`
- Note: evidence pack section B is based on `PaperTradingState.lastOpenTickResultJson` and currently reflects a different persisted tick snapshot with `admitted=0` and reject reasons `cooldown_asset`, `directional_temporarily_disabled_for_eval`, `spread_guard`.

### D) Score construction sanity from tick debug sample

- Tick scorer path reported `scorer: shadow_ml` (not structured scorer).
- Debug sample fields were present but null:
  - `baseScore: null`
  - `bandRankScore: null`
  - `bandSignal: null`
  - `priceBand: null`
- Therefore, this tick cannot validate structured blend ordering behavior (within-band or cross-band).
- No pathological structured-blend dominance cases can be assessed from this tick because structured components were not active in scoring output.

## Caveats

- Validation is limited by scorer mode in fresh tick output (`shadow_ml`), so blend-field behavior is only validated in closed-cohort outcome report, not on live structured-score debug traces.
- `lastOpenTickResultJson` in DB can lag the manual tick command output used for flow checks.
