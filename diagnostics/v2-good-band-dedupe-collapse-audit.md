# V2 good-band dedupe collapse audit

- Generated: 2026-04-01T12:24:45.988Z
- Funder: 0x443e0af9c2ccbedb60ff866b45afd91ca3999e69
- Lookback minutes: 720
- Raw rows scanned: 500

## A. Raw 0.2-0.3 rows
- Count: **11**
- recommendationIds: **2**
- markets: **1**
- sides: **BUY**
- createdAt age (minutes): p50 **81.20**, p90 **89.34**, max **91.34**
- intendedPrice min/max: **0.2475 / 0.2475**

## B. Dedupe-key analysis
```json
[
  {
    "rowId": "cmnfy6ow51p6pmhsqhro9qumw",
    "recommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "marketId": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
    "side": "BUY",
    "rowBand": "0.2-0.3",
    "rowCreatedAt": "2026-04-01T11:13:35.621Z",
    "rowPrice": "0.2475",
    "rowThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "dedupeKey": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75\u0000BUY",
    "winnerId": "cmnfy6q551p98mhsqujlu8gri",
    "winnerRecommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "winnerBand": "0.6-0.8",
    "winnerCreatedAt": "2026-04-01T11:13:37.242Z",
    "winnerPrice": "0.7525",
    "winnerThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "losesUnderCurrentSemantics": true,
    "whyLoses": "same dedupe key uses newest row winner",
    "classification": "replaced by newer row in different band"
  },
  {
    "rowId": "cmnfy2ugb1jlnmhsq3z3uzo3y",
    "recommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "marketId": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
    "side": "BUY",
    "rowBand": "0.2-0.3",
    "rowCreatedAt": "2026-04-01T11:10:36.204Z",
    "rowPrice": "0.2475",
    "rowThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "dedupeKey": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75\u0000BUY",
    "winnerId": "cmnfy6q551p98mhsqujlu8gri",
    "winnerRecommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "winnerBand": "0.6-0.8",
    "winnerCreatedAt": "2026-04-01T11:13:37.242Z",
    "winnerPrice": "0.7525",
    "winnerThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "losesUnderCurrentSemantics": true,
    "whyLoses": "same dedupe key uses newest row winner",
    "classification": "replaced by newer row in different band"
  },
  {
    "rowId": "cmnfy1fla1hbmmhsq6qusyjbu",
    "recommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "marketId": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
    "side": "BUY",
    "rowBand": "0.2-0.3",
    "rowCreatedAt": "2026-04-01T11:09:30.286Z",
    "rowPrice": "0.2475",
    "rowThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "dedupeKey": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75\u0000BUY",
    "winnerId": "cmnfy6q551p98mhsqujlu8gri",
    "winnerRecommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "winnerBand": "0.6-0.8",
    "winnerCreatedAt": "2026-04-01T11:13:37.242Z",
    "winnerPrice": "0.7525",
    "winnerThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "losesUnderCurrentSemantics": true,
    "whyLoses": "same dedupe key uses newest row winner",
    "classification": "replaced by newer row in different band"
  },
  {
    "rowId": "cmnfy0c1j1fyomhsqzte3f58g",
    "recommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "marketId": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
    "side": "BUY",
    "rowBand": "0.2-0.3",
    "rowCreatedAt": "2026-04-01T11:08:39.032Z",
    "rowPrice": "0.2475",
    "rowThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "dedupeKey": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75\u0000BUY",
    "winnerId": "cmnfy6q551p98mhsqujlu8gri",
    "winnerRecommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "winnerBand": "0.6-0.8",
    "winnerCreatedAt": "2026-04-01T11:13:37.242Z",
    "winnerPrice": "0.7525",
    "winnerThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "losesUnderCurrentSemantics": true,
    "whyLoses": "same dedupe key uses newest row winner",
    "classification": "replaced by newer row in different band"
  },
  {
    "rowId": "cmnfxysk51de7mhsq6r9r48qn",
    "recommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "marketId": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
    "side": "BUY",
    "rowBand": "0.2-0.3",
    "rowCreatedAt": "2026-04-01T11:07:27.125Z",
    "rowPrice": "0.2475",
    "rowThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "dedupeKey": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75\u0000BUY",
    "winnerId": "cmnfy6q551p98mhsqujlu8gri",
    "winnerRecommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "winnerBand": "0.6-0.8",
    "winnerCreatedAt": "2026-04-01T11:13:37.242Z",
    "winnerPrice": "0.7525",
    "winnerThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "losesUnderCurrentSemantics": true,
    "whyLoses": "same dedupe key uses newest row winner",
    "classification": "replaced by newer row in different band"
  },
  {
    "rowId": "cmnfxtswc13ywmhsqh8i0cxh8",
    "recommendationId": "cmnfwv26r5rtynqomaarbzcu2",
    "marketId": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
    "side": "BUY",
    "rowBand": "0.2-0.3",
    "rowCreatedAt": "2026-04-01T11:03:34.284Z",
    "rowPrice": "0.2475",
    "rowThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "dedupeKey": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75\u0000BUY",
    "winnerId": "cmnfy6q551p98mhsqujlu8gri",
    "winnerRecommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "winnerBand": "0.6-0.8",
    "winnerCreatedAt": "2026-04-01T11:13:37.242Z",
    "winnerPrice": "0.7525",
    "winnerThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "losesUnderCurrentSemantics": true,
    "whyLoses": "same dedupe key uses newest row winner",
    "classification": "replaced by newer row in different band"
  },
  {
    "rowId": "cmnfxr89m11frmhsqzqk1js6p",
    "recommendationId": "cmnfwv26r5rtynqomaarbzcu2",
    "marketId": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
    "side": "BUY",
    "rowBand": "0.2-0.3",
    "rowCreatedAt": "2026-04-01T11:01:34.234Z",
    "rowPrice": "0.2475",
    "rowThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "dedupeKey": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75\u0000BUY",
    "winnerId": "cmnfy6q551p98mhsqujlu8gri",
    "winnerRecommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "winnerBand": "0.6-0.8",
    "winnerCreatedAt": "2026-04-01T11:13:37.242Z",
    "winnerPrice": "0.7525",
    "winnerThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "losesUnderCurrentSemantics": true,
    "whyLoses": "same dedupe key uses newest row winner",
    "classification": "replaced by newer row in different band"
  },
  {
    "rowId": "cmnfxoly70xdimhsq90a9mlqu",
    "recommendationId": "cmnfwv26r5rtynqomaarbzcu2",
    "marketId": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
    "side": "BUY",
    "rowBand": "0.2-0.3",
    "rowCreatedAt": "2026-04-01T10:59:32.000Z",
    "rowPrice": "0.2475",
    "rowThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "dedupeKey": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75\u0000BUY",
    "winnerId": "cmnfy6q551p98mhsqujlu8gri",
    "winnerRecommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "winnerBand": "0.6-0.8",
    "winnerCreatedAt": "2026-04-01T11:13:37.242Z",
    "winnerPrice": "0.7525",
    "winnerThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "losesUnderCurrentSemantics": true,
    "whyLoses": "same dedupe key uses newest row winner",
    "classification": "replaced by newer row in different band"
  },
  {
    "rowId": "cmnfxlxvx0u4nmhsqx1u9me72",
    "recommendationId": "cmnfwv26r5rtynqomaarbzcu2",
    "marketId": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
    "side": "BUY",
    "rowBand": "0.2-0.3",
    "rowCreatedAt": "2026-04-01T10:57:27.502Z",
    "rowPrice": "0.2475",
    "rowThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "dedupeKey": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75\u0000BUY",
    "winnerId": "cmnfy6q551p98mhsqujlu8gri",
    "winnerRecommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "winnerBand": "0.6-0.8",
    "winnerCreatedAt": "2026-04-01T11:13:37.242Z",
    "winnerPrice": "0.7525",
    "winnerThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "losesUnderCurrentSemantics": true,
    "whyLoses": "same dedupe key uses newest row winner",
    "classification": "replaced by newer row in different band"
  },
  {
    "rowId": "cmnfxjc5w0qdcmhsq4flst7qv",
    "recommendationId": "cmnfwv26r5rtynqomaarbzcu2",
    "marketId": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
    "side": "BUY",
    "rowBand": "0.2-0.3",
    "rowCreatedAt": "2026-04-01T10:55:26.036Z",
    "rowPrice": "0.2475",
    "rowThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "dedupeKey": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75\u0000BUY",
    "winnerId": "cmnfy6q551p98mhsqujlu8gri",
    "winnerRecommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "winnerBand": "0.6-0.8",
    "winnerCreatedAt": "2026-04-01T11:13:37.242Z",
    "winnerPrice": "0.7525",
    "winnerThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "losesUnderCurrentSemantics": true,
    "whyLoses": "same dedupe key uses newest row winner",
    "classification": "replaced by newer row in different band"
  },
  {
    "rowId": "cmnfxgrf20jpemhsqlvnale92",
    "recommendationId": "cmnfwv26r5rtynqomaarbzcu2",
    "marketId": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75",
    "side": "BUY",
    "rowBand": "0.2-0.3",
    "rowCreatedAt": "2026-04-01T10:53:25.838Z",
    "rowPrice": "0.2475",
    "rowThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "dedupeKey": "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75\u0000BUY",
    "winnerId": "cmnfy6q551p98mhsqujlu8gri",
    "winnerRecommendationId": "cmnfxyc8j1cmdmhsqv4zvrpra",
    "winnerBand": "0.6-0.8",
    "winnerCreatedAt": "2026-04-01T11:13:37.242Z",
    "winnerPrice": "0.7525",
    "winnerThesis": {
      "strategyFamily": "reco_thesis",
      "strategyVariant": "momentum",
      "hypothesisType": "directional"
    },
    "losesUnderCurrentSemantics": true,
    "whyLoses": "same dedupe key uses newest row winner",
    "classification": "replaced by newer row in different band"
  }
]
```

