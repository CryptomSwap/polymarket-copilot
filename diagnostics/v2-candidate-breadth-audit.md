# V2 candidate breadth audit

- Generated: 2026-04-01T13:59:20.779Z
- Window: 24 dry-run ticks, cadence 500ms
- Open V2 positions used for novelty: 0

## A. Breadth of candidate generation
- total raw candidates (sum of `candidatesLoaded` per tick): 312
- mean raw candidates per tick: 13.00
- mean unique recommendationIds evaluated per tick (from trace): 13.00
- recommendation turnover ratio (mean unique recs / mean loaded): 1.0000
- cross-tick recommendation diversity (unique recs / sum of raw loads): 0.0417 — if the same K recs appear every tick this ratio stays ≈ 1/ticks even when K is large; also compare uniqueRecs vs meanLoadedPerTick below
- uniqueRecs / meanLoadedPerTick (window): 1.0000 — near 1.0 with low totalRecs implies a static per-tick pool, not tick-to-tick rotation
- total trace rows (bot×candidate evaluations): 936
- unique recommendationIds (across window): 13
- unique assetIds: 13
- unique markets: 13
- unique assetId|side pairs: 13
- unique botType|assetId|side keys: 39
- rows by shadow price band (from score provenance):
{
  "<0.1": 288,
  "0.1-0.2": 144,
  "0.2-0.3": 0,
  "0.3-0.4": 0,
  "0.4-0.6": 0,
  "0.6-0.8": 72,
  "0.8-0.9": 72,
  ">=0.9": 144,
  "unknown": 216
}
- unique assetIds by band:
{
  "<0.1": 4,
  "0.1-0.2": 2,
  "0.2-0.3": 0,
  "0.3-0.4": 0,
  "0.4-0.6": 0,
  "0.6-0.8": 1,
  "0.8-0.9": 1,
  ">=0.9": 2,
  "unknown": 3
}
- unique markets by band:
{
  "<0.1": 4,
  "0.1-0.2": 2,
  "0.2-0.3": 0,
  "0.3-0.4": 0,
  "0.4-0.6": 0,
  "0.6-0.8": 1,
  "0.8-0.9": 1,
  ">=0.9": 2,
  "unknown": 3
}
- unique assetId|side pairs by band:
{
  "<0.1": 4,
  "0.1-0.2": 2,
  "0.2-0.3": 0,
  "0.3-0.4": 0,
  "0.4-0.6": 0,
  "0.6-0.8": 1,
  "0.8-0.9": 1,
  ">=0.9": 2,
  "unknown": 3
}

## B. Novelty relative to open inventory
- all trace rows — already-open: 0 (0.00%), novel: 936 (100.00%)
- eligible trace rows — already-open: 0 (0.00%), novel: 144 (100.00%)  [eligible if any bot row for that recommendation admits or fails after threshold/liquidity, same operational definition as open-exposure novelty audit]
- eligible rows by band × botType (alreadyOpen / novel):
  - **0.6-0.8**: {"strict_quality":{"open":0,"novel":24},"relaxed_edge":{"open":0,"novel":24},"tail_extremes":{"open":0,"novel":24}}
  - **>=0.9**: {"strict_quality":{"open":0,"novel":24},"relaxed_edge":{"open":0,"novel":24},"tail_extremes":{"open":0,"novel":24}}

## C. Repetition concentration
- top-5 assetId|side pairs share of trace rows: 38.46%
- top-10 assetId|side pairs share of trace rows: 76.92%
- top-5 markets share of trace rows: 38.46%

### Top assetId|side pairs
| assetId|side | rows |
| --- | ---: |
| 102227184035967850089766981958743064457339118173548431660886438726896222843254|BUY | 72 |
| 108233603819467706476318984012158651931658302669301887462181073562758483842092|BUY | 72 |
| 98250445447699368679516529207365255018790721464590833209064266254238063117329|BUY | 72 |
| 20257190540739490630509657713144742134547949967093643458458133445357169845406|BUY | 72 |
| 80136419076132148090526858778468252473966514781048966836641001333641477735657|BUY | 72 |
| 18812649149814341758733697580460697418474693998558159483117100240528657629879|BUY | 72 |
| 70071592420137476676935286377781779672157004436137616627487590484756055232944|BUY | 72 |
| 60447443643099453130956385288904175887233107411078568881602330835010340506057|BUY | 72 |
| 26468656392978559668331516709623917078428425933265692717836103090220693717685|BUY | 72 |
| 112680630004798425069810935278212000865453267506345451433803052322987302357330|BUY | 72 |
| 17229559412398170618704225341353811929634795955092110836823940954753499964583|BUY | 72 |
| 15377800909339117478848654529132462257649986576758444132279677343865329475931|BUY | 72 |
| 87854174148074652060467921081181402357467303721471806610111179101805869578687|BUY | 72 |

