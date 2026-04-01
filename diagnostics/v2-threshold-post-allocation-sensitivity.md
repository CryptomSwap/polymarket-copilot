# V2 Threshold Post-Allocation Sensitivity

- Generated: 2026-03-31T19:26:08.774Z
- Window: 24 dry-run ticks, cadence 500ms

## A. Current threshold context
- score field used: finalBandAwareScore (actualScoreUsedForThreshold)
- active thresholds by bot: {"strict_quality":0.39999999999999997,"relaxed_edge":0.3,"tail_extremes":0.34}
- baseline current threshold (lowest active): 0.3000

## B. Candidate score distribution (current regime)
- min/p25/median/p75/max: 0.0262 / 0.0935 / 0.1888 / 0.4725 / 1.0000
| bin | count |
| --- | ---: |
| [0.0,0.2) | 120 |
| [0.2,0.4) | 48 |
| [0.4,0.6) | 48 |
| [0.6,0.8) | 0 |
| [0.8,1.0] | 24 |

## C. Sensitivity table
| threshold | pass count | pass rate |
| ---: | ---: | ---: |
| 0.2000 | 120 | 50.00% |
| 0.2500 | 96 | 40.00% |
| 0.3000 | 96 | 40.00% |
| 0.3500 | 96 | 40.00% |

## D. By-band sensitivity
| band | avg score | pass@current | pass@(current-0.05) |
| --- | ---: | ---: | ---: |
| <0.1 | 0.1888 | 33.33% | 33.33% |
| 0.1-0.2 | 0.1206 | 0.00% | 0.00% |
| 0.2-0.3 | 0.5000 | 100.00% | 100.00% |
| 0.3-0.4 | - | - | - |
| 0.4-0.6 | 0.7362 | 100.00% | 100.00% |
| 0.6-0.8 | - | - | - |
| 0.8-0.9 | - | - | - |
| >=0.9 | - | - | - |

## E. Near-threshold candidates
- candidates just below threshold (within 0.05): 0
- by band: {}
- proxy quality (band-based avg markout) for near-threshold set: -

## F. Blunt conclusion
- threshold appropriate

## Appendix: Aggregated flow context
- candidates: 240
- scored unique: 240
- pass threshold unique: 96
- survive filters unique: 96
- admitted unique: 0
- reject totals: {"score_failed":0,"below_threshold":456,"liquidity_spread":0,"liquidity_slippage":0,"global_max_open_total":0,"bot_max_open":0,"dedupe":264}