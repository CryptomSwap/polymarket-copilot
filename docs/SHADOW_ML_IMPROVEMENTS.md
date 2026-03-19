# Shadow ML Pipeline Improvements

Improvements to the offline shadow ML pipeline: evaluation script, 6h/12h horizon targets, and five new historical features to improve predictive signal quality.

## 1. Evaluation Script

**File:** `tools/evaluate-shadow-model.ts`  
**Script:** `npm run evaluate:shadow-model`

- Loads the latest trained shadow model (or `--model-run-id=...`).
- Fetches `MlShadowTrainingExample` rows with the chosen target label.
- Computes predicted probabilities and evaluates at **multiple thresholds**: 0.1, 0.2, 0.3, 0.4, 0.5.
- For each threshold: prints **confusion matrix** (TP, FP, TN, FN) and metrics (precision, recall, F1, accuracy).
- Prints **score distributions** for positive vs negative labels: min, max, mean, p10, p50, p90.

**Usage:**
```bash
npm run evaluate:shadow-model
npm run evaluate:shadow-model -- --limit=3000 --target=labelGoodDecision
npm run evaluate:shadow-model -- --model-run-id=<id> --target=labelGoodDecision6h
```

## 2. Alternative Targets (6h / 12h Horizons)

- **New columns:** `markout12h`, `labelGoodDecision6h`, `labelGoodDecision12h`.
- **Trainer** supports `--target=labelGoodDecision` (24h), `labelGoodDecision6h`, `labelGoodDecision12h`, `labelMissedOpportunity`.
- Offline builder now computes markout at 6h and 12h and derives binary labels via the same `classify`/`deriveLabels` logic.

**Regression on markout** and **bucketed markout classification** would require a separate model type and training path (e.g. regression head or multi-class labels); they are not implemented here and can be added later.

## 3. New Historical Features (5+)

All added to `MlShadowTrainingExample` and `toShadowFeatureVector`:

| Feature | Description |
|--------|-------------|
| **momentum1hBps** | Signed price change (bps) over 1h before decision time. |
| **momentum6hBps** | Signed price change (bps) over 6h before decision time. |
| **volatility1hBps** | (max−min)/mid in bps over 1h window. |
| **volatility6hBps** | (max−min)/mid in bps over 6h window. |
| **distanceFromMid** | \|price − 0.5\| at decision time. |
| **timeToCloseHours** | Hours from decision time to market `endDate` (from SyncedMarket). |
| **liquidityTrend** | (liquidity_now − liquidity_6h_ago) / liquidity_6h_ago. |

Offline builder populates these from `MarketPriceSnapshot` (and SyncedMarket for `timeToCloseHours`).

## 4. Files Changed

| Area | Files |
|------|------|
| **Schema** | `prisma/schema.prisma` – new columns on `MlShadowTrainingExample`. |
| **Migration** | `prisma/migrations/20260315000000_ml_shadow_example_horizons_and_features/migration.sql`. |
| **Features** | `lib/ml/shadow-train/features.ts` – `ShadowFeatureInput`, `SHADOW_FEATURE_NAMES`, `toShadowFeatureVector`. |
| **Types** | `lib/ml/shadow-train/types.ts` – `ShadowTargetLabel` includes 6h/12h. |
| **Trainer** | `lib/ml/shadow-train/train.ts` – `toInput` includes new fields; supports new target labels. |
| **Offline builder** | `lib/ml/shadow-dataset/offline-historical.ts` – markout6h/12h, new features, SyncedMarket endDate lookup. |
| **CLI** | `tools/evaluate-shadow-model.ts` (new), `tools/train-shadow-model.ts` – `--target` for 6h/12h. |
| **Package** | `package.json` – `evaluate:shadow-model` script. |

## 5. Commands: Regenerate Dataset and Retrain

**CLI args:** All three CLIs support `--key value` and `--key=value`. They print `[argv]` at startup so you can confirm what was received. If using `npm run`, you must put `--` before script args (e.g. `npm run generate:offline-shadow-dataset -- --from=2025-01-01`). If flags are still ignored, use the **direct npx tsx** commands below (args are passed correctly).

**1. Apply migration (once):**
```bash
npx prisma migrate deploy
```

**2. Regenerate offline dataset (with new features and 6h/12h labels):**
```bash
# Direct (recommended if npm run ignores flags):
npx tsx tools/generate-offline-shadow-dataset.ts --from=2025-01-01 --to=2025-03-01 --limit=5000 --interval=24
# With debug (print first 5 rows' historical feature values):
npx tsx tools/generate-offline-shadow-dataset.ts --from=2025-01-01 --to=2025-03-01 --limit=5000 --debug

# Via npm (must include -- before script args):
npm run generate:offline-shadow-dataset -- --from=2025-01-01 --to=2025-03-01 --limit=5000
```

**3. Inspect dataset (optionally restrict to enriched rows by date):**
```bash
npx tsx tools/inspect-shadow-dataset.ts --source=offline_historical
# Only rows created on or after this date (enriched run):
npx tsx tools/inspect-shadow-dataset.ts --source=offline_historical --from=2025-03-01 --limit=10000
```

**4. Train (24h default or 6h/12h):**
```bash
# Direct:
npx tsx tools/train-shadow-model.ts --source=offline_historical --target=labelGoodDecision6h --limit=4000

# Via npm:
npm run train:shadow-model -- --source=offline_historical --target=labelGoodDecision6h --limit=4000
```

