# V2 concentration block audit (read-only)

- Generated: 2026-04-01T15:01:23.916Z
- Lookback: **24h** (`CONCENTRATION_AUDIT_LOOKBACK_HOURS`; cap **50000** blocked events via `CONCENTRATION_AUDIT_EVENT_CAP`).
- Cohort: `OrderIntent.source = runtime_automated` + `OrderIntentEvent.eventType = EXECUTION_POLICY_BLOCKED`.
- **Concentration-blocked** = blocked event whose `blockingReasons` tokens mention market and/or theme concentration.

## Code references
Exposure checks / reason codes: `lib/execution-policy/evaluate.ts` (e.g. `single_market_concentration_breach`, `single_theme_concentration_breach`).
Runtime handler appends `EXECUTION_POLICY_BLOCKED` with `blockingReasons`: `worker/stream-runtime.ts`.
Ledger: `OrderIntentEvent` joined to `OrderIntent` (`source = runtime_automated`).
Theme/category resolution (this audit): `OrderIntent.recommendationId` → `MarketSignal`; else `metadataJson.linkage`; else `resolveRuntimeIntentRecommendationLink` (`lib/runtime/intent-recommendation-link.ts`).

## A. Top blocked themes and categories (concentration cohort; count & share)
- Denominator: **13771** distinct intents with concentration-related block tokens (fallback: event count if no intent rows).
### Themes (resolved)
| rank | name | count | share |
| ---: | --- | ---: | ---: |
| 1 | Election | 2552 | 18.53% |
| 2 | Will the Los | 374 | 2.72% |
| 3 | Will Argentina win | 354 | 2.57% |
| 4 | Will the San | 332 | 2.41% |
| 5 | Will Brazil win | 328 | 2.38% |
| 6 | Will the Minnesota | 318 | 2.31% |
| 7 | Will France win | 314 | 2.28% |
| 8 | Will England win | 308 | 2.24% |
| 9 | Will Germany win | 284 | 2.06% |
| 10 | Will the Detroit | 274 | 1.99% |
| 11 | Will Portugal win | 251 | 1.82% |
| 12 | Ukraine/Russia | 250 | 1.82% |
| 13 | Will the Dallas | 245 | 1.78% |
| 14 | Will Spain win | 241 | 1.75% |
| 15 | Will the Vegas | 233 | 1.69% |

### Categories (resolved)
| rank | name | count | share |
| ---: | --- | ---: | ---: |
| 1 | other | 10634 | 77.22% |
| 2 | politics | 2759 | 20.03% |
| 3 | geopolitics | 378 | 2.74% |

```json
{
  "themes": [
    [
      "Election",
      2552
    ],
    [
      "Will the Los",
      374
    ],
    [
      "Will Argentina win",
      354
    ],
    [
      "Will the San",
      332
    ],
    [
      "Will Brazil win",
      328
    ],
    [
      "Will the Minnesota",
      318
    ],
    [
      "Will France win",
      314
    ],
    [
      "Will England win",
      308
    ],
    [
      "Will Germany win",
      284
    ],
    [
      "Will the Detroit",
      274
    ],
    [
      "Will Portugal win",
      251
    ],
    [
      "Ukraine/Russia",
      250
    ],
    [
      "Will the Dallas",
      245
    ],
    [
      "Will Spain win",
      241
    ],
    [
      "Will the Vegas",
      233
    ]
  ],
  "categories": [
    [
      "other",
      10634
    ],
    [
      "politics",
      2759
    ],
    [
      "geopolitics",
      378
    ]
  ]
}
```

## B. Top allowed themes and categories (`READY_FOR_RECONCILIATION`; count & share)
- Denominator: **4792** distinct intents with READY in window.
- READY intents marked as **concentration softened**: **0** (0.00%).
### Themes (resolved)
| rank | name | count | share |
| ---: | --- | ---: | ---: |
| 1 | Election | 823 | 17.17% |
| 2 | Will the San | 234 | 4.88% |
| 3 | Will France win | 144 | 3.01% |
| 4 | Will Spain win | 130 | 2.71% |
| 5 | Will the Los | 126 | 2.63% |
| 6 | Will Argentina win | 114 | 2.38% |
| 7 | Will the Minnesota | 113 | 2.36% |
| 8 | Will England win | 107 | 2.23% |
| 9 | BitBoy convicted? | 107 | 2.23% |
| 10 | Will Brazil win | 100 | 2.09% |
| 11 | Will Paraguay win | 88 | 1.84% |
| 12 | GTA released before | 87 | 1.82% |
| 13 | Will Netherlands win | 83 | 1.73% |
| 14 | Will Portugal win | 77 | 1.61% |
| 15 | Will Belgium win | 76 | 1.59% |