## C. Collapse classification
```json
{
  "totalTargetRows": 11,
  "lostUnderCurrentSemantics": 11,
  "classificationCounts": {
    "replaced by newer row in different band": 11
  }
}
```

## D. Counterfactual
- Keys changed if winner preference is (0.2-0.3 -> 0.4-0.6 -> current newest): **1**
- Current good-band winners among dedupe keys: **0**
- Counterfactual good-band winners among dedupe keys: **1**
- Net good-band winner gain: **1**

## E. Blunt conclusion
**winner choice inside dedupe is the issue, not dedupe key itself**

## JSON summary
```json
{
  "generatedAt": "2026-04-01T12:24:45.988Z",
  "funder": "0x443e0af9c2ccbedb60ff866b45afd91ca3999e69",
  "lookbackMinutes": 720,
  "rawRowsScanned": 500,
  "targetBand": "0.2-0.3",
  "targetRows": 11,
  "targetUniqueRecommendationIds": 2,
  "targetUniqueMarkets": 1,
  "lostUnderCurrentSemantics": 11,
  "classificationCounts": {
    "replaced by newer row in different band": 11
  },
  "counterfactual": {
    "keysChanged": 1,
    "currentGoodWinners": 0,
    "counterfactualGoodWinners": 1,
    "netGain": 1
  },
  "bluntConclusion": "winner choice inside dedupe is the issue, not dedupe key itself"
}
```