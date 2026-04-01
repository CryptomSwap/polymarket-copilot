# V2 Band Allocation Quality Audit

- generated: 2026-03-31T19:12:03.898Z
- data source: repeated dry-run V2 ticks (60 ticks, cadence 500ms) + closed PaperTrade market/band proxy markouts
- sampled candidate observations: 600

## A. Overlay-era admitted performance by band
| band | count | avg score used | avg proxy markout | median proxy markout | win-rate proxy |
| --- | ---: | ---: | ---: | ---: | ---: |
| <0.1 | 0 | - | - | - | - |
| 0.1-0.2 | 0 | - | - | - | - |
| 0.2-0.3 | 0 | - | - | - | - |
| 0.3-0.4 | 0 | - | - | - | - |
| 0.4-0.6 | 0 | - | - | - | - |
| 0.6-0.8 | 0 | - | - | - | - |
| 0.8-0.9 | 0 | - | - | - | - |
| >=0.9 | 0 | - | - | - | - |

## B. Allocation share by band
| band | admitted share | threshold-pass share | scored share |
| --- | ---: | ---: | ---: |
| <0.1 | - | 25.00% | 30.00% |
| 0.1-0.2 | - | 0.00% | 40.00% |
| 0.2-0.3 | - | 25.00% | 10.00% |
| 0.3-0.4 | - | 0.00% | 0.00% |
| 0.4-0.6 | - | 50.00% | 20.00% |
| 0.6-0.8 | - | 0.00% | 0.00% |
| 0.8-0.9 | - | 0.00% | 0.00% |
| >=0.9 | - | 0.00% | 0.00% |

## C. Relative contribution
| band | contribution to total proxy PnL | contribution per admitted trade | overrepresented vs quality |
| --- | ---: | ---: | --- |
| <0.1 | - | - | unknown |
| 0.1-0.2 | - | - | unknown |
| 0.2-0.3 | - | - | unknown |
| 0.3-0.4 | - | - | unknown |
| 0.4-0.6 | - | - | unknown |
| 0.6-0.8 | - | - | unknown |
| 0.8-0.9 | - | - | unknown |
| >=0.9 | - | - | unknown |

## D. 0.1-0.2 deep dive
- admitted count: 0
- rejected count: 240
- avg score: 0.120625
- avg proxy markout: 0.000130
- avg proxy markout (other bands): 0.013063
- explicit drag verdict: 0.1-0.2 currently looks like a drag

## E. Blunt conclusion
- 0.1-0.2 is a clear drag and should be deprioritized