### Categories (resolved)
| rank | name | count | share |
| ---: | --- | ---: | ---: |
| 1 | other | 3808 | 79.47% |
| 2 | politics | 825 | 17.22% |
| 3 | geopolitics | 126 | 2.63% |
| 4 | unknown_category | 26 | 0.54% |
| 5 | crypto | 7 | 0.15% |

```json
{
  "themes": [
    [
      "Election",
      823
    ],
    [
      "Will the San",
      234
    ],
    [
      "Will France win",
      144
    ],
    [
      "Will Spain win",
      130
    ],
    [
      "Will the Los",
      126
    ],
    [
      "Will Argentina win",
      114
    ],
    [
      "Will the Minnesota",
      113
    ],
    [
      "Will England win",
      107
    ],
    [
      "BitBoy convicted?",
      107
    ],
    [
      "Will Brazil win",
      100
    ],
    [
      "Will Paraguay win",
      88
    ],
    [
      "GTA released before",
      87
    ],
    [
      "Will Netherlands win",
      83
    ],
    [
      "Will Portugal win",
      77
    ],
    [
      "Will Belgium win",
      76
    ]
  ],
  "categories": [
    [
      "other",
      3808
    ],
    [
      "politics",
      825
    ],
    [
      "geopolitics",
      126
    ],
    [
      "unknown_category",
      26
    ],
    [
      "crypto",
      7
    ]
  ]
}
```

## C. Unknown theme share (after resolver fallback)
- **Blocked (concentration cohort):** **0.00%** (0/13771) map to `unknown_theme` after join → metadata → resolver.
- **Allowed (READY cohort):** **0.54%** (26/4792).

## D. Market vs theme concentration comparison (concentration cohort only)
- Unique markets: **104**; unique resolved themes: **80**.
- Top **5** markets share of cohort: **12.4%**
- Top **10** markets share of cohort: **23.3%**
- Top **5** themes share of cohort: **28.6%**
- Top **10** themes share of cohort: **39.5%**
- **Extreme bands** (`<0.1` ∪ `>=0.9`) share of concentration cohort: **77.0%** (10603/13771)

### Top markets (concentration cohort)
| rank | marketId | count | share |
| ---: | --- | ---: | ---: |
| 1 | `0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75` | 362 | 2.63% |
| 2 | `0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f` | 354 | 2.57% |
| 3 | `0xb6b3d7a2037b3faa7e1306d741840d453432902d73cc9a146a035e40271eae73` | 332 | 2.41% |
| 4 | `0x1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9` | 329 | 2.39% |
| 5 | `0x30d55d8124ee1e12dabe89201badc45669b81dff69e4ce44d961f32878ec178a` | 328 | 2.38% |
| 6 | `0x74dba1ce1ae9dd535414e85f2d9ab5ea32c0fb1acc9b7130b67e6d91217e24e1` | 318 | 2.31% |
| 7 | `0x9b6fef249040fd17e9c107955b37ac2c3e923509b6b0ff01cc463a331ddeb894` | 314 | 2.28% |
| 8 | `0x375409bc5eeeff961e82b479caeccc20f33d15738e5bce1186d628aa3d9dfb1f` | 308 | 2.24% |
| 9 | `0x1595b4818eeb1ea1e0bec5de6f057218e557feee9b405a0e930d290384fa1d16` | 284 | 2.06% |
| 10 | `0xe6bcc2f1dd025ce5e1833190f7c60a71171c94f805df55b9ab0ded695ec93565` | 283 | 2.06% |
| 11 | `0xe202539dfbeced92dc4112f134a205c80ca6cf4db32bd82f05b291c297219fd8` | 274 | 1.99% |
| 12 | `0x0d082a85f48a5226b1205acdb6e95ead2fe373acabcf6c471f5895f86f42a276` | 271 | 1.97% |

