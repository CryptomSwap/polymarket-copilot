# V2 Eligible To Admission Conversion Audit

- Generated: 2026-03-31T19:32:19.785Z
- Window: 24 dry-run ticks, cadence 500ms

## A. Eligible set
- unique candidates passing threshold and surviving filters: 96
- per-bot eligible decision rows: 264
- by band: {"0.2-0.3":24,"0.4-0.6":48,"<0.1":24}
- by botType (decision rows): {"strict_quality":72,"relaxed_edge":96,"tail_extremes":96}

## B. Final outcome mapping
| tickTime | recommendationId | band | botTypes | admitted | final reason | blocker class |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-03-31T19:32:19.787Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:19.787Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:19.787Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:19.787Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:20.630Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:20.630Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:20.630Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:20.630Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:21.219Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:21.219Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:21.219Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:21.219Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:21.790Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:21.790Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:21.790Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:21.790Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:22.357Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:22.357Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:22.357Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:22.357Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:22.927Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:22.927Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:22.927Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:22.927Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:23.495Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:23.495Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:23.495Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:23.495Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:24.067Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:24.067Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:24.067Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:24.067Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:24.635Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:24.635Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:24.635Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:24.635Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:25.207Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:25.207Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:25.207Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:25.207Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:25.830Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:25.830Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:25.830Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:25.830Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:26.404Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:26.404Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:26.404Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:26.404Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:26.977Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:26.977Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:26.977Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:26.977Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:27.548Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:27.548Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:27.548Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:27.548Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:28.121Z | shadow:cmnemsj262vxru73o53sezccz | 0.2-0.3 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:28.121Z | shadow:cmnemq1uz02b9u73o78xkfs4h | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:28.121Z | shadow:cmnej5aha1c93aj6xkpz0npp7 | 0.4-0.6 | strict_quality,relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
| 2026-03-31T19:32:28.121Z | shadow:cmnemqjxc02zvu73oig3etop4 | <0.1 | relaxed_edge,tail_extremes | no | dedupe | open-row collision / already-open exposure |
- truncated 36 additional mapping rows

## C. Dry-run vs real-path distinction
- Primary conversion evidence in this report is from dry-run trace simulation.
- In dry-run, admission decisions are simulated and not inserted by this script.
- Persisted V2 rows in same approximate wall-clock window: 0

## D. Collision accounting sanity
- unique eligible candidates: 96
- per-bot eligible decision rows: 264
- admitted unique candidates: 0
- blocker counts (unique-candidate mapped): {"dedupe":96}
- blocker classes (unique-candidate mapped): {"open-row collision / already-open exposure":96}
- dedupe subtype counters (tick aggregate): preSuppressedAlreadyOpen=264, openRowCollision=0, existingDbCollision=0, sameTickCollision=0, closedRowBypassed=0
- Count differences are expected because reject totals are per-bot decision rows, while mapping is collapsed to unique candidates.

## E. Blunt conclusion
- evidence insufficient