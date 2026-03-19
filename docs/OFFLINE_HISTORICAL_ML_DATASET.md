# Offline Historical ML Dataset for Shadow Training

## Goal

Train the shadow ML model on **past market information** without needing:
- Live trading or paper order submission
- Execution policy allow / unblocked flow
- ShadowCandidate creation from the runtime intent path
- Reconciliation success or live worker

## 1. Root cause: why the live shadow path is unnecessary for this goal

The **current shadow pipeline** is built for *observing real bot decisions* and then evaluating them:

1. **Runtime** emits intents → guardrails/execution policy allow or block → `recordShadowCandidate()` writes one row per intent (blocked or submitted).
2. **Evaluation job** (`evaluateShadowCandidates`) runs later: for each unevaluated candidate it loads `MarketPriceSnapshot` at decision time and at +1h, +6h, +24h, computes markouts and `outcomeClassification`, and updates the `ShadowCandidate` row.
3. **Dataset build** (`persistShadowTrainingExamples`) reads evaluated `ShadowCandidate` rows, extracts features from their snapshot JSONs, derives labels from `outcomeClassification`, and writes `MlShadowTrainingExample`.

What the **trainer** actually needs is only:

- Rows in `MlShadowTrainingExample` with:
  - **Features**: the fixed vector from `toShadowFeatureVector(ShadowFeatureInput)` (see `lib/ml/shadow-train/features.ts`). Many of these come from execution/decision snapshots (policy state, execution allow, quality, portfolio risk). For offline we can supply **market/price features** (e.g. `intendedPrice`, `intendedSize`, `side`) and **defaults** (0, null, false) for the rest.
  - **Labels**: at least one of `labelGoodDecision`, `labelMissedOpportunity` non-null. Those are derived from `outcomeClassification` and `wasBlocked` in the dataset build. For offline we have no real “block/allow” decision; we only have **future price movement**. So we define a **synthetic outcome**: e.g. “if we had allowed at time T”, then outcome = good_allow | bad_allow from 24h markout, and `labelGoodDecision` = (outcome was good_allow).

So:

- **Order submission** is unnecessary: we never submit; we only need (asset, timestamp, price at T and T+1h/6h/24h) to compute markout and labels.
- **Execution policy allow** is unnecessary: we are not deciding live; we are backfilling “would this have been a good trade?” from history.
- **Reconciliation success** is unnecessary: no orders, no reconciliation.
- **Live ShadowCandidate flow** is unnecessary: we never call `recordShadowCandidate`. We create **synthetic** training rows that look like `MlShadowTrainingExample` (same schema) but with a synthetic `shadowCandidateId` (e.g. `offline-{marketId}-{assetId}-{ts}`) and `candidateSource: "offline_historical"`.

The live path is about **recording and evaluating real decisions**. For **training on history**, we only need **historical prices + a rule to label “good/bad” from markout**. So the offline path is a separate data source that fills the same table and is consumed by the same trainer.

## 2. Minimum required fields to train the current model offline

From `lib/ml/shadow-train/train.ts` and `lib/ml/shadow-train/features.ts`:

- **Required for training**:
  - `createdAt` (for time-split train/val)
  - One of `labelGoodDecision` or `labelMissedOpportunity` non-null (boolean).
  - All fields used in `ShadowFeatureInput` can be null/0/false; `toShadowFeatureVector` maps missing → 0. So at minimum we can set:
    - `intendedPrice`, `intendedSize`, `side` from historical price and a chosen side (e.g. BUY).
    - `outcomeBlockedVsAllowedVsSubmitted`: e.g. `"submitted"` for synthetic “we allowed”.
    - Everything else: null, 0, or false.

- **Required for persistence** (Prisma `MlShadowTrainingExample`):
  - `id`, `shadowCandidateId` (unique), `funderAddress`, `assetId`, `marketId?`, `candidateSource`, `createdAt`, `updatedAt`, `side`, `intendedPrice`, `intendedSize`, `wasBlocked`, `wasSubmitted`, and the label columns we set.

So the **minimum** for a valid offline row is: identifiers (synthetic id, funder, asset, market, source, createdAt), side, intendedPrice, intendedSize, wasBlocked=false, wasSubmitted=true, markout24h (or equivalent), outcomeClassification, labelGoodDecision (and optionally labelMissedOpportunity), plus defaults for all feature columns.

## 3. Proposed dataset generation architecture

