# Paper relaxed outcome-quality validation summary

## Files added/changed

### New
- **tools/create-paper-relaxed-cohort-analysis.ts** – Cohort analysis: score/pnl distributions, splits by `paperRelaxationReason` and score band, worst/best 20 closed relaxed with full row details (market title/slug, side, entry/exit price, score, reason, derivationSource, pnl, evaluation outcome).
- **tools/create-paper-relaxed-threshold-sensitivity.ts** – Threshold sensitivity for closed relaxed only: simulated metrics at 0.3, 0.4, 0.5, 0.6; split by edge_too_small / liquidity_too_low.

### Extended
- **tools/create-paper-relaxed-trades-review.ts** – Added `derivationSourceBreakdown` (count by derivationSource for relaxed), `cohortByReason` (per-reason opened/closed/wins/losses/winRate/avgPnlPct), and `derivationSource` on each top-25 relaxed row.
- **package.json** – Scripts: `dump:paper-relaxed-cohort-analysis`, `dump:paper-relaxed-threshold-sensitivity`.

## Commands run

1. `npx tsx tools/run-paper-relaxation-validation.ts` (snapshots, one paper tick, close-due, audit + regression + review dumps).
2. `npm run dump:paper-relaxed-cohort-analysis`
3. `npm run dump:paper-relaxed-threshold-sensitivity`

## Validation results (current state)

- **Relaxed opened count:** 224 (all from earlier run; this run loaded 224 candidates, opened 0 new due to cooldown/limits).
- **Relaxed closed count:** 0 (no relaxed trade has yet been held 12h and closed).
- **Overall relaxed score distribution:** count=224, min≈0.461, p10≈0.461, p25≈0.462, p50≈0.496, p75≈0.527, p90≈0.528, max≈0.528, avg≈0.495.
- **Overall relaxed closed-trade win rate / avg PnL / median PnL:** N/A (no closed relaxed trades).
- **Performance by relaxation reason:** edge_too_small 141 opened / 0 closed; liquidity_too_low 83 opened / 0 closed. Outcome metrics N/A until closed.
- **Best threshold on observed closed relaxed trades:** Not determinable (0 closed).
- **liquidity_too_low vs edge_too_small:** No outcome comparison yet (no closed trades).
- **Cohort assessment:** Score distribution is narrow (≈0.46–0.53); once trades close, re-run the three dumps to assess whether the relaxed cohort is promising, neutral, or noisy.

## Outputs

- **dump/paper-relaxed-cohort-analysis.json** – Full cohort stats; worst/best 20 populated when closed count > 0.
- **dump/paper-relaxed-cohort-analysis.md** – Human-readable cohort report.
- **dump/paper-relaxed-threshold-sensitivity.json** – Per-threshold and per-reason simulated metrics (meaningful once closed relaxed exist).
- **dump/paper-relaxed-threshold-sensitivity.md** – Human-readable threshold report.
- **dump/paper-relaxed-trades-review.json** – Includes `derivationSourceBreakdown` and `cohortByReason`; top 25 include `derivationSource`.
- **dump/paper-relaxed-trades-review.md** – Updated with derivationSource and cohort sections.

## Next steps

After 12h has passed for some relaxed trades, run `closePaperTradesAt12h()` (or the close-due route), then re-run:

- `npm run dump:paper-relaxed-trades-review`
- `npm run dump:paper-relaxed-cohort-analysis`
- `npm run dump:paper-relaxed-threshold-sensitivity`

to get win rate, PnL, threshold sensitivity, and worst/best 20 closed relaxed trades.
