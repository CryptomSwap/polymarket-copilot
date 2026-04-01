# V2 candidate reservoir churn audit

- Generated: 2026-03-31T22:53:03.162Z
- Window: 24 dry-run ticks, cadence 500ms
- Note: upstream “before expansion” set is re-fetched after each tick via `getSubmittedShadowCandidatesForTickWithDiagnostics` with the same funder/lookback the tick used; tiny drift possible if new ShadowCandidate rows land between calls.

## A. Reservoir freshness (final selected pool per tick — unique `recommendationId` in trace)
- total unique recommendationIds across window: 36
- union of upstream (deduped) recommendationIds across refetches: 66
- appearance count buckets (how many ticks each id is present in final pool):
  - exactly 1 tick: 0 (0.0%)
  - 2–5 ticks: 0 (0.0%)
  - 6–12 ticks: 0 (0.0%)
  - >12 ticks: 36 (100.0%)
- median tick appearances per id: 24.0

### First-seen tick index (count of ids whose first final appearance is that tick)
```json
{
  "0": 36
}
```

### Last-seen tick index
```json
{
  "23": 36
}
```

## B. Loader churn (final pool, consecutive ticks)
- mean Jaccard similarity (t-1 vs t): 1.0000
- mean |intersection| prev∩curr: 36.00
- mean new recommendationIds vs previous tick: 0.00
- per-tick new ids (tick 0 = full set size): [36,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
- per-tick Jaccard (from tick 1): [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]

## C. Upstream source churn (before vs after mid-range expansion)
- mean upstream deduped pool size (refetch): 66.00; mean final selected size (trace unique): 36.00
- mean fraction of upstream recommendationIds **not** in final pool (expansion/filter drop): 45.45%
- per-tick: upstream unique | final unique | dropped count | expansionBreadth.before→after when present
| tick | upstream | final | dropped | before|after exp |
| --- | ---: | ---: | ---: | --- |
| 0 | 66 | 36 | 30 | 66→36 |
| 1 | 66 | 36 | 30 | 66→36 |
| 2 | 66 | 36 | 30 | 66→36 |
| 3 | 66 | 36 | 30 | 66→36 |
| 4 | 66 | 36 | 30 | 66→36 |
| 5 | 66 | 36 | 30 | 66→36 |
| 6 | 66 | 36 | 30 | 66→36 |
| 7 | 66 | 36 | 30 | 66→36 |
| 8 | 66 | 36 | 30 | 66→36 |
| 9 | 66 | 36 | 30 | 66→36 |
| 10 | 66 | 36 | 30 | 66→36 |
| 11 | 66 | 36 | 30 | 66→36 |
| 12 | 66 | 36 | 30 | 66→36 |
| 13 | 66 | 36 | 30 | 66→36 |
| 14 | 66 | 36 | 30 | 66→36 |
| 15 | 66 | 36 | 30 | 66→36 |
| 16 | 66 | 36 | 30 | 66→36 |
| 17 | 66 | 36 | 30 | 66→36 |
| 18 | 66 | 36 | 30 | 66→36 |
| 19 | 66 | 36 | 30 | 66→36 |
| 20 | 66 | 36 | 30 | 66→36 |
| 21 | 66 | 36 | 30 | 66→36 |
| 22 | 66 | 36 | 30 | 66→36 |
| 23 | 66 | 36 | 30 | 66→36 |

## D. Good-band churn (0.4–0.6 and 0.2–0.3)
- **Final-pool good bands** use `recommendationId` → `shadowBand` only when present on `scoreProvenanceSample` (same partial coverage as breadth audit when the provenance sample is smaller than the full scored set). Upstream good bands use intended entry price on every deduped row.
### 0.4-0.6
- unique markets in final trace across window: 2
- mean markets per tick (final): 2
- mean tick-to-tick overlap (count of markets in both t-1 and t): 2.00
- upstream (refetch) unique markets across window: 3
- per-market appearance ticks (median): 24.0; counts by appearances: {"24":2}
- sample (marketId → firstSeenTick): {"0x32b09f6390252b37d674501527e709016d55581b2c1e544bd4b8167f5f732f4c":0,"0x50ddb9cd80d5c271664a2ebb7fcaed1d0a148d82c8e8d314d830f75a944c3dcc":0}

### 0.2-0.3
- unique markets in final trace across window: 0
- mean markets per tick (final): 0
- mean tick-to-tick overlap (count of markets in both t-1 and t): 0.00
- upstream (refetch) unique markets across window: 1
- per-market appearance ticks (median): n/a; counts by appearances: {}
- sample (marketId → firstSeenTick): {}

## E. Blunt conclusion
- **upstream recommendation pool is static**

## JSON summary
```json
{
  "generatedAt": "2026-03-31T22:53:03.162Z",
  "window": {
    "ticks": 24,
    "cadenceMs": 500
  },
  "reservoirFreshness": {
    "uniqueFinalRecIdsWindow": 36,
    "unionUpstreamRecIds": 66,
    "persistBuckets": {
      "exactly1": 0,
      "ticks2to5": 0,
      "ticks6to12": 0,
      "ticksGt12": 36
    },
    "medianAppearances": 24,
    "firstSeenHist": {
      "0": 36
    },
    "lastSeenHist": {
      "23": 36
    }
  },
  "loaderChurn": {
    "meanJaccardConsecutive": 1,
    "meanIntersection": 36,
    "meanNewVsPrev": 0,
    "newPerTick": [
      36,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0
    ],
    "jaccardPerStep": [
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1
    ]
  },
  "upstreamVsFinal": {
    "meanUpstreamSize": 66,
    "meanFinalSize": 36,
    "meanFractionUpstreamDropped": 0.45454545454545453,
    "perTick": [
      {
        "tick": 0,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 1,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 2,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 3,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 4,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 5,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 6,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 7,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 8,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 9,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 10,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 11,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 12,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 13,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 14,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 15,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 16,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 17,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 18,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 19,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 20,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 21,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 22,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      },
      {
        "tick": 23,
        "upstream": 66,
        "final": 36,
        "dropped": 30,
        "beforeExpansion": 66,
        "afterExpansion": 36
      }
    ]
  },
  "goodBands": {
    "0.4-0.6": {
      "uniqueMarketsWindow": 2,
      "meanOverlapTickToTick": 2
    },
    "0.2-0.3": {
      "uniqueMarketsWindow": 0,
      "meanOverlapTickToTick": 0
    }
  },
  "conclusion": "upstream recommendation pool is static",
  "warnings": []
}
```