# ML Targets and Labels

Canonical registry and label definitions. Run `npm run dump:ml:label-registry` for the report and `npm run dump:ml:target-truth-audit` for the hard audit (schema, population counts, active model).

## Registry

- **Location**: `lib/ml/targets/registry.ts`
- **Implemented** (implementationStatus = implemented): `labelGoodDecision`, `labelMissedOpportunity`, `labelPositive6h`, `labelPositive24h`
- **Partial** (populated only by offline-historical): `labelGoodDecision6h`, `labelGoodDecision12h`
- **Scaffolded** (not populated by any builder): `labelGoodDecision24h`, `labelSpreadAdjustedGoodDecision12h`, `labelRealizablePnlPositive12h`

## labelGoodDecision12h

- **Status**: **Implemented** — populated by both canonical shadow build and offline-historical.
- **Schema**: Column exists on `MlShadowTrainingExample`.
- **Canonical build** (`build.ts` `persistShadowTrainingExamples`):
  - Computes a 12h markout from `MarketPriceSnapshot` for each `ShadowCandidate` when sufficient price data exists.
  - Sets `markout12h` and `labelGoodDecision12h` for those rows using the same markout-based good-decision semantics as the 12h paper-trading horizon (favorable 12h markout ⇒ good allow; unfavorable ⇒ good block).
  - Leaves `markout12h` and `labelGoodDecision12h` **null** when snapshots are missing or 12h markout cannot be computed; this is expected and auditable.
- **Offline-historical** (`offline-historical.ts`): Also sets `labelGoodDecision12h` (and `labelGoodDecision6h`) from `markout12h + classify`, so both paths share the same target semantics.
- **Trainable**: Yes — `trainShadowModel` accepts `labelGoodDecision12h`; training works when rows are populated (from either canonical or offline-historical data).

## Label generation

- Outcome-based labels: `lib/ml/shadow-dataset/build.ts` — `deriveLabels(outcome, wasBlocked, executionQualityHadBlocks)`.
- Horizon-based good decision: `lib/ml/targets/build-labels.ts` — `deriveGoodDecisionFromMarkout`, `buildLabelForTarget`.

## Gaps (scaffolded targets)

- **labelGoodDecision24h**: No column on `MlShadowTrainingExample`; add to schema to implement.
- **labelSpreadAdjustedGoodDecision12h / labelRealizablePnlPositive12h**: Require spread and execution-aware data; not yet computed.

See `dump/ml-label-registry-report.md` and `dump/ml-target-truth-audit.md` after running the dumps.
