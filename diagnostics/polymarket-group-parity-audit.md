# Polymarket Group Parity Audit

- Generated: 2026-03-31T20:32:14.033Z
- Data source: SyncedMarket/SyncedAsset grouping + fresh CLOB books (/books) for all group legs in this run
- Fee model for net deviation: feeRate=0 (source=missing_config_assumed_zero)
- Grouping: metadata keys (event/group/series in raw), fallback to slug/title stem heuristics
- Partial-check mode: true (exact negative-risk conversion mechanics not encoded in repo metadata)

## A. Group build coverage
- Candidate grouped binary markets: 529
- Groups scanned (>=2 outcomes): 0
- Grouping-ambiguous markets skipped: 1

## B. Synchronized live book coverage
- YES-leg tokens requested from CLOB: 0
- Groups with usable synchronized books: 0

## C. Parity dislocations
- Opportunities found: 0
- Thin/noise flagged: 0
- Median estimated capacity: -

| group key | check | outcomes | sum | gross deviation | net deviation | min exec size | est capacity | thin/noise |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |

## D. Liquidity realism
- Thin/noise cutoff (capacity): 30
- Min executable size uses the smallest top-of-book size across relevant legs of the flagged check.
- Capacity is approximate and point-in-time only.

## E. Blunt conclusion
- evidence insufficient due to grouping ambiguity

## Limitations
- Grouping is metadata/heuristic-driven; imperfect grouping can cause false positives/negatives.
- Checks are partial parity checks (YES-sum variants), not guaranteed executable conversion paths.
- Snapshot is point-in-time; dislocations may vanish quickly.