## E. Band × theme breakdown (blocked concentration cohort vs allowed READY)
- Per band: top themes by count (empty bands omitted).

### Blocked (concentration cohort)
```json
{
  "<0.1": [
    [
      "Election",
      653
    ],
    [
      "Will Argentina win",
      179
    ],
    [
      "Will Brazil win",
      165
    ],
    [
      "Will the Minnesota",
      147
    ],
    [
      "Will Germany win",
      142
    ],
    [
      "Will the Detroit",
      136
    ],
    [
      "Will Portugal win",
      127
    ],
    [
      "Will the Dallas",
      121
    ],
    [
      "Jinping out before",
      113
    ],
    [
      "Will the Vegas",
      112
    ]
  ],
  "0.1-0.2": [
    [
      "Will the San",
      165
    ],
    [
      "Will France win",
      155
    ],
    [
      "Will England win",
      154
    ],
    [
      "Will Spain win",
      119
    ],
    [
      "Will the Boston",
      97
    ],
    [
      "Election",
      85
    ],
    [
      "Will the Tampa",
      23
    ],
    [
      "Will the Colorado",
      23
    ]
  ],
  "0.2-0.3": [
    [
      "Election",
      181
    ]
  ],
  "0.3-0.4": [
    [
      "Will the Oklahoma",
      109
    ],
    [
      "New Rihanna Album",
      92
    ]
  ],
  "0.4-0.6": [
    [
      "Ukraine/Russia",
      250
    ],
    [
      "Will China invades",
      208
    ],
    [
      "Trump",
      207
    ],
    [
      "Will Jesus Christ",
      12
    ]
  ],
  "0.6-0.8": [
    [
      "Election",
      181
    ],
    [
      "Will the Oklahoma",
      111
    ],
    [
      "New Rihanna Album",
      91
    ]
  ],
  "0.8-0.9": [
    [
      "Will the San",
      167
    ],
    [
      "Will France win",
      159
    ],
    [
      "Will England win",
      154
    ],
    [
      "Election",
      125
    ],
    [
      "Will Spain win",
      122
    ],
    [
      "Will the Boston",
      96
    ],
    [
      "Will the Carolina",
      36
    ],
    [
      "Will the Colorado",
      23
    ],
    [
      "Will the Tampa",
      23
    ]
  ],
  ">=0.9": [
    [
      "Election",
      1327
    ],
    [
      "Will the Los",
      305
    ],
    [
      "Will Qatar win",
      176
    ],
    [
      "Will Argentina win",
      175
    ],
    [
      "Will the Minnesota",
      171
    ],
    [
      "Will the Golden",
      164
    ],
    [
      "Will Brazil win",
      163
    ],
    [
      "Will the Portland",
      161
    ],
    [
      "Will Haiti win",
      149
    ],
    [
      "Will Paraguay win",
      145
    ]
  ]
}
```
### Allowed (READY cohort)
```json
{
  "<0.1": [
    [
      "Election",
      282
    ],
    [
      "Will Argentina win",
      63
    ],
    [
      "Will the Minnesota",
      54
    ],
    [
      "Will Netherlands win",
      52
    ],
    [
      "Will Brazil win",
      50
    ],
    [
      "Will Norway win",
      48
    ],
    [
      "GTA released before",
      41
    ],
    [
      "Will Portugal win",
      40
    ],
    [
      "Will Belgium win",
      39
    ],
    [
      "Will the Los",
      38
    ]
  ],
  "0.1-0.2": [
    [
      "Will the San",
      111
    ],
    [
      "Will France win",
      89
    ],
    [
      "Will Spain win",
      63
    ],
    [
      "Will England win",
      55
    ],
    [
      "Election",
      49
    ],
    [
      "Will the Boston",
      21
    ],
    [
      "Will the Tampa",
      15
    ],
    [
      "Will the Colorado",
      13
    ],
    [
      "Will Italy qualify",
      7
    ]
  ],
  "0.2-0.3": [
    [
      "Election",
      62
    ],
    [
      "Will the Colorado",
      12
    ],
    [
      "BitBoy convicted?",
      4
    ],
    [
      "Will Italy qualify",
      4
    ]
  ],
  "0.3-0.4": [
    [
      "Will the Oklahoma",
      21
    ],
    [
      "Will Sweden qualify",
      5
    ],
    [
      "Will Poland qualify",
      3
    ],
    [
      "BitBoy convicted?",
      2
    ],
    [
      "Will Italy qualify",
      2
    ],
    [
      "New Rihanna Album",
      1
    ]
  ],
  "0.4-0.6": [
    [
      "Ukraine/Russia",
      39
    ],
    [
      "Will Jesus Christ",
      29
    ],
    [
      "Will China invades",
      13
    ],
    [
      "Bitcoin",
      7
    ],
    [
      "Will Italy qualify",
      6
    ],
    [
      "Will Poland qualify",
      4
    ],
    [
      "New Playboi Carti",
      2
    ]
  ],
  "0.6-0.8": [
    [
      "Election",
      64
    ],
    [
      "Will the Oklahoma",
      28
    ],
    [
      "BitBoy convicted?",
      18
    ],
    [
      "Will the Colorado",
      12
    ],
    [
      "Will Italy qualify",
      12
    ],
    [
      "Will Poland qualify",
      10
    ],
    [
      "Will Sweden qualify",
      8
    ],
    [
      "Will Cooper Flagg",
      3
    ],
    [
      "New Playboi Carti",
      1
    ]
  ],
  "0.8-0.9": [
    [
      "Will the San",
      123
    ],
    [
      "Will Spain win",
      67
    ],
    [
      "Will France win",
      55
    ],
    [
      "Will England win",
      52
    ],
    [
      "Election",
      29
    ],
    [
      "Will the Boston",
      20
    ],
    [
      "Will the Tampa",
      15
    ],
    [
      "BitBoy convicted?",
      12
    ],
    [
      "Will Italy qualify",
      11
    ],
    [
      "Will the Colorado",
      11
    ]
  ],
  ">=0.9": [
    [
      "Election",
      337
    ],
    [
      "Will the Los",
      88
    ],
    [
      "Will Paraguay win",
      88
    ],
    [
      "BitBoy convicted?",
      70
    ],
    [
      "Will Jordan win",
      67
    ],
    [
      "Will Qatar win",
      59
    ],
    [
      "Will the Minnesota",
      59
    ],
    [
      "Will Scotland win",
      57
    ],
    [
      "Will New Zealand",
      56
    ],
    [
      "Will the Portland",
      56
    ]
  ]
}
```
### Band totals: blocked vs allowed
```json
{
  "blockedConc": {
    ">=0.9": 7884,
    "<0.1": 2719,
    "0.8-0.9": 905,
    "0.1-0.2": 821,
    "0.4-0.6": 677,
    "0.6-0.8": 383,
    "0.3-0.4": 201,
    "0.2-0.3": 181
  },
  "allowed": {
    ">=0.9": 2540,
    "<0.1": 1054,
    "0.1-0.2": 423,
    "0.8-0.9": 403,
    "0.6-0.8": 156,
    "0.4-0.6": 100,
    "0.2-0.3": 82,
    "0.3-0.4": 34
  }
}
```

