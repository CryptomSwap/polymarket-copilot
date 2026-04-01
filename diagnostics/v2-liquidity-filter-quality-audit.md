# V2 Liquidity Filter Quality Audit

- Generated: 2026-03-31T12:51:54.404Z
- Data source: repeated dry-run sampling (12 ticks, cadence 500ms), plus ShadowCandidate execution-quality/markout proxies
- Liquidity thresholds: spread <= 500 bps, slippage <= 200 bps

## A. Admitted trades performance (sampled)
- count (trace admissions): 36
- avg score used: 0.605000
- avg proxy markout: 0.001146
- median proxy markout: 0.001146
- win rate proxy: 100.00%
- proxy coverage (admitted): 36 / 36
- real closed overlay-era trades: 0

## B. Filtered candidates proxy analysis
- liquidity_spread rejects: 96
- liquidity_slippage rejects: 36
- combined liquidity rejects: 132
- combined avg proxy markout: -0.007490
- combined median proxy markout: 0.000000
- combined win rate proxy: 72.73%
- admitted-vs-filtered proxy delta (avg markout): 0.008636
- proxy coverage (filtered): 132 / 132
- proxy source counts: paper_market_proxy=360

## C. Band-level breakdown
| band | filtered(liquidity) | admitted | admitted avg proxy markout | admitted proxy win rate |
| --- | ---: | ---: | ---: | ---: |
| <0.1 | 96 | 0 | - | - |
| 0.1-0.2 | 36 | 0 | - | - |
| 0.2-0.3 | 0 | 0 | - | - |
| 0.3-0.4 | 0 | 0 | - | - |
| 0.4-0.6 | 0 | 0 | - | - |
| 0.6-0.8 | 0 | 36 | 0.001146 | 100.00% |
| 0.8-0.9 | 0 | 0 | - | - |
| >=0.9 | 0 | 0 | - | - |

## D. Spread/slippage distribution
- spread bps min/p25/median/p75/max: 26.385224/119.760479/298.507463/512.820513/606.060606
- slippage bps min/p25/median/p75/max: 13.192612/59.880240/149.253731/256.410256/303.030303
- spread cutoff percentile location (approx): 70.00%
- slippage cutoff percentile location (approx): 50.00%
- near-miss spread rejects (within +20% cutoff): 60 / 96
- near-miss slippage rejects (within +20% cutoff): 36 / 36

## E. Near-threshold analysis
- near-spread avg proxy markout: 0.001124
- near-spread win rate proxy: 100.00%
- near-slippage avg proxy markout: -0.029338
- near-slippage win rate proxy: 0.00%
- near-miss vs admitted avg proxy delta: -0.011445

## F. Blunt conclusion
- filters correctly remove bad trades