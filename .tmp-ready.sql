SELECT COUNT(*)::int AS closed_with_markout_after_cutoff
FROM "PaperTrade"
WHERE "entryTime" >= '2026-03-24T23:08:00.000Z'
  AND status = 'closed'
  AND ("markout12h" IS NOT NULL OR "pnlPct" IS NOT NULL);

SELECT COUNT(*)::int AS all_trades_after_cutoff
FROM "PaperTrade"
WHERE "entryTime" >= '2026-03-24T23:08:00.000Z';

SELECT COUNT(*)::int AS open_trades_after_cutoff
FROM "PaperTrade"
WHERE "entryTime" >= '2026-03-24T23:08:00.000Z'
  AND status = 'open';

SELECT MIN("entryTime") AS min_entry_time, MAX("entryTime") AS max_entry_time
FROM "PaperTrade"
WHERE "entryTime" >= '2026-03-24T23:08:00.000Z';
