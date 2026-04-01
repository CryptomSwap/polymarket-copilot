# V2 Dedupe Key Mismatch Audit

- Generated: 2026-03-31T17:12:08.357Z
- Window: 12 dry-run ticks, cadence 500ms
- Active modelRunId: cmmzim5va0000r71pd04vuyfe

## A. Early suppression rule
- Source: `lib/paper-trading/engine_v2_minimal.ts` in `runPaperTradingTickV2`.
- Predicate (env-gated): suppress candidate when `PAPER_V2_SUPPRESS_ALREADY_OPEN_DUPLICATE_EXPOSURES` is enabled AND there is an **open** `PaperTrade` with same `botType + assetId + side`.
- Fields used: `status=open`, `botType`, `assetId`, `side`.

## B. Final dedupe rule
- Source: `lib/paper-trading/engine_v2_minimal.ts` in `runPaperTradingTickV2`.
- Final DB dedupe check uses `findUnique({ where: { dedupeKey } })`.
- `dedupeKey` semantics: `${modelRunId}|v2|${botType}|${assetId}|${side}|${timeBucket(cooldownHours)}`.
- This check is status-agnostic (open or closed row can collide if dedupeKey exists).

## C. Side-by-side mismatch sample
| recommendationId | botType | assetId | side | score | early(open same exposure count) | final dedupe key | final row status | missed early? | blocked final? | why missed early | why blocked final |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- |

## D. Collision taxonomy
- already-open same botType+assetId+side: 0
- dedupeKey/time-bucket collision: 0
- existing PaperTrade row missed by open-only early check: 0
- unique constraint collision: 0
- other: 0

## E. Blunt conclusion
- mixed causes