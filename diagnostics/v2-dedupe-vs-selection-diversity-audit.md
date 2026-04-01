# V2 dedupe vs selection diversity audit

- Generated: 2026-04-01T11:45:22.367Z
- Window: 24 dry-run ticks, cadence 500ms
- Preferred funder hint: 0x443e0af9c2ccbedb60ff866b45afd91ca3999e69
- First tick funder used: 0x443e0af9c2ccbedb60ff866b45afd91ca3999e69; lookbackMinutes: 30

## Layer 1 — raw candidate rows
- Mean raw rows per tick: **58.67**
- Unique recommendationIds (window): **22**
- Unique marketId+side dedupe keys (window): **22**
- Unique markets (window): **22**
- Age distribution (minutes): p50 **28.94**, p90 **29.98**, max **30.08**

## Layer 2 — deduped winners (same semantics as loader)
- Mean deduped winners per tick: **22.00**
- Raw -> deduped compression ratio (mean): **0.375**
- Multi-row dedupe groups: **384**
- Groups with >1 recommendationId collapsed: **0** (0.0%)
- Groups with materially different metadata collapsed: **192** (50.0%)

### Collapse classification
```json
{
  "near-duplicate/noise": 192,
  "same market with materially different metadata": 192
}
```
### Top 20 heaviest-collapsed dedupe keys
```json
[
  {
    "key": "0xe202539dfbeced92dc4112f134a205c80ca6cf4db32bd82f05b291c297219fd8\u0000BUY",
    "totalRawRowsCollapsed": 144,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0.9089999999999999,
    "avgCollapsedPerTickSeen": 6
  },
  {
    "key": "0x543da007c2f149346cf9f9f21021f1b2e10c46c78fcd0c9297c0c21f10c94626\u0000BUY",
    "totalRawRowsCollapsed": 133,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0.9630000000000001,
    "avgCollapsedPerTickSeen": 5.541666666666667
  },
  {
    "key": "0x713641f745d71f6ec61f906237ffca3c8583f251e49384429a63ceb0ccdb2d37\u0000BUY",
    "totalRawRowsCollapsed": 120,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0.911,
    "avgCollapsedPerTickSeen": 5
  },
  {
    "key": "0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892\u0000BUY",
    "totalRawRowsCollapsed": 96,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0.673,
    "avgCollapsedPerTickSeen": 4
  },
  {
    "key": "0x30d55d8124ee1e12dabe89201badc45669b81dff69e4ce44d961f32878ec178a\u0000BUY",
    "totalRawRowsCollapsed": 96,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0.827,
    "avgCollapsedPerTickSeen": 4
  },
  {
    "key": "0xb6b3d7a2037b3faa7e1306d741840d453432902d73cc9a146a035e40271eae73\u0000BUY",
    "totalRawRowsCollapsed": 87,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0.6519999999999999,
    "avgCollapsedPerTickSeen": 3.625
  },
  {
    "key": "0xb76183fb9e7e80c5a8f983a87ceefd35c9c177f684dd001d7387dc7b70d596d6\u0000BUY",
    "totalRawRowsCollapsed": 72,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0,
    "avgCollapsedPerTickSeen": 3
  },
  {
    "key": "0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f\u0000BUY",
    "totalRawRowsCollapsed": 72,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0.8130000000000001,
    "avgCollapsedPerTickSeen": 3
  },
  {
    "key": "0x46dbd48d6bde5b81edb480e0f676a2cdda6c6b592c4d86a9367c7ad5a9870195\u0000BUY",
    "totalRawRowsCollapsed": 71,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0,
    "avgCollapsedPerTickSeen": 2.9583333333333335
  },
  {
    "key": "0x939eeb2dea216749bd409bedde483c3f2bfb0e24d4f2d34461c0b21c6e91f010\u0000BUY",
    "totalRawRowsCollapsed": 69,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0,
    "avgCollapsedPerTickSeen": 2.875
  },
  {
    "key": "0xfbf7ab9e6b6d324ffe436bab8c7a1e10aeb8200e10c1e1dbb35d2959becebc1e\u0000BUY",
    "totalRawRowsCollapsed": 64,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0,
    "avgCollapsedPerTickSeen": 2.6666666666666665
  },
  {
    "key": "0x4e65282819c98c6aed529f357fbf5983b1ae9407a3c25bd50fe97b2906df68f9\u0000BUY",
    "totalRawRowsCollapsed": 48,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0,
    "avgCollapsedPerTickSeen": 2
  },
  {
    "key": "0x7b52405ad0e0d31bfe970940b67d77f24ecedeab8a2361c11148c02a006e325c\u0000BUY",
    "totalRawRowsCollapsed": 48,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0.941,
    "avgCollapsedPerTickSeen": 2
  },
  {
    "key": "0xfda648d24cdad32dfe959195bd75ef4c81fbea5130eb6c7a4a0c18607a11ce63\u0000BUY",
    "totalRawRowsCollapsed": 48,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0,
    "avgCollapsedPerTickSeen": 2
  },
  {
    "key": "0x33a87d02fa01e958929385c74b8627d32cc4474e9ebd312d268865c5207147fa\u0000BUY",
    "totalRawRowsCollapsed": 48,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0,
    "avgCollapsedPerTickSeen": 2
  },
  {
    "key": "0x65307f30dce84ac35e41813035d3c04933da830dc4efbbb2fcdc4b282700ef3b\u0000BUY",
    "totalRawRowsCollapsed": 48,
    "ticksSeen": 24,
    "uniqueRecommendationIds": 1,
    "priceRange": 0,
    "avgCollapsedPerTickSeen": 2
  }
]
```

