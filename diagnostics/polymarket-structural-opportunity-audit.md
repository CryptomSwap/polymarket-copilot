# Polymarket Structural Opportunity Audit

- Generated: 2026-03-31T20:23:47.937Z
- Data source: fresh CLOB order books via @polymarket/clob-client getOrderBooks (/books), fetched during this run
- Fee model for net edge: feeRate=0 per leg (source=missing_config_assumed_zero); net edge is conservative linear fee deduction
- Scope: read-only measurement only; no strategy routing, thresholds, filters, scorers, or runtime execution behavior changed

## A. Market coverage and synchronized books
- Binary markets with both YES/NO metadata: 530
- Markets fetched from CLOB in this run: 530
- Markets with BOTH YES+NO best ask present (same fetch batch): 445
- Full-set parity opportunities (YES ask + NO ask < 1): 0

## B. Top parity opportunities (sorted by net edge)
| market | yes ask | no ask | yes+no | gross edge | net edge | yes size | no size | min size | est capacity | thin/noise |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |

## C. Liquidity realism
- Flagged opportunities total: 0
- Likely thin/noise (estimated cap notional < 25 or missing): 0
- Median estimated capacity notional: -

## D. Opportunity stats
- Opportunities detected this run: 0
- Median gross edge: -
- Median net edge: -
- Median size-capacity (notional): -

| category | opportunities | median gross edge | median net edge | median cap notional |
| --- | ---: | ---: | ---: | ---: |

## E. Blunt conclusion
- none detected

## Limitations
- This report is a point-in-time live snapshot; opportunities can disappear quickly.
- If fee config is missing, net edge uses zero-fee assumption and may be optimistic; set `STRUCTURAL_AUDIT_FEE_RATE` or related env to harden.
- This audit intentionally focuses on binary full-set parity and synchronized YES/NO asks.