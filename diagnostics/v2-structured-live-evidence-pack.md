# V2 Structured Live Evidence Pack

- Generated: 2026-03-31T17:12:05.806Z
- Regime start: 2026-03-30T12:15:04.535Z
- Regime start source: inferred:min(createdAt) where dedupeKey contains |v2|

## A. Latest structured live regime report

### Cohort summary
- total opens: 114
- total closed: 114
- close rate: 100.00%
- avg markout: 0.010026
- median markout: 0.000000
- total realized pnl dollars: -
- win rate (markout>0 fallback pnlPct): 38.94%

### Performance by entry price band
| price band | open count | closed count | avg markout | median markout | win rate | avg realized pnl% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| <0.1 | 38 | 38 | -0.003240 | 0.000000 | 10.53% | -0.003240 |
| 0.1-0.2 | 23 | 23 | 0.003894 | 0.000000 | 47.83% | 0.003894 |
| 0.2-0.3 | 3 | 3 | 0.287257 | 0.287257 | 100.00% | 0.287257 |
| 0.3-0.4 | 2 | 2 | 0.000000 | 0.000000 | 0.00% | 0.000000 |
| 0.4-0.6 | 12 | 12 | 0.016992 | 0.018692 | 58.33% | 0.016992 |
| 0.6-0.8 | 12 | 12 | 0.008814 | -0.000000 | 25.00% | 0.008814 |
| 0.8-0.9 | 13 | 13 | -0.001261 | 0.001211 | 61.54% | -0.001261 |
| >=0.9 | 11 | 11 | 0.001139 | 0.001538 | 80.00% | 0.001139 |

### Structured score separation
| score bucket | count | avg markout | median markout | win rate |
| --- | ---: | ---: | ---: | ---: |
| [0.000, 0.450) | 11 | 0.005098 | 0.000000 | 27.27% |
| [0.450, 0.478) | 11 | 0.000121 | 0.000000 | 27.27% |
| [0.478, 0.525) | 11 | 0.076362 | 0.002994 | 54.55% |
| [0.525, 0.554) | 10 | -0.000893 | 0.000000 | 0.00% |
| [0.554, 0.998) | 13 | 0.013239 | 0.001211 | 53.85% |
| [0.998, 1.000) | 6 | 0.001185 | 0.001361 | 100.00% |
| [1.000, 1.000) | 51 | 0.001279 | 0.000000 | 37.25% |

- top-vs-bottom (each 22 rows): avg markout 0.000888 vs 0.002609, win rate 40.91% vs 27.27%

### Cross section: price band x score bucket (cells with n>=3)
| price band | score bucket | count | avg markout | win rate |
| --- | --- | ---: | ---: | ---: |
| <0.1 | [0.525, 0.554) | 7 | -0.001276 | 0.00% |
| <0.1 | [0.554, 0.998) | 3 | 0.000000 | 0.00% |
| <0.1 | [1.000, 1.000) | 25 | -0.004567 | 16.00% |
| >=0.9 | [0.998, 1.000) | 4 | 0.001024 | 100.00% |
| >=0.9 | [1.000, 1.000) | 4 | 0.001822 | 100.00% |
| 0.1-0.2 | [0.450, 0.478) | 3 | 0.000000 | 0.00% |
| 0.1-0.2 | [0.478, 0.525) | 3 | 0.002994 | 100.00% |
| 0.1-0.2 | [1.000, 1.000) | 14 | 0.005756 | 57.14% |
| 0.4-0.6 | [0.000, 0.450) | 5 | 0.011215 | 60.00% |
| 0.4-0.6 | [1.000, 1.000) | 6 | 0.017391 | 50.00% |
| 0.6-0.8 | [0.450, 0.478) | 3 | -0.000000 | 0.00% |
| 0.6-0.8 | [0.525, 0.554) | 3 | 0.000000 | 0.00% |
| 0.6-0.8 | [0.554, 0.998) | 3 | 0.041667 | 100.00% |
| 0.8-0.9 | [0.450, 0.478) | 5 | 0.000265 | 60.00% |
| 0.8-0.9 | [0.478, 0.525) | 3 | -0.008121 | 0.00% |
| 0.8-0.9 | [0.554, 0.998) | 3 | 0.001211 | 100.00% |

### Recent vs prior comparison
| metric | latest regime closed | prior baseline closed (size-matched) |
| --- | ---: | ---: |
| n closed | 114 | 114 |
| avg markout | 0.010026 | 0.000812 |
| median markout | 0.000000 | 0.000000 |
| win rate | 38.94% | 35.14% |

## B. Recent tick / candidate mix report

- latest tick at: 2026-03-31T17:10:39.849Z
- tick window minutes used: -
- funder used for load: -

### Candidate mix before filter
- total candidates: 0
- by price band: `{"<0.1":0,"0.1-0.2":0,"0.2-0.3":0,"0.3-0.4":0,"0.4-0.6":0,"0.6-0.8":0,"0.8-0.9":0,">=0.9":0,"unknown":0}`

### Candidate mix after filter
- total candidates: 0
- by price band: `{"<0.1":0,"0.1-0.2":0,"0.2-0.3":0,"0.3-0.4":0,"0.4-0.6":0,"0.6-0.8":0,"0.8-0.9":0,">=0.9":0,"unknown":0}`

### Admitted trades
- total admitted: 0
- by price band: `{"<0.1":0,"0.1-0.2":0,"0.2-0.3":0,"0.3-0.4":0,"0.4-0.6":0,"0.6-0.8":0,"0.8-0.9":0,">=0.9":0,"unknown":0}`
- by botType: `{}`
- by botType x price band: `{}`

### Reject/noop reasons
- reject reasons: `[{"reason":"budget_cap","count":21},{"reason":"spread_guard","count":2}]`
- noop zeroCandidatesReason: -

### Structured score distribution admitted vs rejected
- available: true, admitted(mean=-, median=-), rejected(mean=0.965555, median=0.965555)

## C. Closed cohort / ranking quality report

- winner count: 44
- loser count: 69
- winner score mean/median: 0.794863 / 0.999785
- loser score mean/median: 0.741451 / 0.702500

### In-band ranking quality
| band | count | high-half avg outcome | low-half avg outcome | high-half win rate | low-half win rate | note |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 0.1-0.2 | 23 | 0.004667 | 0.002146 | 54.55% | 36.36% |  |
| 0.2-0.3 | 3 | - | - | - | - | insufficient_sample |
| 0.3-0.4 | 2 | - | - | - | - | insufficient_sample |

## Caveats
- Latest tick report uses only persisted `PaperTradingState.lastOpenTickResultJson` (single latest tick, no historical tick table).
- Candidate price bands in section B come from joining trace candidate IDs to `ShadowCandidate.intendedPrice`; rows without candidateId remain unknown band.
- If `PAPER_V2_STRUCTURED_REGIME_SINCE` is unset, regime start is inferred from earliest `|v2|` dedupe key.
- All outputs are read-only diagnostics; no strategy logic or runtime behavior changed.