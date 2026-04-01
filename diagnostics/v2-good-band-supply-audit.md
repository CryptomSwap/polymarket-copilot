# V2 good-band supply audit

- Generated: 2026-04-01T12:24:45.927Z
- Window: 24 dry-run ticks, cadence 500ms
- Preferred funder hint: 0x443e0af9c2ccbedb60ff866b45afd91ca3999e69

## A. Raw live ShadowCandidate supply
| band | raw count | raw share | unique markets | unique recommendationIds |
| --- | ---: | ---: | ---: | ---: |
| <0.1 | 2112 | 17.60% | 9 | 25 |
| 0.1-0.2 | 984 | 8.20% | 5 | 12 |
| 0.2-0.3 | 264 | 2.20% | 1 | 2 |
| 0.3-0.4 | 0 | 0.00% | 0 | 0 |
| 0.4-0.6 | 0 | 0.00% | 0 | 0 |
| 0.6-0.8 | 240 | 2.00% | 1 | 2 |
| 0.8-0.9 | 792 | 6.60% | 4 | 9 |
| >=0.9 | 7608 | 63.40% | 35 | 86 |
| unknown | 0 | 0.00% | 0 | 0 |

### Raw age distribution by band
```json
{
  "<0.1": {
    ">=30m": 2112
  },
  "0.1-0.2": {
    ">=30m": 984
  },
  "0.2-0.3": {
    ">=30m": 264
  },
  "0.3-0.4": {},
  "0.4-0.6": {},
  "0.6-0.8": {
    ">=30m": 240
  },
  "0.8-0.9": {
    ">=30m": 792
  },
  ">=0.9": {
    ">=30m": 7608
  },
  "unknown": {}
}
```

## B. Deduped winners by band
| band | deduped count | deduped share | unique markets | raw->dedup drop |
| --- | ---: | ---: | ---: | ---: |
| <0.1 | 144 | 14.63% | 6 | 1968 |
| 0.1-0.2 | 72 | 7.32% | 3 | 912 |
| 0.2-0.3 | 0 | 0.00% | 0 | 264 |
| 0.3-0.4 | 0 | 0.00% | 0 | 0 |
| 0.4-0.6 | 0 | 0.00% | 0 | 0 |
| 0.6-0.8 | 24 | 2.44% | 1 | 216 |
| 0.8-0.9 | 48 | 4.88% | 2 | 744 |
| >=0.9 | 696 | 70.73% | 29 | 6912 |
| unknown | 0 | 0.00% | 0 | 0 |

### Deduped age distribution by band
```json
{
  "<0.1": {
    ">=30m": 144
  },
  "0.1-0.2": {
    ">=30m": 72
  },
  "0.2-0.3": {},
  "0.3-0.4": {},
  "0.4-0.6": {},
  "0.6-0.8": {
    ">=30m": 24
  },
  "0.8-0.9": {
    ">=30m": 48
  },
  ">=0.9": {
    ">=30m": 696
  },
  "unknown": {}
}
```

## C. Final selected by band
| band | final count | final share | unique markets | deduped->final drop |
| --- | ---: | ---: | ---: | ---: |
| <0.1 | 144 | 46.15% | 6 | 0 |
| 0.1-0.2 | 72 | 23.08% | 3 | 0 |
| 0.2-0.3 | 24 | 7.69% | 1 | 0 |
| 0.3-0.4 | 0 | 0.00% | 0 | 0 |
| 0.4-0.6 | 0 | 0.00% | 0 | 0 |
| 0.6-0.8 | 0 | 0.00% | 0 | 24 |
| 0.8-0.9 | 24 | 7.69% | 1 | 24 |
| >=0.9 | 48 | 15.38% | 2 | 648 |
| unknown | 0 | 0.00% | 0 | 0 |

## D. Good-band attribution
### Band 0.2-0.3
- raw count: **264**
- deduped count: **0**
- final count: **24**
- dominant loss stage: **raw->deduped**
- top raw markets: `[["0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",264]]`
- top deduped markets: `[]`
- top final markets: `[["0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",24]]`
- freshness raw: `{">=30m":264}`
- freshness deduped: `{}`

### Band 0.4-0.6
- raw count: **0**
- deduped count: **0**
- final count: **0**
- dominant loss stage: **tie**
- top raw markets: `[]`
- top deduped markets: `[]`
- top final markets: `[]`
- freshness raw: `{}`
- freshness deduped: `{}`

