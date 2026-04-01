# V2 low-extreme vs mid survivor audit

- Generated: 2026-04-01T12:05:06.007Z
- Window: 24 dry-run ticks, cadence 500ms
- Preferred funder hint: 0x443e0af9c2ccbedb60ff866b45afd91ca3999e69

## Layer counts
- Raw rows total: **12000**
- Deduped winners total: **984**
- Final selected total: **240**

## Share by bucket at each layer
| layer | low extreme (<0.1) | mid (0.2-0.3, 0.4-0.6, 0.6-0.8) | other |
| --- | ---: | ---: | ---: |
| raw | 17.60% (2112/12000) | 4.20% (504/12000) | 78.20% (9384/12000) |
| deduped | 14.63% (144/984) | 2.44% (24/984) | 82.93% (816/984) |
| final | 30.00% (72/240) | 10.00% (24/240) | 60.00% (144/240) |

## Per-market concentration (HHI; higher = more concentrated)
- Raw HHI: **0.0288**
- Deduped HHI: **0.0244**
- Final HHI: **0.1000**

## Freshness (age buckets)
```json
{
  "raw": {
    ">=30m": 12000
  },
  "deduped": {
    ">=30m": 984
  },
  "final": {
    "<=lookback": 240
  }
}
```

## recommendationId duplication rate (fraction of ids seen >1)
- Raw: **100.00%**
- Deduped: **100.00%**
- Final: **100.00%**

## Where low-extreme overrepresentation grows most
- Low-extreme share lift raw->deduped: **-2.97 pp**
- Low-extreme share lift deduped->final: **15.37 pp**
- Dominant overrepresentation layer: **deduped->final**

## Mid-band loss stage
- Mid lost raw->deduped: **480**
- Mid lost deduped->final: **0**
- Dominant mid loss layer: **raw->deduped**

## Top markets by layer
```json
{
  "raw": [
    [
      "0x7b52405ad0e0d31bfe970940b67d77f24ecedeab8a2361c11148c02a006e325c",
      528
    ],
    [
      "0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f",
      504
    ],
    [
      "0x74dba1ce1ae9dd535414e85f2d9ab5ea32c0fb1acc9b7130b67e6d91217e24e1",
      504
    ],
    [
      "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
      504
    ],
    [
      "0xb6b3d7a2037b3faa7e1306d741840d453432902d73cc9a146a035e40271eae73",
      480
    ],
    [
      "0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892",
      480
    ],
    [
      "0x30d55d8124ee1e12dabe89201badc45669b81dff69e4ce44d961f32878ec178a",
      480
    ],
    [
      "0xe202539dfbeced92dc4112f134a205c80ca6cf4db32bd82f05b291c297219fd8",
      456
    ],
    [
      "0x543da007c2f149346cf9f9f21021f1b2e10c46c78fcd0c9297c0c21f10c94626",
      456
    ],
    [
      "0x1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9",
      456
    ],
    [
      "0x0d082a85f48a5226b1205acdb6e95ead2fe373acabcf6c471f5895f86f42a276",
      408
    ],
    [
      "0x9b6fef249040fd17e9c107955b37ac2c3e923509b6b0ff01cc463a331ddeb894",
      408
    ]
  ],
  "deduped": [
    [
      "0xb76183fb9e7e80c5a8f983a87ceefd35c9c177f684dd001d7387dc7b70d596d6",
      24
    ],
    [
      "0xe202539dfbeced92dc4112f134a205c80ca6cf4db32bd82f05b291c297219fd8",
      24
    ],
    [
      "0x713641f745d71f6ec61f906237ffca3c8583f251e49384429a63ceb0ccdb2d37",
      24
    ],
    [
      "0x46dbd48d6bde5b81edb480e0f676a2cdda6c6b592c4d86a9367c7ad5a9870195",
      24
    ],
    [
      "0x939eeb2dea216749bd409bedde483c3f2bfb0e24d4f2d34461c0b21c6e91f010",
      24
    ],
    [
      "0x543da007c2f149346cf9f9f21021f1b2e10c46c78fcd0c9297c0c21f10c94626",
      24
    ],
    [
      "0xfbf7ab9e6b6d324ffe436bab8c7a1e10aeb8200e10c1e1dbb35d2959becebc1e",
      24
    ],
    [
      "0xb6b3d7a2037b3faa7e1306d741840d453432902d73cc9a146a035e40271eae73",
      24
    ],
    [
      "0x4e65282819c98c6aed529f357fbf5983b1ae9407a3c25bd50fe97b2906df68f9",
      24
    ],
    [
      "0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f",
      24
    ],
    [
      "0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892",
      24
    ],
    [
      "0x0d082a85f48a5226b1205acdb6e95ead2fe373acabcf6c471f5895f86f42a276",
      24
    ]
  ],
  "final": [
    [
      "0xb6b3d7a2037b3faa7e1306d741840d453432902d73cc9a146a035e40271eae73",
      24
    ],
    [
      "0x9b6fef249040fd17e9c107955b37ac2c3e923509b6b0ff01cc463a331ddeb894",
      24
    ],
    [
      "0x4567b275e6b667a6217f5cb4f06a797d3a1eaf1d0281fb5bc8c75e2046ae7e57",
      24
    ],
    [
      "0x713641f745d71f6ec61f906237ffca3c8583f251e49384429a63ceb0ccdb2d37",
      24
    ],
    [
      "0x543da007c2f149346cf9f9f21021f1b2e10c46c78fcd0c9297c0c21f10c94626",
      24
    ],
    [
      "0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f",
      24
    ],
    [
      "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
      24
    ],
    [
      "0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892",
      24
    ],
    [
      "0xb76183fb9e7e80c5a8f983a87ceefd35c9c177f684dd001d7387dc7b70d596d6",
      24
    ],
    [
      "0xe202539dfbeced92dc4112f134a205c80ca6cf4db32bd82f05b291c297219fd8",
      24
    ]
  ]
}
```

## Blunt conclusion
**mid bands are too sparse upstream**

## JSON summary
```json
{
  "generatedAt": "2026-04-01T12:05:06.007Z",
  "ticks": 24,
  "cadenceMs": 500,
  "preferredFunder": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69",
  "totals": {
    "raw": 12000,
    "deduped": 984,
    "final": 240
  },
  "bucketCounts": {
    "raw": {
      "low_extreme": 2112,
      "mid": 504,
      "other": 9384
    },
    "deduped": {
      "low_extreme": 144,
      "mid": 24,
      "other": 816
    },
    "final": {
      "low_extreme": 72,
      "mid": 24,
      "other": 144
    }
  },
  "bucketShares": {
    "raw": {
      "low_extreme": 0.176,
      "mid": 0.042,
      "other": 0.782
    },
    "deduped": {
      "low_extreme": 0.14634146341463414,
      "mid": 0.024390243902439025,
      "other": 0.8292682926829268
    },
    "final": {
      "low_extreme": 0.3,
      "mid": 0.1,
      "other": 0.6
    }
  },
  "marketHHI": {
    "raw": 0.028800000000000017,
    "deduped": 0.024390243902439015,
    "final": 0.10000000000000003
  },
  "recDuplicationRate": {
    "raw": 1,
    "deduped": 1,
    "final": 1
  },
  "lowExtremeShareLift": {
    "rawToDeduped": -0.029658536585365852,
    "dedupedToFinal": 0.15365853658536585,
    "dominantLayer": "deduped->final"
  },
  "midLoss": {
    "rawToDeduped": 480,
    "dedupedToFinal": 0,
    "dominantLayer": "raw->deduped"
  },
  "bluntConclusion": "mid bands are too sparse upstream"
}
```