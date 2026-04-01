# V2 extreme-band pressure audit (read-only)

- Generated: 2026-03-31T23:56:27.430Z
- Lookback: **24h** (`EXTREME_BAND_AUDIT_LOOKBACK_HOURS`). Caps: blocked events **50000**, shadow rows **80000**, intent scan batch **25000**.
- **Extreme bucket:** `<0.1` ∪ `>=0.9` (limit / intended price).
- **Mid bucket:** `0.2-0.3` ∪ `0.4-0.6` ∪ `0.6-0.8`.
- **Other:** `0.1-0.2`, `0.3-0.4`, `0.8-0.9`, unknown — excluded from A vs B headline comparison.

## Definitions
- **Candidates:** `ShadowCandidate` rows (`candidateSource = runtime_automated`) in window, bucketed by `intendedPrice`.
- **Eligible intents:** `OrderIntent` rows (`source = runtime_automated`) in window, bucketed by `limitPrice` (reached durable ledger / post-guardrail path).
- **Concentration-block intents:** distinct intents with `EXECUTION_POLICY_BLOCKED` whose payload mentions market/theme concentration (same token rules as concentration audit).
- **READY intents:** distinct intents with `READY_FOR_RECONCILIATION` in window (sample capped).
- **Markout proxy:** mean / mean-abs of `markout1h` on shadow rows with `wasSubmitted=true` in each bucket (sparse; interpret cautiously).
- **Quality-adjusted pressure:** `conc_block_rate_eligible / mean_abs_markout1h` per bucket (higher = more blocks per unit realized volatility proxy); ratio **extreme/mid** in summary.

## A vs B — aggregate table (extreme vs mid)

| Metric | Extreme (<0.1 ∪ >=0.9) | Mid (0.2–0.3, 0.4–0.6, 0.6–0.8) |
| --- | ---: | ---: |
| Shadow candidates (capped sample) | 53215 | 6768 |
| Eligible intents (full scan in window) | 44617 | 7131 |
| Concentration-block intents (event sample) | 3628 | 482 |
| READY intents (event sample) | 1561 | 224 |
| Conc block / eligible | 8.13% | 6.76% |
| Any EXECUTION_POLICY_BLOCKED / eligible | 8.69% | 6.97% |
| READY / eligible | 3.50% | 3.14% |
| Mean markout1h (submitted shadow, n) | n/a (0) | n/a (0) |
| Mean \|markout1h\| (submitted) | n/a | n/a |
| Quality-adj. conc pressure (conc/eligible ÷ mean\|markout\|) | 8.13 | 6.76 |

## Concentration-block & READY share by mega-bucket
- Concentration blocks in sample: **4849** — extreme share **74.8%**, mid share **9.9%**.
- READY intents in sample: **2236** — extreme share **69.8%**, mid share **10.0%**.
- Quality-adj. pressure ratio (extreme / mid): **1.20**

## Dominant finding
In the blocked-event sample, **74.8%** of concentration blocks are in the extreme mega-bucket vs **9.9%** in mid; per-eligible concentration-block rate is **8.13%** (extreme) vs **6.76%** (mid). READY share by bucket is **69.8%** extreme / **10.0%** mid of sampled READY intents. **Markout1h** was unavailable in the shadow sample for submitted rows, so quality comparison relies on structure (rates + volume share) only.

## Extreme split: `<0.1` vs `>=0.9` (intent-level)
| Side | Eligible | Conc blocks | READY | Conc / eligible |
| --- | ---: | ---: | ---: | ---: |
| <0.1 | 12247 | 911 | 517 | 7.44% |
| >=0.9 | 32370 | 2717 | 1044 | 8.39% |

## Top themes (concentration-blocked intents only)
### Extreme bucket
```json
[
  [
    "unknown_theme",
    2370
  ],
  [
    "Election",
    136
  ],
  [
    "BitBoy convicted?",
    124
  ],
  [
    "Will the Dallas",
    69
  ],
  [
    "GTA released before",
    54
  ],
  [
    "Will the Vegas",
    52
  ],
  [
    "Will the Minnesota",
    47
  ],
  [
    "Will the Los",
    38
  ],
  [
    "Will Netherlands win",
    32
  ],
  [
    "Will Belgium win",
    32
  ],
  [
    "Will Italy qualify",
    32
  ],
  [
    "Will Uruguay win",
    28
  ]
]
```
### Mid bucket
```json
[
  [
    "unknown_theme",
    171
  ],
  [
    "Trump",
    46
  ],
  [
    "Will Jesus Christ",
    44
  ],
  [
    "Ukraine/Russia",
    42
  ],
  [
    "Election",
    41
  ],
  [
    "Bitcoin",
    40
  ],
  [
    "Will China invades",
    32
  ],
  [
    "Will the Colorado",
    26
  ],
  [
    "New Rihanna Album",
    20
  ],
  [
    "New Playboi Carti",
    12
  ],
  [
    "Will the Oklahoma",
    8
  ]
]
```

