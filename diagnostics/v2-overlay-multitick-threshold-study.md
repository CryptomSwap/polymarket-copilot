# V2 Overlay Multitick Threshold Study

- Generated: 2026-03-31T12:47:12.623Z

## A. Window definition
- window: 12 dry-run ticks, cadence 500ms
- first tick: 2026-03-31T12:47:12.626Z
- last tick: 2026-03-31T12:47:18.725Z
- data source: repeated dry-run sampling via `runPaperTradingTickV2({ dryRun: true })`
- persistence status: not historical per-tick DB persistence; sampled runtime snapshots

## B. Aggregated funnel
- raw candidates (sum across ticks): 120
- scored unique-candidate observations: 120 (100.00%)
- pass threshold: 72 (60.00%)
- survive filters: 24 (20.00%)
- admitted: 12 (10.00%)

## C. Threshold sensitivity (window)
- baseline threshold: 0.3000
- score distribution min/p25/median/p75/max: 0.0525 / 0.1608 / 0.3775 / 0.6050 / 0.8075
| threshold | pass count | pass rate |
| ---: | ---: | ---: |
| 0.2000 | 84 | 70.00% |
| 0.2500 | 84 | 70.00% |
| 0.3000 | 72 | 60.00% |
| 0.3500 | 72 | 60.00% |
| 0.4000 | 60 | 50.00% |

### By-band pass rates (sampled)
| band | count | avg score | median score | pass@current | pass@(current-0.05) | pass@(current+0.05) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| <0.1 | 84 | 0.3775 | 0.3775 | 57.14% | 71.43% | 57.14% |
| 0.1-0.2 | 24 | 0.4825 | 0.4825 | 50.00% | 50.00% | 50.00% |
| 0.2-0.3 | 0 | - | - | - | - | - |
| 0.3-0.4 | 0 | - | - | - | - | - |
| 0.4-0.6 | 0 | - | - | - | - | - |
| 0.6-0.8 | 12 | 0.6050 | 0.6050 | 100.00% | 100.00% | 100.00% |
| 0.8-0.9 | 0 | - | - | - | - | - |
| >=0.9 | 0 | - | - | - | - | - |

## D. Band-specific pressure
- <0.1: n=84, avg=0.3775, median=0.3775, pass@current=57.14%, pass@-0.05=71.43%, pass@+0.05=57.14%
- 0.1-0.2: n=24, avg=0.4825, median=0.4825, pass@current=50.00%, pass@-0.05=50.00%, pass@+0.05=50.00%
- 0.6-0.8: n=12, avg=0.6050, median=0.6050, pass@current=100.00%, pass@-0.05=100.00%, pass@+0.05=100.00%

## E. Dominant choke point
- spread/liquidity
- reject counts (per-bot trace aggregate): `{"score_failed":0,"below_threshold":156,"liquidity_spread":96,"liquidity_slippage":36,"global_max_open_total":0,"bot_max_open":0,"dedupe":36}`
- threshold-removed unique observations: 48

## F. Blunt conclusion
- threshold roughly appropriate