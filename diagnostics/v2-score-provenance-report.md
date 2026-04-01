# V2 Score Provenance Report

- Generated: 2026-03-31T14:33:38.098Z
- Env scorer switch: PAPER_TRADING_USE_STRUCTURED_SCORER=false

## A. End-to-end scorer path
- Candidate generation: `loadShadowCandidatesForPaperTick` in `lib/paper-trading/candidates.ts`.
- Score assignment switch: `runPaperTradingTickV2` in `lib/paper-trading/engine_v2_minimal.ts`.
- Structured path score field: `ScoredCandidate.score = structured blended score` from `scoreStructuredCandidates`.
- Shadow path score field: raw `shadowMlScore` is computed first, then band-aware overlay may set `ScoredCandidate.score` for global comparability.
- Ranking: `passedFilter.sort((a,b)=>b.score-a.score)` (descending).
- Thresholding: `if (score < threshold)` where `threshold = profile.threshold + profile.minScoreBuffer`.
- Admission/open create: `prisma.paperTrade.create({ score, threshold, ... })` using same `score` field.

## B. Effective score used at each stage
- Active scorer in live tick: shadow_ml
- `actualScoreUsedForOrdering/Threshold` is exactly `ScoredCandidate.score`.
- No later overwrite/switch after scoring map construction; downstream stages only filter/reject.

## C. Overwrite/switch points
- Single switch point: env gate `PAPER_TRADING_USE_STRUCTURED_SCORER`.
- No mid-pipeline scorer switch after the gate in current V2 path.