### Top markets (marketId)
| marketId | rows |
| --- | ---: |
| 0xb6b3d7a2037b3faa7e1306d741840d453432902d73cc9a146a035e40271eae73 | 72 |
| 0x9b6fef249040fd17e9c107955b37ac2c3e923509b6b0ff01cc463a331ddeb894 | 72 |
| 0x4567b275e6b667a6217f5cb4f06a797d3a1eaf1d0281fb5bc8c75e2046ae7e57 | 72 |
| 0x713641f745d71f6ec61f906237ffca3c8583f251e49384429a63ceb0ccdb2d37 | 72 |
| 0x543da007c2f149346cf9f9f21021f1b2e10c46c78fcd0c9297c0c21f10c94626 | 72 |
| 0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f | 72 |
| 0x74dba1ce1ae9dd535414e85f2d9ab5ea32c0fb1acc9b7130b67e6d91217e24e1 | 72 |
| 0x7b52405ad0e0d31bfe970940b67d77f24ecedeab8a2361c11148c02a006e325c | 72 |
| 0x1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9 | 72 |
| 0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892 | 72 |
| 0xe202539dfbeced92dc4112f134a205c80ca6cf4db32bd82f05b291c297219fd8 | 72 |
| 0xb76183fb9e7e80c5a8f983a87ceefd35c9c177f684dd001d7387dc7b70d596d6 | 72 |
| 0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75 | 72 |

## D. Good-band breadth (0.4–0.6 and 0.2–0.3)
### Band 0.4-0.6
- trace rows (evaluations): 0
- unique markets: 0
- already-open share: 0.00%
- novel share: 0.00%
- score distribution (resolved): n=0, min=0.0000, p25=-, p50=-, p75=-, max=0.0000, mean=0.0000, std=0.0000
- proxy quality (band mean markout12h from recent closed V2 trades): 0.012194

### Band 0.2-0.3
- trace rows (evaluations): 0
- unique markets: 0
- already-open share: 0.00%
- novel share: 0.00%
- score distribution (resolved): n=0, min=0.0000, p25=-, p50=-, p75=-, max=0.0000, mean=0.0000, std=0.0000
- proxy quality (band mean markout12h from recent closed V2 trades): 2.178546

## E. Blunt conclusion
- **evidence insufficient**

