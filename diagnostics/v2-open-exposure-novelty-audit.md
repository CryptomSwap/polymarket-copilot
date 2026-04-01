# V2 Open Exposure Novelty Audit

- Generated: 2026-03-31T19:38:46.639Z
- Window: 24 dry-run ticks, cadence 500ms

## A. Open inventory snapshot
- currently open V2 positions: 11
- by botType: {"strict_quality":3,"relaxed_edge":4,"tail_extremes":4}
- by band: {"0.4-0.6":6,"0.2-0.3":3,"<0.1":2}
- distinct open exposure keys (botType|assetId|side): 11

## B. Candidate novelty breakdown
- total raw candidates: 240
- total scored unique candidates: 240
- total eligible unique candidates: 96
- eligible unique candidates matching already-open exposure (recommendation-level): 4
- eligible unique candidates novel (recommendation-level): 0
- eligible unique candidate-bot exposures: 12
- eligible unique duplicate exposures (candidate-bot): 11
- eligible unique novel exposures (candidate-bot): 1

## C. Quality of novel vs duplicate candidates
- duplicate eligible rows: 264
- duplicate avg score: 0.601818
- duplicate band mix: {"0.2-0.3":72,"0.4-0.6":144,"<0.1":48}
- duplicate proxy quality (band-based): 0.087022
- novel eligible rows: 24
- novel avg score: 0.351250
- novel band mix: {"<0.1":24}
- novel proxy quality (band-based): -0.003240

## D. Opportunity concentration
- repeated collision events (eligible rows colliding with open exposures): 264
- top-5 collision share: 45.45%
| botType|assetId|side | collision events |
| --- | ---: |
| strict_quality|3842963720267267286970642336860752782302644680156535061700039388405652129691|BUY | 24 |
| relaxed_edge|3842963720267267286970642336860752782302644680156535061700039388405652129691|BUY | 24 |
| tail_extremes|3842963720267267286970642336860752782302644680156535061700039388405652129691|BUY | 24 |
| strict_quality|17516427576383382756368467656206258206490015951115433065318503962238754362428|BUY | 24 |
| relaxed_edge|17516427576383382756368467656206258206490015951115433065318503962238754362428|BUY | 24 |
| tail_extremes|17516427576383382756368467656206258206490015951115433065318503962238754362428|BUY | 24 |
| strict_quality|88275040060084773376557187972215267513049848642895776801789297917961077894224|BUY | 24 |
| relaxed_edge|88275040060084773376557187972215267513049848642895776801789297917961077894224|BUY | 24 |
| tail_extremes|88275040060084773376557187972215267513049848642895776801789297917961077894224|BUY | 24 |
| relaxed_edge|32338220190071351435772801779725302244575775216413325951443816017994629993401|BUY | 24 |
| tail_extremes|32338220190071351435772801779725302244575775216413325951443816017994629993401|BUY | 24 |

## E. Blunt conclusion
- candidate set lacks novelty and needs broader opportunity generation

## JSON summary
```json
{
  "generatedAt": "2026-03-31T19:38:46.639Z",
  "window": {
    "ticks": 24,
    "cadenceMs": 500
  },
  "openInventory": {
    "openCount": 11,
    "byBotType": {
      "strict_quality": 3,
      "relaxed_edge": 4,
      "tail_extremes": 4
    },
    "byBand": {
      "0.4-0.6": 6,
      "0.2-0.3": 3,
      "<0.1": 2
    },
    "distinctOpenExposureKeys": 11,
    "topOpenExposureKeys": [
      [
        "strict_quality|88275040060084773376557187972215267513049848642895776801789297917961077894224|BUY",
        1
      ],
      [
        "strict_quality|3842963720267267286970642336860752782302644680156535061700039388405652129691|BUY",
        1
      ],
      [
        "strict_quality|17516427576383382756368467656206258206490015951115433065318503962238754362428|BUY",
        1
      ],
      [
        "relaxed_edge|88275040060084773376557187972215267513049848642895776801789297917961077894224|BUY",
        1
      ],
      [
        "relaxed_edge|3842963720267267286970642336860752782302644680156535061700039388405652129691|BUY",
        1
      ],
      [
        "relaxed_edge|17516427576383382756368467656206258206490015951115433065318503962238754362428|BUY",
        1
      ],
      [
        "relaxed_edge|32338220190071351435772801779725302244575775216413325951443816017994629993401|BUY",
        1
      ],
      [
        "tail_extremes|88275040060084773376557187972215267513049848642895776801789297917961077894224|BUY",
        1
      ],
      [
        "tail_extremes|3842963720267267286970642336860752782302644680156535061700039388405652129691|BUY",
        1
      ],
      [
        "tail_extremes|17516427576383382756368467656206258206490015951115433065318503962238754362428|BUY",
        1
      ],
      [
        "tail_extremes|32338220190071351435772801779725302244575775216413325951443816017994629993401|BUY",
        1
      ]
    ]
  },
  "noveltyBreakdown": {
    "totalRawCandidates": 240,
    "totalScoredUnique": 240,
    "totalEligibleUnique": 96,
    "duplicateEligibleUniqueRecommendationLevel": 4,
    "novelEligibleUniqueRecommendationLevel": 0,
    "eligibleExposureUnique": 12,
    "duplicateExposureUnique": 11,
    "novelExposureUnique": 1
  },
  "quality": {
    "duplicate": {
      "rows": 264,
      "avgScore": 0.6018181818181804,
      "bandMix": {
        "0.2-0.3": 72,
        "0.4-0.6": 144,
        "<0.1": 48
      },
      "proxyBandMarkoutAvg": 0.08702202097601164
    },
    "novel": {
      "rows": 24,
      "avgScore": 0.35125000000000006,
      "bandMix": {
        "<0.1": 24
      },
      "proxyBandMarkoutAvg": -0.003239627117517426
    }
  },
  "opportunityConcentration": {
    "collisionEvents": 264,
    "top5Share": 0.45454545454545453,
    "topRepeatedCollisionKeys": [
      [
        "strict_quality|3842963720267267286970642336860752782302644680156535061700039388405652129691|BUY",
        24
      ],
      [
        "relaxed_edge|3842963720267267286970642336860752782302644680156535061700039388405652129691|BUY",
        24
      ],
      [
        "tail_extremes|3842963720267267286970642336860752782302644680156535061700039388405652129691|BUY",
        24
      ],
      [
        "strict_quality|17516427576383382756368467656206258206490015951115433065318503962238754362428|BUY",
        24
      ],
      [
        "relaxed_edge|17516427576383382756368467656206258206490015951115433065318503962238754362428|BUY",
        24
      ],
      [
        "tail_extremes|17516427576383382756368467656206258206490015951115433065318503962238754362428|BUY",
        24
      ],
      [
        "strict_quality|88275040060084773376557187972215267513049848642895776801789297917961077894224|BUY",
        24
      ],
      [
        "relaxed_edge|88275040060084773376557187972215267513049848642895776801789297917961077894224|BUY",
        24
      ],
      [
        "tail_extremes|88275040060084773376557187972215267513049848642895776801789297917961077894224|BUY",
        24
      ],
      [
        "relaxed_edge|32338220190071351435772801779725302244575775216413325951443816017994629993401|BUY",
        24
      ],
      [
        "tail_extremes|32338220190071351435772801779725302244575775216413325951443816017994629993401|BUY",
        24
      ]
    ]
  },
  "conclusion": "candidate set lacks novelty and needs broader opportunity generation"
}
```