## Top markets (concentration-blocked intents only)
### Extreme bucket
```json
[
  [
    "0x74dba1ce1ae9dd535414e85f2d9ab5ea32c0fb1acc9b7130b67e6d91217e24e1",
    126
  ],
  [
    "0xb48621f7eba07b0a3eeabc6afb09ae42490239903997b9d412b0f69aeb040c8b",
    124
  ],
  [
    "0xe6bcc2f1dd025ce5e1833190f7c60a71171c94f805df55b9ab0ded695ec93565",
    100
  ],
  [
    "0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f",
    83
  ],
  [
    "0x9be56371f6a29d12769b2f196847ee825b9585ebb8bfa042136be031b081eba1",
    81
  ],
  [
    "0x32cfa52198e85e070d1b17d1b53c5c3a6aaae7736cdc33fa6aa04d353f0c2811",
    72
  ],
  [
    "0x44887f53abbfe7531b1384420b185a5f10ee42a4e6c9441d5883abd4f3c1e5ef",
    69
  ],
  [
    "0x7876851632c295043c66536150a304cb785abdf712ba8489d298c6e6926be106",
    68
  ],
  [
    "0x37a6de1b21803e5f3fb1965116218215d79963af4f7e51659696366267a63a03",
    67
  ],
  [
    "0xb91be12388b3d4079c3ed9b5783cb42d8c33051d37746a49300227e0f45fc089",
    66
  ]
]
```
### Mid bucket
```json
[
  [
    "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
    175
  ],
  [
    "0x84f8b70331323c2fba97d7ceaa9a35fb645a0770d0dbff169d07f24f376766e9",
    46
  ],
  [
    "0x32b09f6390252b37d674501527e709016d55581b2c1e544bd4b8167f5f732f4c",
    44
  ],
  [
    "0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763",
    42
  ],
  [
    "0xbb57ccf5853a85487bc3d83d04d669310d28c6c810758953b9d9b91d1aee89d2",
    40
  ],
  [
    "0x7b49b9bacb5f435bc10f3b100ff59e2fdd346f7f92a9001881bc9825a0af0f11",
    32
  ],
  [
    "0x22e7b5e35423e76842dd3a5e1a21d13793811080d5e7b2896d0c001bd5e97d54",
    30
  ],
  [
    "0xf8f63bb47b2a7c2e0c1be3cedf4075079b11c07476d76a9469065b0c4791961a",
    26
  ],
  [
    "0x1fad72fae204143ff1c3035e99e7c0f65ea8d5cd9bd1070987bd1a3316f772be",
    20
  ],
  [
    "0x2096cd3bedb878cbfb5d30308968616a1dfd80e17b278ca6bdc72f9dde4776a7",
    15
  ]
]
```

