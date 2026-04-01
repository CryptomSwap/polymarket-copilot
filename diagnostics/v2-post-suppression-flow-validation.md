# V2 Post-Suppression Flow Validation

- Generated: 2026-03-31T17:13:07.585Z
- Window: 24 dry-run ticks, cadence 500ms

## A. Flow funnel (aggregated)
- raw candidates: 240
- scored unique: 240 (100.00%)
- pass threshold unique: 72 (30.00%)
- survive filters unique: 72 (30.00%)
- eligible unique: 72 (30.00%)
- admitted unique: 120 (50.00%)

## B. Duplicate suppression impact
- total pre-suppressed already-open duplicates: 0
- suppression by botType: {}
- suppression by band: {}
- remaining final dedupe collisions: 0 (same-tick=0, existing-db=0, unique-constraint=0)

## C. Admission blockers after suppression
- below_threshold: 408

## D. Novel flow quality
- eligible unique non-duplicate candidates: 72
- admitted (from novel eligible pool): 72
- admission conversion from novel eligible pool: 100.00%

## E. Blunt conclusion
- suppression had little practical effect