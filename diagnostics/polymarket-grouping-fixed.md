# Polymarket Grouping Fixed Verification

- Generated: 2026-03-31T20:49:04.312Z
- Source-of-truth grouping endpoint: `https://gamma-api.polymarket.com/events`
- Fields used from events payload: `id` (eventId), `series[0].id` (group series id), `series[0].title` / `title`
- Mapping to SyncedMarket: by `markets[].conditionId` first, fallback by market `slug`

## Backfill run
- Synced markets scanned: 530
- Updated markets: 0
- Matched by conditionId: 0
- Matched by slug fallback: 0
- Event fetch errors: 0

## Before vs after grouping stats
| metric | before | after |
| --- | ---: | ---: |
| markets with eventId | 0 | 0 |
| markets with groupKey | 0 | 0 |
| groups formed | 0 | 0 |
| avg group size | 0.00 | 0.00 |
| groups >=2 | 0 | 0 |
| max group size | 0 | 0 |

## Example groups (top 5)
| groupKey | size | category | sample titles |
| --- | ---: | --- | --- |

## Blunt conclusion
- grouping still insufficient