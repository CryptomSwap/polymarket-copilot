# Manual Shadow Review

**Generated:** 2026-03-14T21:07:21.623Z

## Endpoint status

- `ml-shadow-disagreement`: OK
- `shadow-evaluation`: OK
- `shadow-analysis`: OK
- `execution-quality-calibration`: OK
- `portfolio-risk-calibration`: OK
- `runtime-policy-calibration`: OK
- `decision-calibration`: OK

## Disagreement summary

| Metric | Value |
|--------|-------|
| totalRows | 0 |
| evaluatedRows | 0 |
| agreementRate | — |
| disagreementRate | — |
| modelId | — |

### Top cohorts by evaluated count

| Staged | Band | Total | Evaluated | Good block | Bad block | Good allow | Bad allow | Staged right | Shadow right | Usefulness |
|--------|------|-------|-----------|------------|-----------|------------|-----------|--------------|--------------|-------------|
| staged_block | low | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | insufficient |
| staged_block | medium | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | insufficient |
| staged_block | high | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | insufficient |
| staged_allow | low | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | insufficient |
| staged_allow | medium | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | insufficient |
| staged_allow | high | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | insufficient |
| staged_reduce | low | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | insufficient |
| staged_reduce | medium | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | insufficient |
| staged_reduce | high | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | insufficient |

## Shadow evaluation summary

| Metric | Value |
|--------|-------|
| totalCandidates | 0 |
| blockedCandidates | 0 |
| allowedCandidates | 0 |
| evaluatedCandidates | 0 |
| goodBlocks | 0 |
| badBlocks | 0 |
| goodAllows | 0 |
| badAllows | 0 |
| averageMarkout24h | — |

## Calibration summaries

### execution-quality-calibration

- **Top review_loosen:** 0 (—)
- **Top review_tighten:** 0 (—)
- **Top keep_strict:** 0 (—)

### portfolio-risk-calibration

- **Top review_loosen:** 0 (—)
- **Top review_tighten:** 0 (—)
- **Top keep_strict:** 0 (—)

### runtime-policy-calibration

- **Top review_loosen:** 0 (—)
- **Top review_tighten:** 0 (—)
- **Top keep_strict:** 0 (—)

### decision-calibration

- **Top review_loosen:** 0 (—)
- **Top review_tighten:** 0 (—)
- **Top keep_strict:** 0 (—)

## Recommended next manual review focus

1. **Disagreement:** If disagreement rate is high, inspect cohorts where `shadow_more_right` — shadow ML may be flagging missed opportunities or bad allows.
2. **Calibration:** Prioritize subtypes with `review_loosen` or `review_tighten` for threshold review; `keep_strict` suggests current blocking is beneficial.
3. **Shadow evaluation:** Compare good_block vs bad_block and good_allow vs bad_allow to balance block vs allow decisions.