- **Input**: time range `[startDate, endDate]`, optional `marketIds`, optional `funderAddress`, optional sampling (e.g. one point per asset per 6h or per day).
- **Data source**: `MarketPriceSnapshot` only. No ShadowCandidate, no order ledger.
- **Algorithm**:
  1. Enumerate (marketId, assetId) pairs that have at least two snapshots (so we can get price at T and T+24h).
  2. For each pair, get snapshot timestamps in the range. For each timestamp T (decision time), require a snapshot at T and at T+24h (and optionally T+1h, T+6h). If present, compute price0 = price at T, price24h = price at T+24h (same logic as `getPriceAt` in shadow-evaluation).
  3. For each valid (marketId, assetId, T):
     - Compute markout for side BUY (or configurable): markout24h = (price24h - price0) / price0.
     - Classify: synthetic “we allowed” → outcome = markout24h > 0 ? good_allow : bad_allow.
     - Derive labels: labelGoodDecision = (outcome === good_allow), labelBadDecision = (outcome === bad_allow), labelMissedOpportunity = false.
     - Build one row with features: intendedPrice = price0, intendedSize = "1", side = "BUY", outcomeBlockedVsAllowedVsSubmitted = "submitted", rest defaults; labels as above.
  4. Persist to `MlShadowTrainingExample` with `shadowCandidateId = offline-{marketId}-{assetId}-{T.getTime()}` (or similar unique id). Skip if that id already exists (idempotent).

- **Reuse**:
  - Markout formula and outcome classification: same as `lib/shadow-evaluation/evaluate.ts` (extract to shared module so live evaluation and offline builder stay in sync).
  - Label derivation from outcome: same as `lib/ml/shadow-dataset/build.ts` (`deriveLabels`).
  - Feature vector: same `toShadowFeatureVector` and schema; trainer unchanged.

## 4. Files to add or change

| Action | File | Description |
|--------|------|-------------|
| Add | `lib/shadow-evaluation/markout.ts` | Pure markout + classify; used by evaluate.ts and offline builder. |
| Change | `lib/shadow-evaluation/evaluate.ts` | Use shared markout/classify from markout.ts. |
| Add | `lib/ml/shadow-dataset/offline-historical.ts` | Build offline examples from MarketPriceSnapshot; write to MlShadowTrainingExample. |
| Add | `tools/generate-offline-shadow-dataset.ts` | CLI: date range, options, call builder and optionally persist. |
| Change | `package.json` | Add script `generate:offline-shadow-dataset`. |
| Add | `docs/OFFLINE_HISTORICAL_ML_DATASET.md` | This design doc. |

No change to:
- `lib/ml/shadow-train/train.ts` (already reads any MlShadowTrainingExample rows).
- `lib/ml/shadow-dataset/build.ts` (live path unchanged).
- Prisma schema (reuse MlShadowTrainingExample; optional later: index or filter by candidateSource).

## 5. CLI command(s)

```bash
# Generate offline training examples from historical snapshots and persist to MlShadowTrainingExample
npm run generate:offline-shadow-dataset -- --from 2025-01-01 --to 2025-03-01 [--funder 0x...] [--dry-run] [--interval hours=6] [--limit 5000]
```

- `--from` / `--to`: date range for decision timestamps (defaults: e.g. last 90 days).
- `--funder`: funderAddress to set on rows (default: `"offline"`).
- `--dry-run`: build rows and log count/sample, do not persist.
- `--interval`: sample one decision time per N hours per (marketId, assetId) to limit rows (default: 24).
- `--limit`: max examples to persist in one run (default: 10_000).

## 6. Minimal first implementation plan

1. **Extract markout + classify** into `lib/shadow-evaluation/markout.ts` (pure functions; same semantics as current evaluate.ts).
2. **Offline builder** (`lib/ml/shadow-dataset/offline-historical.ts`):
   - `getPriceAt(marketId, assetId, at)` using MarketPriceSnapshot (same query as evaluate).
   - Enumerate (marketId, assetId, decisionAt) from snapshots: e.g. distinct (marketId, assetId) from snapshots in range; for each, take snapshots at interval; for each T, require T+24h snapshot; compute price0, price24h, markout, outcome, labels.
   - Build one `ShadowTrainingRow`-like object per (marketId, assetId, T) with synthetic ids and defaults; call existing `deriveLabels` from build.ts for consistency.
   - Persist via Prisma `mlShadowTrainingExample.create` (skip if shadowCandidateId exists).
3. **CLI** `tools/generate-offline-shadow-dataset.ts`: parse args, call builder, print summary.
4. **npm script** `generate:offline-shadow-dataset` in package.json.

After this, run:

```bash
npm run generate:offline-shadow-dataset -- --from 2025-01-01 --to 2025-03-15 --dry-run
npm run generate:offline-shadow-dataset -- --from 2025-01-01 --to 2025-03-15
```

Then train as today (e.g. API or job that calls `trainShadowModel()`); it will pick up both live and offline rows. Optionally filter by `candidateSource === "offline_historical"` in the trainer in a later iteration.