## F. Blunt conclusion
**concentration is mainly extreme-band-driven**

## Appendix: block event stats & reason tokens
- Total blocked events sampled: **50000**
- Events with **market** concentration token: **27967**
- Events with **theme** concentration token: **27967**
- Events with **runtime_safety_blocked** token: **35627**
- Events with **any** concentration token (market ∪ theme): **27967**
- READY events with **concentrationSoftened=true**: **0**
- Distinct intents in concentration set: **13771**

### Top raw reason tokens
```json
[
  [
    "operational:runtime_safety_blocked",
    35627
  ],
  [
    "exposure:single_market_concentration_breach",
    27967
  ],
  [
    "single_theme_concentration_breach",
    27967
  ]
]
```

### Allowed vs blocked markets (top blocked vs allowed counts)
| blocked rank | marketId | blocked (conc) | allowed (READY) |
| ---: | --- | ---: | ---: |
| 1 | `0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75` | 362 | 126 |
| 2 | `0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f` | 354 | 114 |
| 3 | `0xb6b3d7a2037b3faa7e1306d741840d453432902d73cc9a146a035e40271eae73` | 332 | 234 |
| 4 | `0x1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9` | 329 | 112 |
| 5 | `0x30d55d8124ee1e12dabe89201badc45669b81dff69e4ce44d961f32878ec178a` | 328 | 100 |
| 6 | `0x74dba1ce1ae9dd535414e85f2d9ab5ea32c0fb1acc9b7130b67e6d91217e24e1` | 318 | 128 |
| 7 | `0x9b6fef249040fd17e9c107955b37ac2c3e923509b6b0ff01cc463a331ddeb894` | 314 | 144 |
| 8 | `0x375409bc5eeeff961e82b479caeccc20f33d15738e5bce1186d628aa3d9dfb1f` | 308 | 107 |
| 9 | `0x1595b4818eeb1ea1e0bec5de6f057218e557feee9b405a0e930d290384fa1d16` | 284 | 42 |
| 10 | `0xe6bcc2f1dd025ce5e1833190f7c60a71171c94f805df55b9ab0ded695ec93565` | 283 | 84 |