## D. Tick score provenance sample (top N)
```json
[
  {
    "recommendationId": "shadow:cmnej5aha1c93aj6xkpz0npp7",
    "assetId": "88275040060084773376557187972215267513049848642895776801789297917961077894224",
    "scorerSource": "shadow_ml",
    "structuredBaseScore": null,
    "structuredBlendedScore": null,
    "shadowMlScoreRaw": 0.9999999979388463,
    "shadowMlScoreCalibrated": 0.9655548041348389,
    "shadowBand": "0.4-0.6",
    "shadowBandRankScore": 1,
    "shadowBandSignal": 0.9,
    "shadowBandPenaltyMultiplier": 1.25,
    "finalBandAwareScore": 1,
    "actualScoreUsedForOrdering": 1,
    "actualScoreUsedForThreshold": 1,
    "thresholdApplied": 0.39999999999999997,
    "outcomes": [
      {
        "botType": "strict_quality",
        "admitted": false,
        "rejectReason": "dedupe"
      },
      {
        "botType": "relaxed_edge",
        "admitted": false,
        "rejectReason": "dedupe"
      },
      {
        "botType": "tail_extremes",
        "admitted": false,
        "rejectReason": "dedupe"
      }
    ]
  },
  {
    "recommendationId": "shadow:cmnemqjxc02zvu73oig3etop4",
    "assetId": "32338220190071351435772801779725302244575775216413325951443816017994629993401",
    "scorerSource": "shadow_ml",
    "structuredBaseScore": null,
    "structuredBlendedScore": null,
    "shadowMlScoreRaw": 0.9999999979388463,
    "shadowMlScoreCalibrated": 0.9655548041348389,
    "shadowBand": "<0.1",
    "shadowBandRankScore": 1,
    "shadowBandSignal": 0.15,
    "shadowBandPenaltyMultiplier": 1,
    "finalBandAwareScore": 0.7025,
    "actualScoreUsedForOrdering": 0.7025,
    "actualScoreUsedForThreshold": 0.7025,
    "thresholdApplied": 0.39999999999999997,
    "outcomes": [
      {
        "botType": "strict_quality",
        "admitted": false,
        "rejectReason": "dedupe"
      },
      {
        "botType": "relaxed_edge",
        "admitted": false,
        "rejectReason": "dedupe"
      },
      {
        "botType": "tail_extremes",
        "admitted": false,
        "rejectReason": "dedupe"
      }
    ]
  },
  {
    "recommendationId": "shadow:cmnemsj262vxru73o53sezccz",
    "assetId": "3842963720267267286970642336860752782302644680156535061700039388405652129691",
    "scorerSource": "shadow_ml",
    "structuredBaseScore": null,
    "structuredBlendedScore": null,
    "shadowMlScoreRaw": 0.9999999979388463,
    "shadowMlScoreCalibrated": 0.9655548041348389,
    "shadowBand": "0.2-0.3",
    "shadowBandRankScore": 0.5,
    "shadowBandSignal": 0.5,
    "shadowBandPenaltyMultiplier": 1,
    "finalBandAwareScore": 0.5,
    "actualScoreUsedForOrdering": 0.5,
    "actualScoreUsedForThreshold": 0.5,
    "thresholdApplied": 0.39999999999999997,
    "outcomes": [
      {
        "botType": "strict_quality",
        "admitted": false,
        "rejectReason": "dedupe"
      },
      {
        "botType": "relaxed_edge",
        "admitted": false,
        "rejectReason": "dedupe"
      },
      {
        "botType": "tail_extremes",
        "admitted": false,
        "rejectReason": "dedupe"
      }
    ]
  },
  {
    "recommendationId": "shadow:cmnemq1uz02b9u73o78xkfs4h",
    "assetId": "17516427576383382756368467656206258206490015951115433065318503962238754362428",
    "scorerSource": "shadow_ml",
    "structuredBaseScore": null,
    "structuredBlendedScore": null,
    "shadowMlScoreRaw": 0.9999999979388463,
    "shadowMlScoreCalibrated": 0.9655548041348389,
    "shadowBand": "0.4-0.6",
    "shadowBandRankScore": 0,
    "shadowBandSignal": 0.9,
    "shadowBandPenaltyMultiplier": 1.25,
    "finalBandAwareScore": 0.39375,
    "actualScoreUsedForOrdering": 0.39375,
    "actualScoreUsedForThreshold": 0.39375,
    "thresholdApplied": 0.39999999999999997,
    "outcomes": [
      {
        "botType": "strict_quality",
        "admitted": false,
        "rejectReason": "below_threshold"
      },
      {
        "botType": "relaxed_edge",
        "admitted": false,
        "rejectReason": "dedupe"
      },
      {
        "botType": "tail_extremes",
        "admitted": false,
        "rejectReason": "dedupe"
      }
    ]
  },
  {
    "recommendationId": "shadow:cmnemsiei2vvsu73o32vop2u7",
    "assetId": "55935183786009449883683540312350046975246300613283087403691731856990327029236",
    "scorerSource": "shadow_ml",
    "structuredBaseScore": null,
    "structuredBlendedScore": null,
    "shadowMlScoreRaw": 0.9999999979388463,
    "shadowMlScoreCalibrated": 0.9655548041348389,
    "shadowBand": "<0.1",
    "shadowBandRankScore": 0.5,
    "shadowBandSignal": 0.15,
    "shadowBandPenaltyMultiplier": 1,
    "finalBandAwareScore": 0.3775,
    "actualScoreUsedForOrdering": 0.3775,
    "actualScoreUsedForThreshold": 0.3775,
    "thresholdApplied": 0.39999999999999997,
    "outcomes": [
      {
        "botType": "strict_quality",
        "admitted": false,
        "rejectReason": "below_threshold"
      },
      {
        "botType": "relaxed_edge",
        "admitted": false,
        "rejectReason": "dedupe"
      },
      {
        "botType": "tail_extremes",
        "admitted": false,
        "rejectReason": "dedupe"
      }
    ]
  },
  {
    "recommendationId": "shadow:cmnelqphn2spbk4ft60vkqfhz",
    "assetId": "98250445447699368679516529207365255018790721464590833209064266254238063117329",
    "scorerSource": "shadow_ml",
    "structuredBaseScore": null,
    "structuredBlendedScore": null,
    "shadowMlScoreRaw": 0.9999999979388463,
    "shadowMlScoreCalibrated": 0.9655548041348389,
    "shadowBand": "0.1-0.2",
    "shadowBandRankScore": 1,
    "shadowBandSignal": 0.45,
    "shadowBandPenaltyMultiplier": 0.25,
    "finalBandAwareScore": 0.201875,
    "actualScoreUsedForOrdering": 0.201875,
    "actualScoreUsedForThreshold": 0.201875,
    "thresholdApplied": 0.39999999999999997,
    "outcomes": [
      {
        "botType": "strict_quality",
        "admitted": false,
        "rejectReason": "below_threshold"
      },
      {
        "botType": "relaxed_edge",
        "admitted": false,
        "rejectReason": "below_threshold"
      },
      {
        "botType": "tail_extremes",
        "admitted": false,
        "rejectReason": "below_threshold"
      }
    ]
  },
  {
    "recommendationId": "shadow:cmnemsidg2vv8u73ojzgh48vp",
    "assetId": "108233603819467706476318984012158651931658302669301887462181073562758483842092",
    "scorerSource": "shadow_ml",
    "structuredBaseScore": null,
    "structuredBlendedScore": null,
    "shadowMlScoreRaw": 0.9999999979388463,
    "shadowMlScoreCalibrated": 0.9655548041348389,
    "shadowBand": "0.1-0.2",
    "shadowBandRankScore": 0.6666666666666667,
    "shadowBandSignal": 0.45,
    "shadowBandPenaltyMultiplier": 0.25,
    "finalBandAwareScore": 0.14770833333333336,
    "actualScoreUsedForOrdering": 0.14770833333333336,
    "actualScoreUsedForThreshold": 0.14770833333333336,
    "thresholdApplied": 0.39999999999999997,
    "outcomes": [
      {
        "botType": "strict_quality",
        "admitted": false,
        "rejectReason": "below_threshold"
      },
      {
        "botType": "relaxed_edge",
        "admitted": false,
        "rejectReason": "below_threshold"
      },
      {
        "botType": "tail_extremes",
        "admitted": false,
        "rejectReason": "below_threshold"
      }
    ]
  },
  {
    "recommendationId": "shadow:cmnemsjj82vzfu73oqzqdolfn",
    "assetId": "18548531003403642447433063414362700271595227164711314812182704727637563149074",
    "scorerSource": "shadow_ml",
    "structuredBaseScore": null,
    "structuredBlendedScore": null,
    "shadowMlScoreRaw": 0.9999999979388463,
    "shadowMlScoreCalibrated": 0.9655548041348389,
    "shadowBand": "0.1-0.2",
    "shadowBandRankScore": 0.33333333333333337,
    "shadowBandSignal": 0.45,
    "shadowBandPenaltyMultiplier": 0.25,
    "finalBandAwareScore": 0.09354166666666668,
    "actualScoreUsedForOrdering": 0.09354166666666668,
    "actualScoreUsedForThreshold": 0.09354166666666668,
    "thresholdApplied": 0.39999999999999997,
    "outcomes": [
      {
        "botType": "strict_quality",
        "admitted": false,
        "rejectReason": "below_threshold"
      },
      {
        "botType": "relaxed_edge",
        "admitted": false,
        "rejectReason": "below_threshold"
      },
      {
        "botType": "tail_extremes",
        "admitted": false,
        "rejectReason": "below_threshold"
      }
    ]
  },
  {
    "recommendationId": "shadow:cmnemsle72w5du73oxewtjqrs",
    "assetId": "18812649149814341758733697580460697418474693998558159483117100240528657629879",
    "scorerSource": "shadow_ml",
    "structuredBaseScore": null,
    "structuredBlendedScore": null,
    "shadowMlScoreRaw": 0.9999999979388463,
    "shadowMlScoreCalibrated": 0.9655548041348389,
    "shadowBand": "<0.1",
    "shadowBandRankScore": 0,
    "shadowBandSignal": 0.15,
    "shadowBandPenaltyMultiplier": 1,
    "finalBandAwareScore": 0.0525,
    "actualScoreUsedForOrdering": 0.0525,
    "actualScoreUsedForThreshold": 0.0525,
    "thresholdApplied": 0.39999999999999997,
    "outcomes": [
      {
        "botType": "strict_quality",
        "admitted": false,
        "rejectReason": "below_threshold"
      },
      {
        "botType": "relaxed_edge",
        "admitted": false,
        "rejectReason": "below_threshold"
      },
      {
        "botType": "tail_extremes",
        "admitted": false,
        "rejectReason": "below_threshold"
      }
    ]
  },
  {
    "recommendationId": "shadow:cmnemsjq62w00u73opdynryao",
    "assetId": "35573117698117780238142713946749692621043319879346349609080985768472429209643",
    "scorerSource": "shadow_ml",
    "structuredBaseScore": null,
    "structuredBlendedScore": null,
    "shadowMlScoreRaw": 0.9999999979388463,
    "shadowMlScoreCalibrated": 0.9655548041348389,
    "shadowBand": "0.1-0.2",
    "shadowBandRankScore": 0,
    "shadowBandSignal": 0.45,
    "shadowBandPenaltyMultiplier": 0.25,
    "finalBandAwareScore": 0.039375,
    "actualScoreUsedForOrdering": 0.039375,
    "actualScoreUsedForThreshold": 0.039375,
    "thresholdApplied": 0.39999999999999997,
    "outcomes": [
      {
        "botType": "strict_quality",
        "admitted": false,
        "rejectReason": "below_threshold"
      },
      {
        "botType": "relaxed_edge",
        "admitted": false,
        "rejectReason": "below_threshold"
      },
      {
        "botType": "tail_extremes",
        "admitted": false,
        "rejectReason": "below_threshold"
      }
    ]
  }
]
```

## E. Inversion source assessment
- Evidence artifact check: Top bucket ([1.000, 1.000)) avg markout >= mid bucket ([0.478, 0.526)).
- Shadow path currently applies band-aware overlay (raw shadow score retained in provenance alongside final score).
- Downstream filters (spread/caps/dedupe) can change admitted set composition, but they do not alter the ranking score value itself.