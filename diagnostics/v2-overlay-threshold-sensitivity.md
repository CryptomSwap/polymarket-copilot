# V2 Overlay Threshold Sensitivity

- Generated: 2026-03-31T12:41:55.507Z
- Mode: dry-run latest tick (read-only)

## A. Current threshold context
- Live function: `runPaperTradingTickV2` in `lib/paper-trading/engine_v2_minimal.ts`
- Score field compared to threshold: `ScoredCandidate.score` (overlay finalBandAwareScore in shadow_ml path).
- Active bot thresholds (threshold + minScoreBuffer): `{"strict_quality":0.39999999999999997,"relaxed_edge":0.3,"tail_extremes":0.34}`
- Sensitivity baseline threshold used: 0.3000

## B. Candidate score distribution
- candidate count (unique): 10
- min / p25 / median / p75 / max: 0.0525 / 0.1608 / 0.3775 / 0.5942 / 0.8075
- histogram: `{"[0.0,0.2)":3,"[0.2,0.4)":2,"[0.4,0.6)":2,"[0.6,0.8)":2,"[0.8,1.0]":1}`
- above threshold (0.3000): 6
- below threshold (0.3000): 4

## C. Sensitivity table
| threshold | pass count | pass % | survive filters (derivable) | admitted (derivable) |
| ---: | ---: | ---: | ---: | ---: |
| 0.2000 | 7 | 70.00% | n/a | n/a |
| 0.2500 | 7 | 70.00% | n/a | n/a |
| 0.3000 | 6 | 60.00% | 1 | 1 |
| 0.3500 | 6 | 60.00% | 1 | 1 |
| 0.4000 | 5 | 50.00% | 1 | 1 |
- Note: for thresholds below current, post-threshold survival/admission is not exactly derivable from one trace because those candidates were never evaluated downstream.

## D. By-band sensitivity
| band | count | avg overlay score | pass@current | pass@(current-0.05) | pass@(current+0.05) |
| --- | ---: | ---: | ---: | ---: | ---: |
| <0.1 | 7 | 0.3775 | 57.14% | 71.43% | 57.14% |
| 0.1-0.2 | 2 | 0.4825 | 50.00% | 50.00% | 50.00% |
| 0.2-0.3 | 0 | - | - | - | - |
| 0.3-0.4 | 0 | - | - | - | - |
| 0.4-0.6 | 0 | - | - | - | - |
| 0.6-0.8 | 1 | 0.6050 | 100.00% | 100.00% | 100.00% |
| 0.8-0.9 | 0 | - | - | - | - |
| >=0.9 | 0 | - | - | - | - |

## E. Blunt conclusion
- evidence insufficient