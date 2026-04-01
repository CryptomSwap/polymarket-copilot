# V2 Post-Fix Persistence Audit

- Generated: 2026-03-31T17:53:12.956Z
- Audit window start: 2026-03-30T17:53:12.956Z
- Audit window source: fallback:24h

## A. Persistence reality check
- V2 PaperTrade rows created after window start: 83
- status split: open=0, closed=83
- rows with dedupeKey '|reopen|': 0
- rows with metadataJson.scoreProvenance: 11
- rows with metadata marker 'closedRowBypassed': 0
- first row in window: 2026-03-30T18:23:19.579Z (cmndinml60000wic6p9539vhl)
- last row in window: 2026-03-31T14:33:25.327Z (cmnepvtjj0000vc538nm6fts7)

## B. Detector audit
- current detector rule: regime start = first PaperTrade where dedupeKey contains '|reopen|' (from v2 post-dedupe baseline script)
- why detector missed: No persisted PaperTrade row currently has dedupeKey '|reopen|'; rule cannot anchor a post-fix regime.
- alternative detector candidates:
  - createdAt >= explicit fix deployment timestamp (env-defined)
  - first row where dedupeCollisionBreakdown.closedRowBypassed > 0 (if persisted)
  - first row with explicit persisted post-fix marker in metadataJson
  - first row with dedupeKey '|reopen|' (works only if that key path is persisted in non-dry-run opens)

## C. Runtime vs persistence mismatch
- dry-run evidence present in admission blockers audit: true
- dry-run evidence present in post-suppression flow validation: false
- dry-run evidence present in dedupe mismatch audit: false
- summary: major recent evidence is from dry-run diagnostics; DB persistence must be verified separately

## D. Minimal recommendation for measurement
- better detector only

## E. Blunt conclusion
- post-fix opens are persisting; detector is wrong