## Layer 3 — final selected pool (post-dedupe loader selection)
- Mean final selected per tick: **7.00**
- Deduped -> final compression ratio (mean): **0.318**
- Final-set signature count across ticks: **1** (1 means static/deterministic set)
- Mean consecutive-tick Jaccard (final winners): **1.000**
- Winners selected every tick: **7**
- Dedup winners never selected (window union): **15**
- Dedup winners present every tick but never selected: **15**

### Always-selected winner ids (sample)
```json
[
  "cmnfybqxm1utemhsq6zjw4kt6",
  "cmnfybrm31uuvmhsqgjrn9bl4",
  "cmnfybtri1uylmhsqsrklkwaz",
  "cmnfybuei1uzpmhsq7e3a91l4",
  "cmnfybwbe1v38mhsqt6u2s7m5",
  "cmnfyby9v1v6vmhsq4860eslz",
  "cmnfyc07p1vaxmhsqqfwtz24t"
]
```
### Always-dropped dedup winner ids (sample)
```json
[
  "cmnfyc24t1vesmhsqd3ktnm3u",
  "cmnfyc1hd1vdfmhsqi0okmh1a",
  "cmnfybzk21v9imhsqupf756au",
  "cmnfybywl1v85mhsq1dorkyvo",
  "cmnfybx041v4rmhsqu60l52ti",
  "cmnfybvoc1v1wmhsqko1f9t0u",
  "cmnfybsfw1uw0mhsq84r1iry1",
  "cmnfybq9x1urtmhsq7f0sih6x",
  "cmnfybpml1uq8mhsqua8zmo2g",
  "cmnfyar4s1tsimhsqkcaox6k5",
  "cmnfyapvm1tqcmhsqci9zk86y",
  "cmnfyap8z1toxmhsqx9lfgahb",
  "cmnfyaomx1tnumhsqnuiydpxr",
  "cmnfy9fzy1s9bmhsquyuecexh",
  "cmnfy9et71s7cmhsq9c7gkgkg"
]
```

## A. Diversity loss attribution
| metric | raw unique | dedup unique | final unique | loss raw->dedup | loss dedup->final | share of total loss at raw->dedup | share at dedup->final |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| recommendationIds | 22 | 22 | 7 | 0 | 15 | 0.0% | 100.0% |
| markets | 22 | 22 | 7 | 0 | 15 | 0.0% | 100.0% |
| marketId+side keys | 22 | 22 | 7 | 0 | 15 | 0.0% | 100.0% |

## B. Are dropped rows meaningfully different?
- Collapse classification uses recommendationId cardinality + price dispersion + snapshot thesis fields (strategyFamily/strategyVariant/hypothesisType) + timestamp spread.
- See `Collapse classification` and `Top 20 heaviest-collapsed dedupe keys` sections.

## C. Final-selection determinism
- Distinct final winner sets observed across 24 ticks: **1**
- Mean consecutive set-overlap (Jaccard): **1.000**
- Always-selected winner ids: **7**
- Always-dropped dedup winners (present each tick but never selected): **15**

