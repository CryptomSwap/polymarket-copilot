# V2 post-dedupe stage clarity audit

- Generated: 2026-04-01T12:38:55.697Z
- Window: 24 dry-run ticks, cadence 500ms
- Preferred funder hint: 0x443e0af9c2ccbedb60ff866b45afd91ca3999e69
- Env PAPER_SHADOW_DEDUPE_PREFER_GOOD_BANDS: 1

## A. Stage definitions
- `raw`: all runtime_automated submitted/unblocked rows in lookback (up to 500, newest-first)
- `groupedByKey`: raw rows that have a resolvable dedupe key (`marketId+side`), before any winner selection
- `winnersBeforePreference`: one winner per dedupe key using current legacy semantics (newest row wins)
- `winnersAfterPreference`: one winner per dedupe key using good-band preference (0.2-0.3, then 0.4-0.6, else newest)
- `finalSelected`: output of `loadShadowCandidatesForPaperTick` after downstream selection/bias steps

## B. Counts by stage and band
| stage | total rows | 0.2-0.3 rows | 0.2-0.3 unique markets | 0.4-0.6 rows | 0.4-0.6 unique markets |
| --- | ---: | ---: | ---: | ---: | ---: |
| raw | 12000 | 264 | 1 | 0 | 0 |
| groupedByKey | 12000 | 264 | 1 | 0 | 0 |
| winnersBeforePreference | 984 | 0 | 0 | 0 | 0 |
| winnersAfterPreference | 984 | 24 | 1 | 0 | 0 |
| finalSelected | 312 | 24 | 1 | 0 | 0 |

## C. Winner-choice impact
- dedupe keys evaluated: **984**
- keys with winner changed by preference: **24**
- changed winner band transitions:
```json
{
  "0.6-0.8 -> 0.2-0.3": 24
}
```

## D. Stage-entry / stage-disappearance for target bands
- 0.2-0.3 first appears at stage: **raw**
- 0.2-0.3 first missing stage: **winnersBeforePreference**
- 0.4-0.6 first appears at stage: **never**
- 0.4-0.6 first missing stage: **raw**

## E. Interpretation
- 0.2-0.3 now enters at dedupe winner selection stage via preference: winnersBefore=0, winnersAfter=24.
- 0.4-0.6 absence is upstream supply absence (raw=0), not a downstream selection drop.
- At least one existing audit likely mislabels pre-vs-post preference dedupe winners (shows deduped 0.2-0.3=0 while final 0.2-0.3>0).

## F. Blunt conclusion
**winner preference fixes 0.2-0.3 at dedupe, but broader good-band scarcity is upstream supply (0.4-0.6 missing at raw)**

