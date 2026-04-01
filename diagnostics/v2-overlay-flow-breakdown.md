# V2 Overlay Flow Breakdown

- Generated: 2026-03-31T22:09:45.942Z
- Mode: dry-run V2 tick (read-only, no trade creation)
- Scorer source: shadow_ml

## A. Candidate generation
- total raw candidates: 36

## B. After scoring
- total scored candidates (unique): 36
- score min / median / max: 0.026250 / 0.335000 / 1.000000

## C. Threshold stage
- pass threshold (unique candidates, any bot): 20
- fail threshold (unique candidates): 16
- fail scoring (unique candidates): 0

## D. Rejection breakdown
- below_threshold: 54

## E. Admission
- total admitted trades: 20

## Funnel
- candidates (unique): 36 (100.00%)
- scored (unique): 36 (100.00%)
- pass threshold (unique): 20 (55.56%)
- survive filters (unique): 20 (55.56%)
- admitted (unique): 20 (55.56%)
- Note: trace rows are per-bot decisions; funnel above is collapsed to unique candidates.

## Score diagnostics
- rejected candidates avg score: 0.186528
- passed/admitted candidates avg score: 0.657569

## Dominant choke point
- threshold_failed removed 16 candidates

## Blunt conclusion
- threshold too strict