# V2 Overlay-Only Performance

- Generated: 2026-03-31T12:30:44.786Z
- Overlay start detection: first trade with metadataJson.scoreProvenance.finalBandAwareScore
- Overlay start time: not_found
- Cohort rule: include only trades with finalBandAwareScore present OR createdAt >= overlayStart

## A. Cohort summary
- total opens: 0
- total closed: 0
- avg markout: -
- median markout: -
- win rate: -

## B. Performance by price band
| band | open count | closed count | avg markout | median markout | win rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| <0.1 | 0 | 0 | - | - | - |
| 0.1-0.2 | 0 | 0 | - | - | - |
| 0.2-0.3 | 0 | 0 | - | - | - |
| 0.3-0.4 | 0 | 0 | - | - | - |
| 0.4-0.6 | 0 | 0 | - | - | - |
| 0.6-0.8 | 0 | 0 | - | - | - |
| 0.8-0.9 | 0 | 0 | - | - | - |
| >=0.9 | 0 | 0 | - | - | - |

## C. Score bucket performance (finalBandAwareScore)
| score bucket | count | avg markout | median markout | win rate |
| --- | ---: | ---: | ---: | ---: |

## D. Top-vs-bottom comparison
- tails: 1 each; high avg markout=-, low avg markout=-, high win rate=-, low win rate=-

## E. In-band ranking check
| band | count | high-half avg markout | low-half avg markout | high-half win rate | low-half win rate | note |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| <0.1 | 0 | - | - | - | - | insufficient_sample |
| 0.1-0.2 | 0 | - | - | - | - | insufficient_sample |
| 0.2-0.3 | 0 | - | - | - | - | insufficient_sample |
| 0.3-0.4 | 0 | - | - | - | - | insufficient_sample |
| 0.4-0.6 | 0 | - | - | - | - | insufficient_sample |
| 0.6-0.8 | 0 | - | - | - | - | insufficient_sample |
| 0.8-0.9 | 0 | - | - | - | - | insufficient_sample |
| >=0.9 | 0 | - | - | - | - | insufficient_sample |

## F. Trade flow (available fields)
- latest tick at: 2026-03-31T12:27:32.643Z
- candidates loaded: 24
- candidates scored: 24
- trades opened: 0
- admission rate (opened/scored): 0.00%
- note: Only latest tick is persisted (no historical tick table).

## Sample size note
- Small sample (opens=0, closed=0); not statistically meaningful yet.
- Pre-overlay trades are excluded by cohort rule above.