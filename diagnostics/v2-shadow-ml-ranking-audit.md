# V2 Shadow ML Ranking Audit

- Generated: 2026-03-31T12:17:50.904Z
- Cohort: closed V2 PaperTrade rows since 2026-03-30T12:15:04.535Z (dedupeKey contains |v2|)
- Live scorer gate now: PAPER_TRADING_USE_STRUCTURED_SCORER=(unset->false)

## A. Global ranking quality
- count: 63
- winners: 25
- losers: 38
- winner mean/median score: 0.700359 / 0.574554
- loser mean/median score: 0.620760 / 0.525317

| score bucket | count | avg markout | median markout | win rate |
| --- | ---: | ---: | ---: | ---: |
| [0.2,0.4) | 4 | 0.000000 | 0.000000 | 0.00% |
| [0.4,0.6) | 39 | 0.003982 | 0.000000 | 38.46% |
| [0.8,1.0] | 20 | -0.004676 | 0.000000 | 50.00% |

- top-vs-bottom (20% tails, n=12 each): avg markout -0.008386 vs 0.004783, win rate 33.33% vs 50.00%
- monotonicity check: not_monotone

## B. In-band ranking quality
| band | count | high-half avg markout | low-half avg markout | high-half win rate | low-half win rate | note |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| <0.1 | 14 | -0.014861 | 0.000000 | 0.00% | 0.00% |  |
| 0.1-0.2 | 9 | 0.002246 | 0.000000 | 75.00% | 0.00% |  |
| 0.2-0.3 | 0 | - | - | - | - | insufficient_sample |
| 0.3-0.4 | 2 | - | - | - | - | insufficient_sample |
| 0.4-0.6 | 3 | - | - | - | - | insufficient_sample |
| 0.6-0.8 | 12 | 0.018697 | -0.001068 | 50.00% | 0.00% |  |
| 0.8-0.9 | 13 | -0.000246 | -0.001132 | 83.33% | 50.00% |  |
| >=0.9 | 10 | 0.001870 | 0.000408 | 100.00% | 60.00% |  |

## C. Orientation sanity check
- Intended orientation: higher `shadowMlScore` should be better (probability-like score from logistic model).
- Live sort direction in V2 code: descending by `score` (`passedFilter.sort((a,b)=>b.score-a.score)`).
- Threshold check direction: reject when `score < threshold`.
- Evidence flag (global): higher score performs worse in global tails (inversion)

## D. Composition effects (live dry-run snapshot)
- live scorer source: shadow_ml
- unique candidates scored: 10
- score buckets all candidates (pre-admission): `{"[0.0,0.2)":2,"[0.2,0.4)":2,"[0.4,0.6)":3,"[0.6,0.8)":2,"[0.8,1.0]":1}`
- score buckets admitted traces: `{"[0.0,0.2)":0,"[0.2,0.4)":0,"[0.4,0.6)":0,"[0.6,0.8)":0,"[0.8,1.0]":0}`
- score buckets rejected traces: `{"[0.0,0.2)":6,"[0.2,0.4)":6,"[0.4,0.6)":9,"[0.6,0.8)":6,"[0.8,1.0]":3}`
- Interpretation constraint: filters/rejections change composition of admitted set, but do not overwrite score values.

## E. Blunt conclusion
- shadow_ml works in-band but fails cross-band