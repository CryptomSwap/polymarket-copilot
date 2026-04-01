# V2 Spread Near-Miss Recovery Audit

## A. Window / sample definition
- generated: 2026-03-31T13:36:20.414Z
- source: repeated dry-run V2 ticks (60 ticks, cadence 500ms) + ShadowCandidate spread/markout proxy
- sampled trace rows: 1797
- spread cutoff: 500 bps
- segment definitions: near (500, 550.000], medium (550.000, 600.000], far > 600.000 bps
- proxy source coverage: paper_market_proxy=1797

## B. Near vs medium vs far spread rejects
| segment | count | avg score used | avg proxy markout | win-rate proxy | price-band mix |
| --- | ---: | ---: | ---: | ---: | --- |
| near (0% to +10%) | 180 | 0.498750 | -0.005808 | 0.00% | <0.1:0, 0.1-0.2:180, 0.2-0.3:0, 0.3-0.4:0, 0.4-0.6:0, 0.6-0.8:0, 0.8-0.9:0, >=0.9:0 |
| medium (+10% to +20%) | 0 | - | - | - | <0.1:0, 0.1-0.2:0, 0.2-0.3:0, 0.3-0.4:0, 0.4-0.6:0, 0.6-0.8:0, 0.8-0.9:0, >=0.9:0 |
| far (>+20%) | 0 | - | - | - | <0.1:0, 0.1-0.2:0, 0.2-0.3:0, 0.3-0.4:0, 0.4-0.6:0, 0.6-0.8:0, 0.8-0.9:0, >=0.9:0 |

## C. Compare against admitted cohort
- admitted count: 906
- admitted avg score used: 0.649727
- admitted avg proxy markout: -0.000062
- admitted median proxy markout: 0.000255
- admitted win-rate proxy: 59.27%
- admitted band mix: <0.1:171, 0.1-0.2:0, 0.2-0.3:177, 0.3-0.4:0, 0.4-0.6:0, 0.6-0.8:180, 0.8-0.9:180, >=0.9:198
- near (0% to +10%) delta vs admitted (avg proxy): -0.005746
- medium (+10% to +20%) delta vs admitted (avg proxy): 0.000062
- far (>+20%) delta vs admitted (avg proxy): 0.000062

## D. Near-vs-far differential
- near-minus-far avg proxy markout delta: -0.005808
- medium-minus-far avg proxy markout delta: 0.000000

## E. Band-level near-miss quality
| band | near count | near avg | medium count | medium avg | far count | far avg | admitted count | admitted avg | near-admitted delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| <0.1 | 0 | - | 0 | - | 0 | - | 171 | 0.002606 | -0.002606 |
| 0.1-0.2 | 180 | -0.005808 | 0 | - | 0 | - | 0 | - | -0.005808 |
| 0.2-0.3 | 0 | - | 0 | - | 0 | - | 177 | 0.001874 | -0.001874 |
| 0.6-0.8 | 0 | - | 0 | - | 0 | - | 180 | -0.000756 | 0.000756 |
| 0.8-0.9 | 0 | - | 0 | - | 0 | - | 180 | 0.000255 | -0.000255 |
| >=0.9 | 0 | - | 0 | - | 0 | - | 198 | -0.003753 | 0.003753 |

## E2. Stability note
- stability assessment: too sparse

## F. Blunt conclusion
- spread near-misses do not look recoverable