### Strategy proxy (concentration-blocked only)
```json
{
  "momentum": 11229,
  "mean_reversion": 2542
}
```
- Overlap: **2** marketIds in both top-5 blocked (conc) and top-5 allowed.

## JSON summary
```json
{
  "generatedAt": "2026-04-01T15:01:23.916Z",
  "lookbackHours": 24,
  "eventCap": 50000,
  "blockedEventsSampled": 50000,
  "counts": {
    "eventsWithMarketConcToken": 27967,
    "eventsWithThemeConcToken": 27967,
    "eventsWithRuntimeSafetyToken": 35627,
    "eventsWithAnyConcentrationToken": 27967,
    "readyWithConcentrationSoftened": 0
  },
  "concentrationCohortUniqueIntents": 13771,
  "themeResolution": {
    "unknownThemeShareBlocked": 0,
    "unknownThemeShareAllowed": 0.005425709515859766,
    "blockedUnknownThemeCount": 0,
    "allowedUnknownThemeCount": 26
  },
  "marketVsTheme": {
    "top5MarketShareOfConcCohort": 0.12381090697843294,
    "top10MarketShareOfConcCohort": 0.23324377314646721,
    "top5ThemeShareOfConcCohort": 0.2861084888533876,
    "top10ThemeShareOfConcCohort": 0.3948878077118583,
    "extremeBandShareBlocked": 0.7699513470336213,
    "uniqueMarketsInConcCohort": 104,
    "uniqueThemesInConcCohort": 80
  },
  "topReasonTokens": [
    [
      "operational:runtime_safety_blocked",
      35627
    ],
    [
      "exposure:single_market_concentration_breach",
      27967
    ],
    [
      "single_theme_concentration_breach",
      27967
    ]
  ],
  "topMarketsBlocked": [
    [
      "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
      362
    ],
    [
      "0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f",
      354
    ],
    [
      "0xb6b3d7a2037b3faa7e1306d741840d453432902d73cc9a146a035e40271eae73",
      332
    ],
    [
      "0x1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9",
      329
    ],
    [
      "0x30d55d8124ee1e12dabe89201badc45669b81dff69e4ce44d961f32878ec178a",
      328
    ],
    [
      "0x74dba1ce1ae9dd535414e85f2d9ab5ea32c0fb1acc9b7130b67e6d91217e24e1",
      318
    ],
    [
      "0x9b6fef249040fd17e9c107955b37ac2c3e923509b6b0ff01cc463a331ddeb894",
      314
    ],
    [
      "0x375409bc5eeeff961e82b479caeccc20f33d15738e5bce1186d628aa3d9dfb1f",
      308
    ],
    [
      "0x1595b4818eeb1ea1e0bec5de6f057218e557feee9b405a0e930d290384fa1d16",
      284
    ],
    [
      "0xe6bcc2f1dd025ce5e1833190f7c60a71171c94f805df55b9ab0ded695ec93565",
      283
    ],
    [
      "0xe202539dfbeced92dc4112f134a205c80ca6cf4db32bd82f05b291c297219fd8",
      274
    ],
    [
      "0x0d082a85f48a5226b1205acdb6e95ead2fe373acabcf6c471f5895f86f42a276",
      271
    ],
    [
      "0x4f3421fb2daf5cca7430ed8d8132463963081572d75434393a1808fdb8829fe8",
      251
    ],
    [
      "0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763",
      250
    ],
    [
      "0x44887f53abbfe7531b1384420b185a5f10ee42a4e6c9441d5883abd4f3c1e5ef",
      245
    ]
  ],
  "topThemesBlocked": [
    [
      "Election",
      2552
    ],
    [
      "Will the Los",
      374
    ],
    [
      "Will Argentina win",
      354
    ],
    [
      "Will the San",
      332
    ],
    [
      "Will Brazil win",
      328
    ],
    [
      "Will the Minnesota",
      318
    ],
    [
      "Will France win",
      314
    ],
    [
      "Will England win",
      308
    ],
    [
      "Will Germany win",
      284
    ],
    [
      "Will the Detroit",
      274
    ],
    [
      "Will Portugal win",
      251
    ],
    [
      "Ukraine/Russia",
      250
    ],
    [
      "Will the Dallas",
      245
    ],
    [
      "Will Spain win",
      241
    ],
    [
      "Will the Vegas",
      233
    ],
    [
      "Jinping out before",
      227
    ],
    [
      "GTA released before",
      221
    ],
    [
      "Will the Oklahoma",
      220
    ],
    [
      "Will Norway win",
      212
    ],
    [
      "Will China invades",
      208
    ]
  ],
  "topCategoriesBlocked": [
    [
      "other",
      10634
    ],
    [
      "politics",
      2759
    ],
    [
      "geopolitics",
      378
    ]
  ],
  "topThemesAllowed": [
    [
      "Election",
      823
    ],
    [
      "Will the San",
      234
    ],
    [
      "Will France win",
      144
    ],
    [
      "Will Spain win",
      130
    ],
    [
      "Will the Los",
      126
    ],
    [
      "Will Argentina win",
      114
    ],
    [
      "Will the Minnesota",
      113
    ],
    [
      "Will England win",
      107
    ],
    [
      "BitBoy convicted?",
      107
    ],
    [
      "Will Brazil win",
      100
    ],
    [
      "Will Paraguay win",
      88
    ],
    [
      "GTA released before",
      87
    ],
    [
      "Will Netherlands win",
      83
    ],
    [
      "Will Portugal win",
      77
    ],
    [
      "Will Belgium win",
      76
    ],
    [
      "Will the Vegas",
      76
    ],
    [
      "Will Japan win",
      73
    ],
    [
      "Will Jordan win",
      67
    ],
    [
      "Will Norway win",
      66
    ],
    [
      "Will Qatar win",
      59
    ]
  ],
  "topCategoriesAllowed": [
    [
      "other",
      3808
    ],
    [
      "politics",
      825
    ],
    [
      "geopolitics",
      126
    ],
    [
      "unknown_category",
      26
    ],
    [
      "crypto",
      7
    ]
  ],
  "bandThemeBlocked": {
    "<0.1": [
      [
        "Election",
        653
      ],
      [
        "Will Argentina win",
        179
      ],
      [
        "Will Brazil win",
        165
      ],
      [
        "Will the Minnesota",
        147
      ],
      [
        "Will Germany win",
        142
      ],
      [
        "Will the Detroit",
        136
      ],
      [
        "Will Portugal win",
        127
      ],
      [
        "Will the Dallas",
        121
      ],
      [
        "Jinping out before",
        113
      ],
      [
        "Will the Vegas",
        112
      ]
    ],
    "0.1-0.2": [
      [
        "Will the San",
        165
      ],
      [
        "Will France win",
        155
      ],
      [
        "Will England win",
        154
      ],
      [
        "Will Spain win",
        119
      ],
      [
        "Will the Boston",
        97
      ],
      [
        "Election",
        85
      ],
      [
        "Will the Tampa",
        23
      ],
      [
        "Will the Colorado",
        23
      ]
    ],
    "0.2-0.3": [
      [
        "Election",
        181
      ]
    ],
    "0.3-0.4": [
      [
        "Will the Oklahoma",
        109
      ],
      [
        "New Rihanna Album",
        92
      ]
    ],
    "0.4-0.6": [
      [
        "Ukraine/Russia",
        250
      ],
      [
        "Will China invades",
        208
      ],
      [
        "Trump",
        207
      ],
      [
        "Will Jesus Christ",
        12
      ]
    ],
    "0.6-0.8": [
      [
        "Election",
        181
      ],
      [
        "Will the Oklahoma",
        111
      ],
      [
        "New Rihanna Album",
        91
      ]
    ],
    "0.8-0.9": [
      [
        "Will the San",
        167
      ],
      [
        "Will France win",
        159
      ],
      [
        "Will England win",
        154
      ],
      [
        "Election",
        125
      ],
      [
        "Will Spain win",
        122
      ],
      [
        "Will the Boston",
        96
      ],
      [
        "Will the Carolina",
        36
      ],
      [
        "Will the Colorado",
        23
      ],
      [
        "Will the Tampa",
        23
      ]
    ],
    ">=0.9": [
      [
        "Election",
        1327
      ],
      [
        "Will the Los",
        305
      ],
      [
        "Will Qatar win",
        176
      ],
      [
        "Will Argentina win",
        175
      ],
      [
        "Will the Minnesota",
        171
      ],
      [
        "Will the Golden",
        164
      ],
      [
        "Will Brazil win",
        163
      ],
      [
        "Will the Portland",
        161
      ],
      [
        "Will Haiti win",
        149
      ],
      [
        "Will Paraguay win",
        145
      ]
    ]
  },
  "bandThemeAllowed": {
    "<0.1": [
      [
        "Election",
        282
      ],
      [
        "Will Argentina win",
        63
      ],
      [
        "Will the Minnesota",
        54
      ],
      [
        "Will Netherlands win",
        52
      ],
      [
        "Will Brazil win",
        50
      ],
      [
        "Will Norway win",
        48
      ],
      [
        "GTA released before",
        41
      ],
      [
        "Will Portugal win",
        40
      ],
      [
        "Will Belgium win",
        39
      ],
      [
        "Will the Los",
        38
      ]
    ],
    "0.1-0.2": [
      [
        "Will the San",
        111
      ],
      [
        "Will France win",
        89
      ],
      [
        "Will Spain win",
        63
      ],
      [
        "Will England win",
        55
      ],
      [
        "Election",
        49
      ],
      [
        "Will the Boston",
        21
      ],
      [
        "Will the Tampa",
        15
      ],
      [
        "Will the Colorado",
        13
      ],
      [
        "Will Italy qualify",
        7
      ]
    ],
    "0.2-0.3": [
      [
        "Election",
        62
      ],
      [
        "Will the Colorado",
        12
      ],
      [
        "BitBoy convicted?",
        4
      ],
      [
        "Will Italy qualify",
        4
      ]
    ],
    "0.3-0.4": [
      [
        "Will the Oklahoma",
        21
      ],
      [
        "Will Sweden qualify",
        5
      ],
      [
        "Will Poland qualify",
        3
      ],
      [
        "BitBoy convicted?",
        2
      ],
      [
        "Will Italy qualify",
        2
      ],
      [
        "New Rihanna Album",
        1
      ]
    ],
    "0.4-0.6": [
      [
        "Ukraine/Russia",
        39
      ],
      [
        "Will Jesus Christ",
        29
      ],
      [
        "Will China invades",
        13
      ],
      [
        "Bitcoin",
        7
      ],
      [
        "Will Italy qualify",
        6
      ],
      [
        "Will Poland qualify",
        4
      ],
      [
        "New Playboi Carti",
        2
      ]
    ],
    "0.6-0.8": [
      [
        "Election",
        64
      ],
      [
        "Will the Oklahoma",
        28
      ],
      [
        "BitBoy convicted?",
        18
      ],
      [
        "Will the Colorado",
        12
      ],
      [
        "Will Italy qualify",
        12
      ],
      [
        "Will Poland qualify",
        10
      ],
      [
        "Will Sweden qualify",
        8
      ],
      [
        "Will Cooper Flagg",
        3
      ],
      [
        "New Playboi Carti",
        1
      ]
    ],
    "0.8-0.9": [
      [
        "Will the San",
        123
      ],
      [
        "Will Spain win",
        67
      ],
      [
        "Will France win",
        55
      ],
      [
        "Will England win",
        52
      ],
      [
        "Election",
        29
      ],
      [
        "Will the Boston",
        20
      ],
      [
        "Will the Tampa",
        15
      ],
      [
        "BitBoy convicted?",
        12
      ],
      [
        "Will Italy qualify",
        11
      ],
      [
        "Will the Colorado",
        11
      ]
    ],
    ">=0.9": [
      [
        "Election",
        337
      ],
      [
        "Will the Los",
        88
      ],
      [
        "Will Paraguay win",
        88
      ],
      [
        "BitBoy convicted?",
        70
      ],
      [
        "Will Jordan win",
        67
      ],
      [
        "Will Qatar win",
        59
      ],
      [
        "Will the Minnesota",
        59
      ],
      [
        "Will Scotland win",
        57
      ],
      [
        "Will New Zealand",
        56
      ],
      [
        "Will the Portland",
        56
      ]
    ]
  },
  "bandBlockedConc": {
    ">=0.9": 7884,
    "<0.1": 2719,
    "0.8-0.9": 905,
    "0.1-0.2": 821,
    "0.4-0.6": 677,
    "0.6-0.8": 383,
    "0.3-0.4": 201,
    "0.2-0.3": 181
  },
  "bandAllowed": {
    ">=0.9": 2540,
    "<0.1": 1054,
    "0.1-0.2": 423,
    "0.8-0.9": 403,
    "0.6-0.8": 156,
    "0.4-0.6": 100,
    "0.2-0.3": 82,
    "0.3-0.4": 34
  },
  "strategyVariantBlocked": {
    "momentum": 11229,
    "mean_reversion": 2542
  },
  "allowedDistinctIntents": 4792,
  "allowedSoftenedDistinctIntents": 0,
  "topMarketsAllowed": [
    [
      "0xb6b3d7a2037b3faa7e1306d741840d453432902d73cc9a146a035e40271eae73",
      234
    ],
    [
      "0x9b6fef249040fd17e9c107955b37ac2c3e923509b6b0ff01cc463a331ddeb894",
      144
    ],
    [
      "0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892",
      130
    ],
    [
      "0x74dba1ce1ae9dd535414e85f2d9ab5ea32c0fb1acc9b7130b67e6d91217e24e1",
      128
    ],
    [
      "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
      126
    ],
    [
      "0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f",
      114
    ],
    [
      "0x1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9",
      112
    ],
    [
      "0x375409bc5eeeff961e82b479caeccc20f33d15738e5bce1186d628aa3d9dfb1f",
      107
    ],
    [
      "0xb48621f7eba07b0a3eeabc6afb09ae42490239903997b9d412b0f69aeb040c8b",
      107
    ],
    [
      "0x30d55d8124ee1e12dabe89201badc45669b81dff69e4ce44d961f32878ec178a",
      100
    ],
    [
      "0x675bba4df50fd123f7fbfbafa67e9b75f4092d85ce0f9148ce78fc945964c856",
      88
    ],
    [
      "0xb91be12388b3d4079c3ed9b5783cb42d8c33051d37746a49300227e0f45fc089",
      87
    ],
    [
      "0xcccb7e7613a087c132b69cbf3a02bece3fdcb824c1da54ae79acc8d4a562d902",
      87
    ],
    [
      "0xe6bcc2f1dd025ce5e1833190f7c60a71171c94f805df55b9ab0ded695ec93565",
      84
    ],
    [
      "0x0d082a85f48a5226b1205acdb6e95ead2fe373acabcf6c471f5895f86f42a276",
      84
    ]
  ],
  "bluntConclusion": "concentration is mainly extreme-band-driven"
}
```