## D. Good-band loss (0.2–0.3 and 0.4–0.6)
| band | raw count | deduped count | final selected count | loss raw->dedup | loss dedup->final | dominant loss stage |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 0.2-0.3 | 0 | 0 | 0 | 0 | 0 | tie |
| 0.4-0.6 | 0 | 0 | 0 | 0 | 0 | tie |

## E. Blunt conclusion
**diversity is mostly lost in final selection**

## JSON summary
```json
{
  "generatedAt": "2026-04-01T11:45:22.367Z",
  "ticks": 24,
  "cadenceMs": 500,
  "preferredFunder": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69",
  "firstTick": {
    "funderUsed": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69",
    "lookbackMinutes": 30
  },
  "layerAverages": {
    "rawAvg": 58.666666666666664,
    "dedupAvg": 22,
    "finalAvg": 7,
    "rawToDedupRatio": 0.375,
    "dedupToFinalRatio": 0.3181818181818182
  },
  "diversityUnique": {
    "recommendationIds": {
      "raw": 22,
      "dedup": 22,
      "final": 7
    },
    "markets": {
      "raw": 22,
      "dedup": 22,
      "final": 7
    },
    "marketSideKeys": {
      "raw": 22,
      "dedup": 22,
      "final": 7
    }
  },
  "attributionPct": {
    "recommendationIds": {
      "rawToDedup": 0,
      "dedupToFinal": 100
    },
    "markets": {
      "rawToDedup": 0,
      "dedupToFinal": 100
    },
    "marketSideKeys": {
      "rawToDedup": 0,
      "dedupToFinal": 100
    }
  },
  "collapse": {
    "groupsTotalMulti": 384,
    "groupsMultiReco": 0,
    "groupsMultiMeta": 192,
    "classification": {
      "near-duplicate/noise": 192,
      "same market with materially different metadata": 192
    },
    "top20HeaviestKeys": [
      {
        "key": "0xe202539dfbeced92dc4112f134a205c80ca6cf4db32bd82f05b291c297219fd8\u0000BUY",
        "totalRawRowsCollapsed": 144,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0.9089999999999999,
        "avgCollapsedPerTickSeen": 6
      },
      {
        "key": "0x543da007c2f149346cf9f9f21021f1b2e10c46c78fcd0c9297c0c21f10c94626\u0000BUY",
        "totalRawRowsCollapsed": 133,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0.9630000000000001,
        "avgCollapsedPerTickSeen": 5.541666666666667
      },
      {
        "key": "0x713641f745d71f6ec61f906237ffca3c8583f251e49384429a63ceb0ccdb2d37\u0000BUY",
        "totalRawRowsCollapsed": 120,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0.911,
        "avgCollapsedPerTickSeen": 5
      },
      {
        "key": "0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892\u0000BUY",
        "totalRawRowsCollapsed": 96,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0.673,
        "avgCollapsedPerTickSeen": 4
      },
      {
        "key": "0x30d55d8124ee1e12dabe89201badc45669b81dff69e4ce44d961f32878ec178a\u0000BUY",
        "totalRawRowsCollapsed": 96,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0.827,
        "avgCollapsedPerTickSeen": 4
      },
      {
        "key": "0xb6b3d7a2037b3faa7e1306d741840d453432902d73cc9a146a035e40271eae73\u0000BUY",
        "totalRawRowsCollapsed": 87,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0.6519999999999999,
        "avgCollapsedPerTickSeen": 3.625
      },
      {
        "key": "0xb76183fb9e7e80c5a8f983a87ceefd35c9c177f684dd001d7387dc7b70d596d6\u0000BUY",
        "totalRawRowsCollapsed": 72,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0,
        "avgCollapsedPerTickSeen": 3
      },
      {
        "key": "0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f\u0000BUY",
        "totalRawRowsCollapsed": 72,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0.8130000000000001,
        "avgCollapsedPerTickSeen": 3
      },
      {
        "key": "0x46dbd48d6bde5b81edb480e0f676a2cdda6c6b592c4d86a9367c7ad5a9870195\u0000BUY",
        "totalRawRowsCollapsed": 71,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0,
        "avgCollapsedPerTickSeen": 2.9583333333333335
      },
      {
        "key": "0x939eeb2dea216749bd409bedde483c3f2bfb0e24d4f2d34461c0b21c6e91f010\u0000BUY",
        "totalRawRowsCollapsed": 69,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0,
        "avgCollapsedPerTickSeen": 2.875
      },
      {
        "key": "0xfbf7ab9e6b6d324ffe436bab8c7a1e10aeb8200e10c1e1dbb35d2959becebc1e\u0000BUY",
        "totalRawRowsCollapsed": 64,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0,
        "avgCollapsedPerTickSeen": 2.6666666666666665
      },
      {
        "key": "0x4e65282819c98c6aed529f357fbf5983b1ae9407a3c25bd50fe97b2906df68f9\u0000BUY",
        "totalRawRowsCollapsed": 48,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0,
        "avgCollapsedPerTickSeen": 2
      },
      {
        "key": "0x7b52405ad0e0d31bfe970940b67d77f24ecedeab8a2361c11148c02a006e325c\u0000BUY",
        "totalRawRowsCollapsed": 48,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0.941,
        "avgCollapsedPerTickSeen": 2
      },
      {
        "key": "0xfda648d24cdad32dfe959195bd75ef4c81fbea5130eb6c7a4a0c18607a11ce63\u0000BUY",
        "totalRawRowsCollapsed": 48,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0,
        "avgCollapsedPerTickSeen": 2
      },
      {
        "key": "0x33a87d02fa01e958929385c74b8627d32cc4474e9ebd312d268865c5207147fa\u0000BUY",
        "totalRawRowsCollapsed": 48,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0,
        "avgCollapsedPerTickSeen": 2
      },
      {
        "key": "0x65307f30dce84ac35e41813035d3c04933da830dc4efbbb2fcdc4b282700ef3b\u0000BUY",
        "totalRawRowsCollapsed": 48,
        "ticksSeen": 24,
        "uniqueRecommendationIds": 1,
        "priceRange": 0,
        "avgCollapsedPerTickSeen": 2
      }
    ]
  },
  "determinism": {
    "finalSignatureCount": 1,
    "avgConsecutiveJaccard": 1,
    "selectedEveryTickCount": 7,
    "dedupNeverSelectedCount": 15,
    "dedupAlwaysDroppedCount": 15,
    "selectedEveryTickSample": [
      "cmnfybqxm1utemhsq6zjw4kt6",
      "cmnfybrm31uuvmhsqgjrn9bl4",
      "cmnfybtri1uylmhsqsrklkwaz",
      "cmnfybuei1uzpmhsq7e3a91l4",
      "cmnfybwbe1v38mhsqt6u2s7m5",
      "cmnfyby9v1v6vmhsq4860eslz",
      "cmnfyc07p1vaxmhsqqfwtz24t"
    ],
    "dedupAlwaysDroppedSample": [
      "cmnfyc24t1vesmhsqd3ktnm3u",
      "cmnfyc1hd1vdfmhsqi0okmh1a",
      "cmnfybzk21v9imhsqupf756au",
      "cmnfybywl1v85mhsq1dorkyvo",
      "cmnfybx041v4rmhsqu60l52ti",
      "cmnfybvoc1v1wmhsqko1f9t0u",
      "cmnfybsfw1uw0mhsq84r1iry1",
      "cmnfybq9x1urtmhsq7f0sih6x",
      "cmnfybpml1uq8mhsqua8zmo2g",
      "cmnfyar4s1tsimhsqkcaox6k5",
      "cmnfyapvm1tqcmhsqci9zk86y",
      "cmnfyap8z1toxmhsqx9lfgahb",
      "cmnfyaomx1tnumhsqnuiydpxr",
      "cmnfy9fzy1s9bmhsquyuecexh",
      "cmnfy9et71s7cmhsq9c7gkgkg"
    ]
  },
  "goodBands": [
    {
      "band": "0.2-0.3",
      "raw": 0,
      "deduped": 0,
      "final": 0,
      "lossRawToDedup": 0,
      "lossDedupToFinal": 0
    },
    {
      "band": "0.4-0.6",
      "raw": 0,
      "deduped": 0,
      "final": 0,
      "lossRawToDedup": 0,
      "lossDedupToFinal": 0
    }
  ],
  "bluntConclusion": "diversity is mostly lost in final selection"
}
```