## JSON summary
```json
{
  "generatedAt": "2026-04-01T13:59:20.779Z",
  "window": {
    "ticks": 24,
    "cadenceMs": 500
  },
  "openV2Positions": 0,
  "breadth": {
    "totalRawCandidatesSum": 312,
    "meanLoadedPerTick": 13,
    "meanUniqueRecPerTick": 13,
    "recTurnoverRatio": 1,
    "crossTickRecDiversity": 0.041666666666666664,
    "uniqueRecsOverMeanLoadedPerTick": 1,
    "totalTraceRows": 936,
    "uniqueRecs": 13,
    "uniqueAssetIds": 13,
    "uniqueMarkets": 13,
    "uniqueAssetSidePairs": 13,
    "uniqueBotAssetSideKeys": 39,
    "rowsByBand": {
      "<0.1": 288,
      "0.1-0.2": 144,
      "0.2-0.3": 0,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 72,
      "0.8-0.9": 72,
      ">=0.9": 144,
      "unknown": 216
    },
    "uniqueAssetsByBand": {
      "<0.1": 4,
      "0.1-0.2": 2,
      "0.2-0.3": 0,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 1,
      "0.8-0.9": 1,
      ">=0.9": 2,
      "unknown": 3
    },
    "uniqueMarketsByBand": {
      "<0.1": 4,
      "0.1-0.2": 2,
      "0.2-0.3": 0,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 1,
      "0.8-0.9": 1,
      ">=0.9": 2,
      "unknown": 3
    },
    "uniqueAssetSideByBand": {
      "<0.1": 4,
      "0.1-0.2": 2,
      "0.2-0.3": 0,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 1,
      "0.8-0.9": 1,
      ">=0.9": 2,
      "unknown": 3
    }
  },
  "noveltyVsOpen": {
    "allRows": {
      "alreadyOpen": 0,
      "novel": 936,
      "alreadyOpenShare": 0,
      "novelShare": 1
    },
    "eligibleRows": {
      "total": 144,
      "alreadyOpen": 0,
      "novel": 144,
      "alreadyOpenShare": 0,
      "novelShare": 1
    },
    "eligibleByBandBot": {
      ">=0.9": {
        "strict_quality": {
          "open": 0,
          "novel": 24
        },
        "relaxed_edge": {
          "open": 0,
          "novel": 24
        },
        "tail_extremes": {
          "open": 0,
          "novel": 24
        }
      },
      "0.6-0.8": {
        "strict_quality": {
          "open": 0,
          "novel": 24
        },
        "relaxed_edge": {
          "open": 0,
          "novel": 24
        },
        "tail_extremes": {
          "open": 0,
          "novel": 24
        }
      }
    }
  },
  "concentration": {
    "pairTop5Share": 0.38461538461538464,
    "pairTop10Share": 0.7692307692307693,
    "marketTop5Share": 0.38461538461538464,
    "topPairs": [
      [
        "102227184035967850089766981958743064457339118173548431660886438726896222843254|BUY",
        72
      ],
      [
        "108233603819467706476318984012158651931658302669301887462181073562758483842092|BUY",
        72
      ],
      [
        "98250445447699368679516529207365255018790721464590833209064266254238063117329|BUY",
        72
      ],
      [
        "20257190540739490630509657713144742134547949967093643458458133445357169845406|BUY",
        72
      ],
      [
        "80136419076132148090526858778468252473966514781048966836641001333641477735657|BUY",
        72
      ],
      [
        "18812649149814341758733697580460697418474693998558159483117100240528657629879|BUY",
        72
      ],
      [
        "70071592420137476676935286377781779672157004436137616627487590484756055232944|BUY",
        72
      ],
      [
        "60447443643099453130956385288904175887233107411078568881602330835010340506057|BUY",
        72
      ],
      [
        "26468656392978559668331516709623917078428425933265692717836103090220693717685|BUY",
        72
      ],
      [
        "112680630004798425069810935278212000865453267506345451433803052322987302357330|BUY",
        72
      ],
      [
        "17229559412398170618704225341353811929634795955092110836823940954753499964583|BUY",
        72
      ],
      [
        "15377800909339117478848654529132462257649986576758444132279677343865329475931|BUY",
        72
      ],
      [
        "87854174148074652060467921081181402357467303721471806610111179101805869578687|BUY",
        72
      ]
    ],
    "topMarkets": [
      [
        "0xb6b3d7a2037b3faa7e1306d741840d453432902d73cc9a146a035e40271eae73",
        72
      ],
      [
        "0x9b6fef249040fd17e9c107955b37ac2c3e923509b6b0ff01cc463a331ddeb894",
        72
      ],
      [
        "0x4567b275e6b667a6217f5cb4f06a797d3a1eaf1d0281fb5bc8c75e2046ae7e57",
        72
      ],
      [
        "0x713641f745d71f6ec61f906237ffca3c8583f251e49384429a63ceb0ccdb2d37",
        72
      ],
      [
        "0x543da007c2f149346cf9f9f21021f1b2e10c46c78fcd0c9297c0c21f10c94626",
        72
      ],
      [
        "0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f",
        72
      ],
      [
        "0x74dba1ce1ae9dd535414e85f2d9ab5ea32c0fb1acc9b7130b67e6d91217e24e1",
        72
      ],
      [
        "0x7b52405ad0e0d31bfe970940b67d77f24ecedeab8a2361c11148c02a006e325c",
        72
      ],
      [
        "0x1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9",
        72
      ],
      [
        "0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892",
        72
      ],
      [
        "0xe202539dfbeced92dc4112f134a205c80ca6cf4db32bd82f05b291c297219fd8",
        72
      ],
      [
        "0xb76183fb9e7e80c5a8f983a87ceefd35c9c177f684dd001d7387dc7b70d596d6",
        72
      ],
      [
        "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
        72
      ]
    ]
  },
  "goodBands": {
    "0.4-0.6": {
      "traceRows": 0,
      "uniqueMarkets": 0,
      "alreadyOpenShare": 0,
      "novelShare": 0,
      "scoreSummary": {
        "n": 0,
        "min": 0,
        "max": 0,
        "mean": 0,
        "std": 0,
        "p25": null,
        "p50": null,
        "p75": null
      },
      "proxyBandMarkoutAvg": 0.012194036493101922
    },
    "0.2-0.3": {
      "traceRows": 0,
      "uniqueMarkets": 0,
      "alreadyOpenShare": 0,
      "novelShare": 0,
      "scoreSummary": {
        "n": 0,
        "min": 0,
        "max": 0,
        "mean": 0,
        "std": 0,
        "p25": null,
        "p50": null,
        "p75": null
      },
      "proxyBandMarkoutAvg": 2.1785457163426925
    }
  },
  "conclusion": "evidence insufficient"
}
```