## E. Blunt conclusion
**good bands are lost mostly in dedupe**

## JSON summary
```json
{
  "generatedAt": "2026-04-01T12:24:45.927Z",
  "ticks": 24,
  "cadenceMs": 500,
  "preferredFunder": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69",
  "totals": {
    "raw": 12000,
    "deduped": 984,
    "final": 312
  },
  "counts": {
    "raw": {
      "<0.1": 2112,
      "0.1-0.2": 984,
      "0.2-0.3": 264,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 240,
      "0.8-0.9": 792,
      ">=0.9": 7608,
      "unknown": 0
    },
    "deduped": {
      "<0.1": 144,
      "0.1-0.2": 72,
      "0.2-0.3": 0,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 24,
      "0.8-0.9": 48,
      ">=0.9": 696,
      "unknown": 0
    },
    "final": {
      "<0.1": 144,
      "0.1-0.2": 72,
      "0.2-0.3": 24,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 0,
      "0.8-0.9": 24,
      ">=0.9": 48,
      "unknown": 0
    }
  },
  "uniqueMarkets": {
    "raw": {
      "<0.1": 9,
      "0.1-0.2": 5,
      "0.2-0.3": 1,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 1,
      "0.8-0.9": 4,
      ">=0.9": 35,
      "unknown": 0
    },
    "deduped": {
      "<0.1": 6,
      "0.1-0.2": 3,
      "0.2-0.3": 0,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 1,
      "0.8-0.9": 2,
      ">=0.9": 29,
      "unknown": 0
    },
    "final": {
      "<0.1": 6,
      "0.1-0.2": 3,
      "0.2-0.3": 1,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 0,
      "0.8-0.9": 1,
      ">=0.9": 2,
      "unknown": 0
    }
  },
  "uniqueRecommendationIdsRaw": {
    "<0.1": 25,
    "0.1-0.2": 12,
    "0.2-0.3": 2,
    "0.3-0.4": 0,
    "0.4-0.6": 0,
    "0.6-0.8": 2,
    "0.8-0.9": 9,
    ">=0.9": 86,
    "unknown": 0
  },
  "ageByBandRaw": {
    "<0.1": {
      ">=30m": 2112
    },
    "0.1-0.2": {
      ">=30m": 984
    },
    "0.2-0.3": {
      ">=30m": 264
    },
    "0.3-0.4": {},
    "0.4-0.6": {},
    "0.6-0.8": {
      ">=30m": 240
    },
    "0.8-0.9": {
      ">=30m": 792
    },
    ">=0.9": {
      ">=30m": 7608
    },
    "unknown": {}
  },
  "ageByBandDeduped": {
    "<0.1": {
      ">=30m": 144
    },
    "0.1-0.2": {
      ">=30m": 72
    },
    "0.2-0.3": {},
    "0.3-0.4": {},
    "0.4-0.6": {},
    "0.6-0.8": {
      ">=30m": 24
    },
    "0.8-0.9": {
      ">=30m": 48
    },
    ">=0.9": {
      ">=30m": 696
    },
    "unknown": {}
  },
  "dropRawToDedupByBand": {
    "<0.1": 1968,
    "0.1-0.2": 912,
    "0.2-0.3": 264,
    "0.3-0.4": 0,
    "0.4-0.6": 0,
    "0.6-0.8": 216,
    "0.8-0.9": 744,
    ">=0.9": 6912,
    "unknown": 0
  },
  "dropDedupToFinalByBand": {
    "<0.1": 0,
    "0.1-0.2": 0,
    "0.2-0.3": 0,
    "0.3-0.4": 0,
    "0.4-0.6": 0,
    "0.6-0.8": 24,
    "0.8-0.9": 24,
    ">=0.9": 648,
    "unknown": 0
  },
  "goodBands": {
    "0.2-0.3": {
      "raw": 264,
      "deduped": 0,
      "final": 24,
      "dominantLossStage": "raw->deduped",
      "topRawMarkets": [
        [
          "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
          264
        ]
      ],
      "topDedupedMarkets": [],
      "topFinalMarkets": [
        [
          "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
          24
        ]
      ]
    },
    "0.4-0.6": {
      "raw": 0,
      "deduped": 0,
      "final": 0,
      "dominantLossStage": "tie",
      "topRawMarkets": [],
      "topDedupedMarkets": [],
      "topFinalMarkets": []
    }
  },
  "bluntConclusion": "good bands are lost mostly in dedupe"
}
```