**5. Evaluate trained model (optionally same date/source as training):**
```bash
npx tsx tools/evaluate-shadow-model.ts --target=labelGoodDecision6h --limit=2000
# Same enriched window and source as training:
npx tsx tools/evaluate-shadow-model.ts --target=labelGoodDecision6h --source=offline_historical --from=2025-03-01 --limit=2000
```

### Inspect and evaluate only the enriched rows used by the 12h model

Use the same `--from` (and optionally `--to`) as when you generated the enriched dataset or trained the 12h model. Get the date from the generator run or from the model run’s `trainedFrom` / `validatedFrom`.

```bash
# Inspect only enriched rows (replace DATE with first day of your enriched run, e.g. 2025-03-01):
npx tsx tools/inspect-shadow-dataset.ts --source=offline_historical --from=DATE --limit=10000

# Evaluate 12h model on the same enriched slice (use same DATE):
npx tsx tools/evaluate-shadow-model.ts --target=labelGoodDecision12h --source=offline_historical --from=DATE --limit=5000
```

## 6. What Would Indicate Real Improvement

- **Score separation:** Positive-label mean score clearly above negative-label mean; p50(pos) > p50(neg). Overlap in distributions should decrease.
- **ROC-AUC:** Sustained above 0.55–0.60 (vs ~0.42 before); higher is better.
- **Precision/recall at a threshold:** At 0.3 or 0.4, precision and recall both non-zero and preferably balanced (e.g. precision ≥ 0.25, recall ≥ 0.15).
- **Confusion matrix:** At a chosen threshold, non-trivial TP and TN counts; FP/FN not dominating.
- **Feature importance:** Several of the new features (momentum, volatility, distanceFromMid, timeToCloseHours, liquidityTrend) appear with non-zero coefficients, not only `intendedPrice`.

If metrics stay weak, next steps: more data, different horizons (6h/12h), or alternative targets (e.g. regression on markout, bucketed outcomes) with a dedicated trainer.

## Inspection / evaluation consistency (fixes applied)

- **Inspect zero-variance on new features:** The inspect CLI was building `toInput` without the 7 historical columns (momentum1hBps, momentum6hBps, volatility1hBps, volatility6hBps, distanceFromMid, timeToCloseHours, liquidityTrend), so `toShadowFeatureVector(toInput(r))` always had 0 in those slots. Inspect now passes the same fields as the trainer; variance for the new features should match what the model sees.
- **ROC-AUC was inverted:** The evaluator was returning P(positive ≤ negative) instead of P(positive > negative). Fixed in `lib/ml/evaluate.ts` so rocAuc matches the usual definition (higher = better ranking of positives vs negatives).
- **Debug vectors:** Use `--debug` on inspect and train to print `SHADOW_FEATURE_NAMES` and the first 3 feature vectors so you can confirm inspect and train use the same order and values.

## Old vs new offline_historical rows / source versioning

- **Mixing:** All rows with `candidateSource = "offline_historical"` are stored in the same table. Rows generated before the new feature columns were added have null/zero in those columns; rows generated after the migration and updated builder have non-zero values. So when you filter by `--source=offline_historical`, you get a mix of old (zero new features) and new (enriched) rows unless you restrict by date (e.g. `createdAfter` after your last “old” run) or clear old rows.
- **Versioning:** There is no `dataset_version` or `feature_set_version` on `MlShadowTrainingExample`. To avoid mixing:
  - **Option A:** Use time bounds: train/inspect/evaluate with `--from=<date of first new run>` so only recently generated rows are used.
  - **Option B (proposed):** Add a lightweight version column and filter by it (see below).
- For now, use `--from` / `--to` on inspect and evaluate so you only see enriched rows; training already supports `createdAfter` / `createdBefore`.

### Optional: lightweight dataset version column

To make “enriched vs old” explicit and avoid relying on dates:

- **Schema:** Add an optional string column, e.g. `featureSetVersion` or `generatorVersion`, to `MlShadowTrainingExample` (nullable, no unique constraint).
- **Generator:** When persisting offline_historical rows, set it to a fixed value (e.g. `"v1_enriched"` or the value of an env var `SHADOW_DATASET_VERSION`). Old rows stay `null`.
- **Train / inspect / evaluate:** Add a `--version=...` (or `--feature-set-version=...`) filter that restricts to `featureSetVersion = <value>`. Omit the filter to keep current behaviour (all rows).
- **Benefits:** Reproducible runs (same version = same feature set), no need to remember date cutoffs, and you can later add new versions (e.g. `v2`) without touching old data.

## Next best experiment (after validation)

After confirming inspection and ROC-AUC are consistent:

1. **Threshold tuning only** – Use the fixed evaluation script; pick a single threshold (e.g. 0.2 or 0.3) for “allow” and measure precision/recall on a held-out set. Low effort; no new data or targets.
2. **12h target** – Train and evaluate with `--target=labelGoodDecision12h` on the same enriched dataset. Direct comparison to 6h/24h; may improve if 12h horizon matches your decision window.
3. **More features** – Add a small set of extra historical features (e.g. volume trend, more volatility windows) and re-run generate → train → evaluate. Use `--debug` on inspect/train to confirm vectors align.
4. **Source versioning** – Add a `generatorVersion` or `featureSetVersion` column and set it in the offline generator; filter by it in train/inspect so old and new rows are never mixed. Best for reproducibility.

**Recommendation:** Do **threshold tuning** first (quick win with the fixed metrics), then try **12h target** on the same data to see if horizon helps; if 6h/12h/24h differ meaningfully, consider **source versioning** so you can compare versions cleanly.
