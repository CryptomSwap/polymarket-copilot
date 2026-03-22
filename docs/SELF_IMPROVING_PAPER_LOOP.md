# Self-improving paper-only ML loop

This documents the **paper-only** automation chain. It does **not** change live trading execution. Threshold relaxation and hidden policy mutation are **out of scope** for the orchestrated loop (`paper_config_optimize` is not invoked there).

## Stages (data → model → paper)

1. **Truth:** `shadow_evaluation` — `evaluateShadowCandidates` (markouts / labels).
2. **Dataset:** `ml_shadow_dataset_build` or `runShadowDatasetRefreshJob` inside `ml_shadow_retrain` — `persistShadowTrainingExamples`.
3. **Path features:** `ml_shadow_path_feature_backfill` or `runShadowPathFeatureBackfillJob` **before** training in `ml_shadow_retrain`.
4. **Retrain:** `runShadowRetrainJob` — produces `TRAINED` runs (fail-closed skips when data/target gates fail).
5. **Bootstrap review:** `ml_shadow_bootstrap_activate` — may set first short-horizon `TRAINED` → `APPROVED` only when cold-start guardrails pass.
6. **Champion review:** `ml_shadow_promote` — `computeShadowPromotionPreview` holdout gates; may set challenger `TRAINED` → `ACTIVE` when deltas pass.
7. **Paper tick:** `paper_trading_tick` — **requires** parseable `ACTIVE`/`APPROVED` shadow model (`getActiveOrApprovedShadowModel`); runs on its own interval.
8. **Outcomes:** `paper_trading_close_due` — 12h markouts on `PaperTrade`.
9. **Guard:** `self_improvement_rollback_guard` — optional automatic model rollback after promotion if paper PnL vs baseline breaches env thresholds; report includes score-band breakdown.

## Orchestrated job

- **`self_improving_paper_loop`** (default **weekly**): runs, in order,  
  `shadow_evaluation` → `dataset_refresh` → `path_feature_backfill` → `retrain` → `bootstrap_activate` → `promote` → `rollback_guard`, then writes `dump/self-improving-loop-status.{json,md}`.

Granular jobs (`shadow_evaluation` every 6h, `ml_shadow_retrain` daily, etc.) can still run in parallel; the weekly job is a single explicit pass.

## Status & rollback artifacts

- **Status:** `npm run dump:self-improving-loop-status` or scheduled `self_improvement_status_report` → `dump/self-improving-loop-status.json` + `.md`.
- **Rollback report:** `self_improvement_rollback_guard` → `dump/self-improvement-rollback-report-latest.json` (includes `paperTradeOutcomesByScoreBand`, `rollbackRecommendation`).

## Env knobs (non-exhaustive)

| Variable | Purpose |
|----------|---------|
| `SELF_IMPROVE_PATH_BACKFILL_LIMIT` | Rows scanned per path backfill job |
| `SHADOW_EVAL_MIN_AGE_MS` / `SHADOW_EVAL_LIMIT` | Shadow evaluation batch |
| `SELF_IMPROVE_*` | Promotion, bootstrap, rollback, retrain gates (see `lib/ops/self-improvement-loop.ts`) |
