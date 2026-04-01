# V2 Admission Blockers Audit

- Generated: 2026-03-31T17:12:08.714Z
- Mode: dry-run V2 tick (read-only)
- Scorer source: shadow_ml

## A. Eligible set
- eligible outcomes (passed threshold + survived liquidity filters, per bot decision): 13
- eligible unique candidates: 5
- pre-admission suppressed already-open exposures: 0
- suppression by botType: {}
- suppression by band: {}

## B. Admission outcomes (eligible only)
| recommendationId | botType | marketId | side | score | outcome | reject reason |
| --- | --- | --- | --- | ---: | --- | --- |
| shadow:cmnej5aha1c93aj6xkpz0npp7 | strict_quality | 0x50ddb9cd80d5c271664a2ebb7fcaed1d0a148d82c8e8d314d830f75a944c3dcc | BUY | 1.000000 | admitted | - |
| shadow:cmnemqjxc02zvu73oig3etop4 | strict_quality | 0xa467b14d51f01b957109d9cbb1d6c124fab2a089d52ed8f471d23c2812e743b7 | BUY | 0.702500 | admitted | - |
| shadow:cmnemsj262vxru73o53sezccz | strict_quality | 0xb48621f7eba07b0a3eeabc6afb09ae42490239903997b9d412b0f69aeb040c8b | BUY | 0.500000 | admitted | - |
| shadow:cmnej5aha1c93aj6xkpz0npp7 | relaxed_edge | 0x50ddb9cd80d5c271664a2ebb7fcaed1d0a148d82c8e8d314d830f75a944c3dcc | BUY | 1.000000 | admitted | - |
| shadow:cmnemqjxc02zvu73oig3etop4 | relaxed_edge | 0xa467b14d51f01b957109d9cbb1d6c124fab2a089d52ed8f471d23c2812e743b7 | BUY | 0.702500 | admitted | - |
| shadow:cmnemsj262vxru73o53sezccz | relaxed_edge | 0xb48621f7eba07b0a3eeabc6afb09ae42490239903997b9d412b0f69aeb040c8b | BUY | 0.500000 | admitted | - |
| shadow:cmnemq1uz02b9u73o78xkfs4h | relaxed_edge | 0x7b49b9bacb5f435bc10f3b100ff59e2fdd346f7f92a9001881bc9825a0af0f11 | BUY | 0.393750 | admitted | - |
| shadow:cmnemsiei2vvsu73o32vop2u7 | relaxed_edge | 0x9be56371f6a29d12769b2f196847ee825b9585ebb8bfa042136be031b081eba1 | BUY | 0.377500 | admitted | - |
| shadow:cmnej5aha1c93aj6xkpz0npp7 | tail_extremes | 0x50ddb9cd80d5c271664a2ebb7fcaed1d0a148d82c8e8d314d830f75a944c3dcc | BUY | 1.000000 | admitted | - |
| shadow:cmnemqjxc02zvu73oig3etop4 | tail_extremes | 0xa467b14d51f01b957109d9cbb1d6c124fab2a089d52ed8f471d23c2812e743b7 | BUY | 0.702500 | admitted | - |
| shadow:cmnemsj262vxru73o53sezccz | tail_extremes | 0xb48621f7eba07b0a3eeabc6afb09ae42490239903997b9d412b0f69aeb040c8b | BUY | 0.500000 | admitted | - |
| shadow:cmnemq1uz02b9u73o78xkfs4h | tail_extremes | 0x7b49b9bacb5f435bc10f3b100ff59e2fdd346f7f92a9001881bc9825a0af0f11 | BUY | 0.393750 | admitted | - |
| shadow:cmnemsiei2vvsu73o32vop2u7 | tail_extremes | 0x9be56371f6a29d12769b2f196847ee825b9585ebb8bfa042136be031b081eba1 | BUY | 0.377500 | admitted | - |

## C. Reject reason breakdown (eligible set)

## D. Dedupe deep dive
- dedupe-rejected outcomes: 0
- collision split: already-open-suppressed=0, same-tick=0, existing-db=0, unique-constraint=0, open-row=0, closed-row=13, closed-row-bypassed=13
- dedupe collision groups (botType|assetId|side): 0
| dedupe grouping key | collisions | preserved recommendation | preserved score | suppressed recommendations | suppressed scores | top-score preserved |
| --- | ---: | --- | ---: | --- | --- | --- |

### D1. Dedupe-rejected candidates vs existing open positions
| recommendationId | botType | side | score | existing open trades (same bot+asset+side) |
| --- | --- | --- | ---: | ---: |
- dedupe rejects with existing open-trade collision: 0 / 0
- Dedupe behavior indicates prevention of multiple entries for the same botType+assetId+side within the same tick/bucket.

## E. Score vs admission
- admitted avg score (eligible set): 0.626923
- rejected avg score (eligible set): -
- dedupe preserved avg score: -
- dedupe suppressed avg score: -

## F. Blunt conclusion
- evidence insufficient