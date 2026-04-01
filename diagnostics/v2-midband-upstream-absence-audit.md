# V2 mid-band upstream absence audit

- Generated: 2026-04-01T12:47:19.114Z
- Funder analyzed: 0x443e0af9c2ccbedb60ff866b45afd91ca3999e69
- Scope for supply windows uses `ShadowCandidate` raw loader basis (runtime_automated, submitted, unblocked).
- Recommendation band is approximate (`suggestedEntryMin/Max` midpoint when both exist).

## A. 0.4-0.6 presence over 1h/6h/24h raw ShadowCandidate supply
| window | <0.1 | 0.1-0.2 | 0.2-0.3 | 0.3-0.4 | 0.4-0.6 | 0.6-0.8 | 0.8-0.9 | >=0.9 | unknown | total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1h | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 6h | 395 | 195 | 37 | 15 | 36 | 47 | 169 | 1027 | 0 | 1921 |
| 24h | 559 | 267 | 41 | 21 | 53 | 65 | 240 | 1514 | 0 | 2760 |

## B. Upstream source stage (where possible)
| window | recommendation 0.4-0.6 | orderIntent 0.4-0.6 | shadowCandidate 0.4-0.6 | first stage where 0.4-0.6 disappears |
| --- | ---: | ---: | ---: | --- |
| 1h | 0 | 0 | 0 | recommendation |
| 6h | 0 | 84 | 36 | recommendation |
| 24h | 0 | 84 | 53 | recommendation |

### Stage-by-band JSON
```json
{
  "1h": {
    "recommendation": {
      "<0.1": 0,
      "0.1-0.2": 0,
      "0.2-0.3": 0,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 0,
      "0.8-0.9": 0,
      ">=0.9": 0,
      "unknown": 0
    },
    "orderIntent": {
      "<0.1": 518,
      "0.1-0.2": 275,
      "0.2-0.3": 59,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 59,
      "0.8-0.9": 216,
      ">=0.9": 1970,
      "unknown": 0
    },
    "shadowCandidate": {
      "<0.1": 0,
      "0.1-0.2": 0,
      "0.2-0.3": 0,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 0,
      "0.8-0.9": 0,
      ">=0.9": 0,
      "unknown": 0
    }
  },
  "6h": {
    "recommendation": {
      "<0.1": 0,
      "0.1-0.2": 0,
      "0.2-0.3": 0,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 0,
      "0.8-0.9": 0,
      ">=0.9": 0,
      "unknown": 0
    },
    "orderIntent": {
      "<0.1": 1876,
      "0.1-0.2": 916,
      "0.2-0.3": 187,
      "0.3-0.4": 35,
      "0.4-0.6": 84,
      "0.6-0.8": 218,
      "0.8-0.9": 807,
      ">=0.9": 5877,
      "unknown": 0
    },
    "shadowCandidate": {
      "<0.1": 395,
      "0.1-0.2": 195,
      "0.2-0.3": 37,
      "0.3-0.4": 15,
      "0.4-0.6": 36,
      "0.6-0.8": 47,
      "0.8-0.9": 169,
      ">=0.9": 1027,
      "unknown": 0
    }
  },
  "24h": {
    "recommendation": {
      "<0.1": 0,
      "0.1-0.2": 0,
      "0.2-0.3": 0,
      "0.3-0.4": 0,
      "0.4-0.6": 0,
      "0.6-0.8": 0,
      "0.8-0.9": 0,
      ">=0.9": 0,
      "unknown": 0
    },
    "orderIntent": {
      "<0.1": 1876,
      "0.1-0.2": 915,
      "0.2-0.3": 187,
      "0.3-0.4": 35,
      "0.4-0.6": 84,
      "0.6-0.8": 218,
      "0.8-0.9": 807,
      ">=0.9": 5878,
      "unknown": 0
    },
    "shadowCandidate": {
      "<0.1": 559,
      "0.1-0.2": 267,
      "0.2-0.3": 41,
      "0.3-0.4": 21,
      "0.4-0.6": 53,
      "0.6-0.8": 65,
      "0.8-0.9": 240,
      ">=0.9": 1514,
      "unknown": 0
    }
  }
}
```

## C. 0.4-0.6 market coverage and recency
- 0.4-0.6 markets in last 24h: **2**
- 0.4-0.6 markets in prior 24h (24h-48h ago): **5**
- top 0.4-0.6 markets last 24h:
```json
[
  [
    "0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763",
    36
  ],
  [
    "0x7b49b9bacb5f435bc10f3b100ff59e2fdd346f7f92a9001881bc9825a0af0f11",
    17
  ]
]
```
- top 0.4-0.6 markets prior 24h:
```json
[
  [
    "0x50ddb9cd80d5c271664a2ebb7fcaed1d0a148d82c8e8d314d830f75a944c3dcc",
    12
  ],
  [
    "0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763",
    10
  ],
  [
    "0x7b49b9bacb5f435bc10f3b100ff59e2fdd346f7f92a9001881bc9825a0af0f11",
    7
  ],
  [
    "0x32b09f6390252b37d674501527e709016d55581b2c1e544bd4b8167f5f732f4c",
    5
  ],
  [
    "0xbb57ccf5853a85487bc3d83d04d669310d28c6c810758953b9d9b91d1aee89d2",
    4
  ]
]
```
- Interpretation: 0.4-0.6 appears in current longer window; current absence is not persistent.

## D. Blunt conclusion
**0.4-0.6 is temporarily absent**

