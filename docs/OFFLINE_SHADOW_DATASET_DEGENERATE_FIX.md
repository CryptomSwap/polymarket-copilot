# Offline Shadow Dataset: Degenerate Model Fix

## Root cause of the degenerate model

1. **Only one feature had variance.** The offline builder was filling almost every training column with **defaults** (null, 0, false). The trainer’s feature vector uses 24 fields; the only non-constant ones were:
   - **intendedPrice** (varies by market/asset)
   - **intendedSize** (constant "1")
   - **sideEnc** (constant 1 for BUY)
   - **outcomeBlockedVsAllowedVsSubmittedEnc** (constant 3 for "submitted")

   So the model was effectively learning from **intendedPrice** only → one dominant coefficient, no signal in the rest.

2. **Precision/recall 0.** With a single dominant feature and a binary label, the learned threshold can collapse to “always predict one class” (e.g. negative), giving accuracy ~71% (class imbalance) but **precision 0 and recall 0** for the positive class, and **rocAuc ~0.47** (no discrimination).

3. **CLI flags could be ignored.** When using `npm run generate:offline-shadow-dataset -- --from 2025-01-01`, some environments don’t pass args after `--` correctly. Parsing only `--key value` (no `--key=value`) made it easy to end up with defaults (e.g. wrong date range or limit).

---

## Features that were defaulting to zero/null (before fix)

| Feature | Before | After (historical) |
|--------|--------|---------------------|
| sizeMultiplier | null | log1p(volume)-derived or 1 |
| finalSuggestedSize | null | same |
| eligibilityBlockersCount | 0 | 0 (no blockers in history) |
| reducedSizeIndicator | false | true when sizeMult < 1 |
| blockedIndicator | false | false |
| executionAllow | null | **true** |
| executionWarningCount | 0 | 0 |
| qualityStateEnc | 0 (null) | **good/warn** from liquidity |
| spreadBps | null | **volatility24h in bps** |
| estimatedSlippage | null | **min(volBps, backward price change bps)** |
| tradable | 0 (null) | **liquidity ≥ threshold** |
| grossExposure, totalOpenExposure, etc. | null/0 | still 0 (no portfolio in history) |
| policyStateEnc | 0 (null) | **allow (1)** |
| outcomeBlockedVsAllowedVsSubmittedEnc | 3 | 3 (unchanged) |

So the **high-value historical features** we now fill from `MarketPriceSnapshot` (and the same time series) are:

1. **spreadBps** – 24h volatility: (max − min)/mid over [T−24h, T], × 10000.
2. **estimatedSlippage** – min(volBps, 1h/6h backward price change in bps).
3. **qualityState** – "good" if liquidity at T ≥ 50, else "warn".
4. **tradable** – liquidity at T ≥ 50.
5. **sizeMultiplier / finalSuggestedSize** – from log1p(volume) at T, clamped; else 1.
6. **reducedSizeIndicator** – true when sizeMultiplier < 1.
7. **executionAllow** – true (simulated “allowed”).
8. **policyState** – "allow".

We still do **not** have portfolio/exposure or runtime-safety in history, so those remain 0/null.

---

## Files changed

| File | Change |
|------|--------|
| **tools/generate-offline-shadow-dataset.ts** | `expandArgs()` for `--key=value`; support `-f`/`-t` for from/to. |
| **tools/train-shadow-model.ts** | `expandArgs()` for `--key=value`. |
| **tools/inspect-shadow-dataset.ts** | **New.** Dataset inspection: total rows, label counts, positive rate, date range, distinct funders, per-feature non-default % and variance. |
| **lib/ml/shadow-dataset/offline-historical.ts** | Load **liquidity** and **volume**; points as `Point[]`; **volatility24hBps()**, **valueAtOrBefore()**; per-row **spreadBps**, **estimatedSlippage**, **qualityState**, **tradable**, **sizeMultiplier**, **finalSuggestedSize**, **policyState**, **executionAllow**, **reducedSizeIndicator**. |
| **package.json** | Script **inspect:shadow-dataset**. |
| **docs/OFFLINE_SHADOW_DATASET_DEGENERATE_FIX.md** | This doc. |

---

## Commands to regenerate dataset and retrain

Use `--key=value` so arguments are reliable across environments.

**1. (Optional) Inspect current dataset**
```bash
npm run inspect:shadow-dataset -- --limit=5000 --source=offline_historical
```

**2. Generate a new offline dataset**  
Example: last 90 days, 6h interval, limit 5000, then persist.
```bash
npm run generate:offline-shadow-dataset -- --from=2025-01-01 --to=2025-03-15 --interval=6 --limit=5000
```
Or with defaults (from 90 days ago, to 25h ago, interval 24h, limit 10k):
```bash
npm run generate:offline-shadow-dataset
```
Dry-run first if you want:
```bash
npm run generate:offline-shadow-dataset -- --from=2025-01-01 --to=2025-03-15 --dry-run
```

**3. Inspect the new dataset**
```bash
npm run inspect:shadow-dataset -- --limit=5000 --source=offline_historical
```
Check: positive rate ~30–70%, multiple features with non-zero variance (spreadBps, estimatedSlippage, qualityStateEnc, tradable, sizeMultiplier, policyStateEnc).

**4. Train the shadow model**
```bash
npm run train:shadow-model -- --limit=5000 --save=shadow-model.json
```
Optional filters:
```bash
npm run train:shadow-model -- --limit=5000 --funder=offline --source=offline_historical --save=shadow-model.json
```

**5. Check metrics**  
Validation should show non-zero precision/recall, F1 and rocAuc clearly above 0.5, and several features with non-zero importance (not only intendedPrice).

---

## Expected signs of a healthier dataset

After regenerating with the updated builder and re-running inspect + train:

- **inspect:shadow-dataset**
  - **spreadBps**, **estimatedSlippage**, **qualityStateEnc**, **tradable**, **sizeMultiplier**, **policyStateEnc**, **executionAllow** have **non-default counts > 0** and **variance > 0**.
  - **intendedPrice** still has high variance.
  - Positive rate for **labelGoodDecision** in a reasonable range (e.g. 0.3–0.7).

- **train:shadow-model**
  - **Precision and recall** both **> 0** (and ideally balanced).
  - **F1** and **rocAuc** **> 0.5** (e.g. rocAuc 0.55–0.75).
  - **Feature importance**: several features with non-zero |coefficient| (e.g. spreadBps, estimatedSlippage, qualityState, tradable, sizeMultiplier, policyState, intendedPrice), not only intendedPrice.

If the DB already has 2000 old (pre-fix) rows and you don’t clear them, new rows will **add** to the table. To train only on the new style, either:
- delete old `candidateSource=offline_historical` rows and regenerate, or  
- add a `--source=offline_historical` (and optionally `--created-after=...`) filter to the train script and run training on the new data only.
