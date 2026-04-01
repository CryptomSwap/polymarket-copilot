# V2 ShadowCandidate generation audit

- Generated: 2026-04-01T11:07:45.283Z
- Loader-equivalent filter: wasSubmitted=true, wasBlocked=false, candidateSource=runtime_automated
- Funder used for B–D (scoped): `0x443e0af9c2ccbedb60ff866b45afd91ca3999e69` — set `SHADOW_AUDIT_FUNDER` to override discovery
- Config `shadowLookbackMinutes` (loader): **30**

## A. Ingestion rate
### A.1 All funders (loader filter, no funder constraint)
| window | new rows | rate / minute |
| --- | ---: | ---: |
| last 1 min | 20 | 20.0000 |
| last 5 min | 100 | 20.0000 |
| last 15 min | 300 | 20.0000 |
| last 1 hour | 987 | 16.4500 |

### A.2 Scoped funder (same as B–D)
| window | new rows | rate / minute |
| --- | ---: | ---: |
| last 1 min | 20 | 20.0000 |
| last 5 min | 100 | 20.0000 |
| last 15 min | 300 | 20.0000 |
| last 1 hour | 987 | 16.4500 |

### Top funders by row count in current lookback window
```json
[
  {
    "funderAddress": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69",
    "count": 547
  }
]
```

## B. Timestamp distribution (rows in loader lookback query, max 500, `createdAt` desc)
- rows in lookback matching filter **all funders**: **547** (scoped raw: 500)
- raw rows returned (scoped): 500
- age of row at audit time (raw rows):
```json
{
  "<1 min": 20,
  "1–5 min": 80,
  "5–15 min": 200,
  "15–60 min": 200,
  ">60 min": 0
}
```
- age histogram for **deduped winners** (newest-first per marketId+side, skip rows without marketId):
```json
{
  "<1 min": 16,
  "1–5 min": 22,
  "5–15 min": 3,
  "15–60 min": 21,
  ">60 min": 0
}
```

## C. Lookback window effect
- lookback duration: **30 min**
- “newest 10% of window” = createdAt ≥ now − 3.00 min: **48.4%** of deduped pool (30/62)
- “oldest 50% of window” = createdAt ≤ now − 15.00 min: **33.9%** of deduped pool (21/62)
- rows dropped by **marketId+side** dedupe (older / duplicate keys in the 500-row pull): **438** (extra raw rows not winning their key)
- rows skipped (no resolvable marketId): **0**

## D. Deduping effect
- raw rows in lookback slice: **500**
- deduped pool (unique marketId+side with winners): **62**
- raw / deduped ratio: **8.065**
- distinct `recommendationId` values in raw slice (nulls keyed as `(null:id)`): **110**
- `recommendationId` groups with >1 row: **65**; extra rows beyond first per id: **390**
- distinct reco ids on winning rows only: **62** (vs 110 in raw slice)

## E. Blunt conclusion
- **dedupe collapsing new data**

## JSON summary
```json
{
  "generatedAt": "2026-04-01T11:07:45.283Z",
  "funder": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69",
  "lookbackMinutes": 30,
  "ingestionGlobalAllFunders": [
    {
      "label": "last 1 min",
      "count": 20,
      "ratePerMinute": 20
    },
    {
      "label": "last 5 min",
      "count": 100,
      "ratePerMinute": 20
    },
    {
      "label": "last 15 min",
      "count": 300,
      "ratePerMinute": 20
    },
    {
      "label": "last 1 hour",
      "count": 987,
      "ratePerMinute": 16.45
    }
  ],
  "ingestionScopedFunder": [
    {
      "label": "last 1 min",
      "count": 20,
      "ratePerMinute": 20
    },
    {
      "label": "last 5 min",
      "count": 100,
      "ratePerMinute": 20
    },
    {
      "label": "last 15 min",
      "count": 300,
      "ratePerMinute": 20
    },
    {
      "label": "last 1 hour",
      "count": 987,
      "ratePerMinute": 16.45
    }
  ],
  "topFundersInLookbackWindow": [
    {
      "funderAddress": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69",
      "count": 547
    }
  ],
  "funderNotes": [],
  "globalLookbackCount": 547,
  "globalLookbackSampleHistogramWhenScopedEmpty": null,
  "lookbackQueryRawRows": 500,
  "ageHistogramRaw": {
    "<1 min": 20,
    "1–5 min": 80,
    "5–15 min": 200,
    "15–60 min": 200,
    ">60 min": 0
  },
  "dedupedPoolSize": 62,
  "ageHistogramDedupedWinners": {
    "<1 min": 16,
    "1–5 min": 22,
    "5–15 min": 3,
    "15–60 min": 21,
    ">60 min": 0
  },
  "lookbackEffect": {
    "pctDedupedInNewest10PctOfWindow": 48.38709677419355,
    "pctDedupedInOldest50PctOfWindow": 33.87096774193548,
    "droppedByMarketSideDedupe": 438,
    "skippedNoMarket": 0
  },
  "dedupe": {
    "rawToDedupedRatio": 8.064516129032258,
    "recommendationIdGroupsWithMultipleRows": 65,
    "extraRowsFromRecommendationIdDuplicates": 390,
    "distinctRawRecommendationKeys": 110,
    "distinctRecommendationIdsOnWinners": 62
  },
  "conclusion": "dedupe collapsing new data"
}
```