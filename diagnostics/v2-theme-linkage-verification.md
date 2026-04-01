# V2 theme linkage verification

- Generated: 2026-03-31T23:28:38.883Z
- Lookback: **24h** (`THEME_LINKAGE_VERIFY_LOOKBACK_HOURS`), sample up to **2500** intents per cohort.

## A. Diagnosis (where linkage was lost)
- **Emitter:** `DefaultBotRuntime.emitIntentIfNeeded` (`lib/runtime/bot-runtime/bot-runtime.ts`) publishes `order.intent.created` **without** `recommendationId`.
- **Consumer:** `worker/stream-runtime.ts` persisted `OrderIntent.recommendationId` only from the bus payload → almost always **null**.
- **Resolver keying:** Runtime `OrderIntent.marketId` is often Polymarket **condition_id** (hex); `MarketSignal` stores that in `conditionId` while `marketId` may be the venue’s other id. `resolveRuntimeIntentRecommendationLink` matches **either** field plus funder (outcome match is case-insensitive).
- **Repair:** After guardrails, that resolver sets `OrderIntent.recommendationId` and optional `metadataJson.linkage` **without changing** the runtime idempotency key segment (still uses bus `recommendationId` only).
- **Idempotent reuse:** `lib/execution-ledger/repository.ts` backfills `recommendationId` / `metadataJson` when the same idempotency key is reused.

## B. Metrics: blocked cohort (EXECUTION_POLICY_BLOCKED)
- Sample size: **2500**
- **Before fix (join only):** usable theme via `recommendationId → MarketSignal`: **0.0%** (0/2500)
- **unknown_theme / missing theme share (join only, before):** **100.0%**
- **After effective:** join **OR** `metadataJson.linkage.theme` **OR** resolver: **98.6%** (2465/2500)
- `recommendationId` non-null: **0**
- Usable theme from metadata linkage only (no join): **0**
- Usable theme from resolver only (no join/metadata): **2465**
- **unknown_theme share (effective):** **1.4%**

## C. Metrics: allowed cohort (READY_FOR_RECONCILIATION)
- Sample size: **2187**
- **Before fix (join only):** **0.0%**
- **unknown_theme / missing (join only, before):** **100.0%**
- **After effective:** **98.4%**
- **unknown_theme share (effective):** **1.6%**

## D. Top themes / categories (effective theme)
### Blocked — themes
```json
[
  [
    "Election",
    618
  ],
  [
    "Will the Minnesota",
    72
  ],
  [
    "Will Spain win",
    60
  ],
  [
    "BitBoy convicted?",
    59
  ],
  [
    "Will the San",
    58
  ],
  [
    "Will Brazil win",
    48
  ],
  [
    "Will the Vegas",
    48
  ],
  [
    "Will Argentina win",
    47
  ],
  [
    "Will the Boston",
    44
  ],
  [
    "Will France win",
    42
  ],
  [
    "Will the Los",
    41
  ],
  [
    "Will Portugal win",
    40
  ],
  [
    "Will Germany win",
    38
  ],
  [
    "Will the Detroit",
    38
  ],
  [
    "Will Jesus Christ",
    38
  ]
]
```
### Allowed — themes
```json
[
  [
    "Election",
    358
  ],
  [
    "BitBoy convicted?",
    153
  ],
  [
    "Will the San",
    115
  ],
  [
    "Will France win",
    81
  ],
  [
    "GTA released before",
    77
  ],
  [
    "Will the Los",
    72
  ],
  [
    "Will Italy qualify",
    65
  ],
  [
    "Will Italy win",
    61
  ],
  [
    "Will the Vegas",
    59
  ],
  [
    "Will Argentina win",
    56
  ],
  [
    "Will Paraguay win",
    53
  ],
  [
    "Will Netherlands win",
    51
  ],
  [
    "Will Spain win",
    49
  ],
  [
    "Geopolitics",
    47
  ],
  [
    "Will Norway win",
    41
  ]
]
```
### Blocked — categories
```json
[
  [
    "other",
    1733
  ],
  [
    "politics",
    632
  ],
  [
    "geopolitics",
    74
  ],
  [
    "crypto",
    26
  ]
]
```
### Allowed — categories
```json
[
  [
    "other",
    1714
  ],
  [
    "politics",
    363
  ],
  [
    "geopolitics",
    65
  ],
  [
    "crypto",
    9
  ]
]
```

## E. Blunt conclusion
**theme linkage fixed and usable**

## JSON summary
```json
{
  "generatedAt": "2026-03-31T23:28:38.883Z",
  "lookbackHours": 24,
  "sampleCap": 2500,
  "blocked": {
    "n": 2500,
    "joinThemeUsablePct": 0,
    "effectiveThemeUsablePct": 0.986,
    "unknownThemeShareEffective": 0.014000000000000012,
    "storedRecommendationIdCount": 0
  },
  "allowed": {
    "n": 2187,
    "joinThemeUsablePct": 0,
    "effectiveThemeUsablePct": 0.9835390946502057,
    "unknownThemeShareEffective": 0.016460905349794275,
    "storedRecommendationIdCount": 0
  },
  "topThemesBlocked": [
    [
      "Election",
      618
    ],
    [
      "Will the Minnesota",
      72
    ],
    [
      "Will Spain win",
      60
    ],
    [
      "BitBoy convicted?",
      59
    ],
    [
      "Will the San",
      58
    ],
    [
      "Will Brazil win",
      48
    ],
    [
      "Will the Vegas",
      48
    ],
    [
      "Will Argentina win",
      47
    ],
    [
      "Will the Boston",
      44
    ],
    [
      "Will France win",
      42
    ],
    [
      "Will the Los",
      41
    ],
    [
      "Will Portugal win",
      40
    ],
    [
      "Will Germany win",
      38
    ],
    [
      "Will the Detroit",
      38
    ],
    [
      "Will Jesus Christ",
      38
    ]
  ],
  "topThemesAllowed": [
    [
      "Election",
      358
    ],
    [
      "BitBoy convicted?",
      153
    ],
    [
      "Will the San",
      115
    ],
    [
      "Will France win",
      81
    ],
    [
      "GTA released before",
      77
    ],
    [
      "Will the Los",
      72
    ],
    [
      "Will Italy qualify",
      65
    ],
    [
      "Will Italy win",
      61
    ],
    [
      "Will the Vegas",
      59
    ],
    [
      "Will Argentina win",
      56
    ],
    [
      "Will Paraguay win",
      53
    ],
    [
      "Will Netherlands win",
      51
    ],
    [
      "Will Spain win",
      49
    ],
    [
      "Geopolitics",
      47
    ],
    [
      "Will Norway win",
      41
    ]
  ],
  "bluntConclusion": "theme linkage fixed and usable"
}
```