## JSON summary (machine-readable)
```json
{
  "generatedAt": "2026-03-31T23:56:27.430Z",
  "lookbackHours": 24,
  "caps": {
    "EVENT_CAP": 50000,
    "SHADOW_CAP": 80000,
    "INTENT_BATCH": 25000
  },
  "extreme": {
    "bucket": "extreme",
    "candidates": 53215,
    "eligible_intents": 44617,
    "concentration_block_intents": 3628,
    "ready_intents": 1561,
    "any_policy_block_intents": 3875,
    "block_rate_conc_per_eligible": 0.08131429724096197,
    "block_rate_any_policy_per_eligible": 0.08685030369590066,
    "ready_rate_per_eligible": 0.03498666427594863,
    "markout1h_mean_submitted_shadow": null,
    "markout1h_n_submitted_shadow": 0,
    "mean_abs_markout1h_submitted": null
  },
  "mid": {
    "bucket": "mid",
    "candidates": 6768,
    "eligible_intents": 7131,
    "concentration_block_intents": 482,
    "ready_intents": 224,
    "any_policy_block_intents": 497,
    "block_rate_conc_per_eligible": 0.06759220305707474,
    "block_rate_any_policy_per_eligible": 0.06969569485345674,
    "ready_rate_per_eligible": 0.03141214415930445,
    "markout1h_mean_submitted_shadow": null,
    "markout1h_n_submitted_shadow": 0,
    "mean_abs_markout1h_submitted": null
  },
  "shares": {
    "concBlockTotalSample": 4849,
    "concShareExtreme": 0.7481955042276758,
    "concShareMid": 0.09940193854402969,
    "readyTotalSample": 2236,
    "readyShareExtreme": 0.6981216457960644,
    "readyShareMid": 0.1001788908765653
  },
  "qualityAdjusted": {
    "extreme": 8.131429724096197,
    "mid": 6.759220305707474,
    "ratioExtremeOverMid": 1.2030129743263482
  },
  "extremeSideSplit": {
    "extreme_low": {
      "eligible": 12247,
      "concBlocks": 911,
      "ready": 517
    },
    "extreme_high": {
      "eligible": 32370,
      "concBlocks": 2717,
      "ready": 1044
    }
  },
  "topThemesConc": {
    "extreme": [
      [
        "unknown_theme",
        2370
      ],
      [
        "Election",
        136
      ],
      [
        "BitBoy convicted?",
        124
      ],
      [
        "Will the Dallas",
        69
      ],
      [
        "GTA released before",
        54
      ],
      [
        "Will the Vegas",
        52
      ],
      [
        "Will the Minnesota",
        47
      ],
      [
        "Will the Los",
        38
      ],
      [
        "Will Netherlands win",
        32
      ],
      [
        "Will Belgium win",
        32
      ],
      [
        "Will Italy qualify",
        32
      ],
      [
        "Will Uruguay win",
        28
      ],
      [
        "Geopolitics",
        28
      ],
      [
        "Will the New",
        26
      ],
      [
        "Will Argentina win",
        25
      ]
    ],
    "mid": [
      [
        "unknown_theme",
        171
      ],
      [
        "Trump",
        46
      ],
      [
        "Will Jesus Christ",
        44
      ],
      [
        "Ukraine/Russia",
        42
      ],
      [
        "Election",
        41
      ],
      [
        "Bitcoin",
        40
      ],
      [
        "Will China invades",
        32
      ],
      [
        "Will the Colorado",
        26
      ],
      [
        "New Rihanna Album",
        20
      ],
      [
        "New Playboi Carti",
        12
      ],
      [
        "Will the Oklahoma",
        8
      ]
    ]
  },
  "topMarketsConc": {
    "extreme": [
      [
        "0x74dba1ce1ae9dd535414e85f2d9ab5ea32c0fb1acc9b7130b67e6d91217e24e1",
        126
      ],
      [
        "0xb48621f7eba07b0a3eeabc6afb09ae42490239903997b9d412b0f69aeb040c8b",
        124
      ],
      [
        "0xe6bcc2f1dd025ce5e1833190f7c60a71171c94f805df55b9ab0ded695ec93565",
        100
      ],
      [
        "0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f",
        83
      ],
      [
        "0x9be56371f6a29d12769b2f196847ee825b9585ebb8bfa042136be031b081eba1",
        81
      ],
      [
        "0x32cfa52198e85e070d1b17d1b53c5c3a6aaae7736cdc33fa6aa04d353f0c2811",
        72
      ],
      [
        "0x44887f53abbfe7531b1384420b185a5f10ee42a4e6c9441d5883abd4f3c1e5ef",
        69
      ],
      [
        "0x7876851632c295043c66536150a304cb785abdf712ba8489d298c6e6926be106",
        68
      ],
      [
        "0x37a6de1b21803e5f3fb1965116218215d79963af4f7e51659696366267a63a03",
        67
      ],
      [
        "0xb91be12388b3d4079c3ed9b5783cb42d8c33051d37746a49300227e0f45fc089",
        66
      ],
      [
        "0x4f3421fb2daf5cca7430ed8d8132463963081572d75434393a1808fdb8829fe8",
        66
      ],
      [
        "0xe202539dfbeced92dc4112f134a205c80ca6cf4db32bd82f05b291c297219fd8",
        66
      ]
    ],
    "mid": [
      [
        "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
        175
      ],
      [
        "0x84f8b70331323c2fba97d7ceaa9a35fb645a0770d0dbff169d07f24f376766e9",
        46
      ],
      [
        "0x32b09f6390252b37d674501527e709016d55581b2c1e544bd4b8167f5f732f4c",
        44
      ],
      [
        "0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763",
        42
      ],
      [
        "0xbb57ccf5853a85487bc3d83d04d669310d28c6c810758953b9d9b91d1aee89d2",
        40
      ],
      [
        "0x7b49b9bacb5f435bc10f3b100ff59e2fdd346f7f92a9001881bc9825a0af0f11",
        32
      ],
      [
        "0x22e7b5e35423e76842dd3a5e1a21d13793811080d5e7b2896d0c001bd5e97d54",
        30
      ],
      [
        "0xf8f63bb47b2a7c2e0c1be3cedf4075079b11c07476d76a9469065b0c4791961a",
        26
      ],
      [
        "0x1fad72fae204143ff1c3035e99e7c0f65ea8d5cd9bd1070987bd1a3316f772be",
        20
      ],
      [
        "0x2096cd3bedb878cbfb5d30308968616a1dfd80e17b278ca6bdc72f9dde4776a7",
        15
      ],
      [
        "0x50ddb9cd80d5c271664a2ebb7fcaed1d0a148d82c8e8d314d830f75a944c3dcc",
        12
      ]
    ]
  },
  "dominantFinding": "In the blocked-event sample, **74.8%** of concentration blocks are in the extreme mega-bucket vs **9.9%** in mid; per-eligible concentration-block rate is **8.13%** (extreme) vs **6.76%** (mid). READY share by bucket is **69.8%** extreme / **10.0%** mid of sampled READY intents. **Markout1h** was unavailable in the shadow sample for submitted rows, so quality comparison relies on structure (rates + volume share) only.",
  "bluntConclusion": "extreme bands should be capped upstream"
}
```

## Blunt conclusion
**extreme bands should be capped upstream**
