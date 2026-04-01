# V2 Post-Dedupe-Fix Performance Baseline

- Generated: 2026-03-31T18:42:23.233Z

## A. Regime definition
- start point: 2026-03-31T17:11:34.778Z
- detection rule: engine file mtime fallback (lib/paper-trading/engine_v2_minimal.ts)
- reliability note: medium (code deployment-time proxy)

## B. Flow summary
- opens (post-fix): 0
- closed (post-fix): 0
- close rate: -
- admitted per tick proxy (per-minute opens) avg/median/max: - / - / -
- sample size note: small sample; interpret cautiously

## C. Performance by band (post-fix opens)
| band | count | avg score used | avg markout/proxy | median | win rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| <0.1 | 0 | - | - | - | - |
| 0.1-0.2 | 0 | - | - | - | - |
| 0.2-0.3 | 0 | - | - | - | - |
| 0.3-0.4 | 0 | - | - | - | - |
| 0.4-0.6 | 0 | - | - | - | - |
| 0.6-0.8 | 0 | - | - | - | - |
| 0.8-0.9 | 0 | - | - | - | - |
| >=0.9 | 0 | - | - | - | - |

## D. Contribution by band
| band | share of opens | share of closed | share of markout/proxy PnL |
| --- | ---: | ---: | ---: |
| <0.1 | - | - | - |
| 0.1-0.2 | - | - | - |
| 0.2-0.3 | - | - | - |
| 0.3-0.4 | - | - | - |
| 0.4-0.6 | - | - | - |
| 0.6-0.8 | - | - | - |
| 0.8-0.9 | - | - | - |
| >=0.9 | - | - | - |

## E. Size-matched immediate pre-fix comparison
- pre-fix window size-matched opens: 0
- pre-fix closed: 0
- pre-fix close rate: -
- pre-fix avg markout/proxy: -
- post-fix avg markout/proxy: -
- delta post-minus-pre: 0.000000

## E2. Empty-cohort diagnostics (temporary)
- no valid explicit supplied timestamp; cannot compute around-start buckets.
- rows with metadataJson.scoreProvenance across all V2 rows: 11

## F. Blunt conclusion
- evidence insufficient