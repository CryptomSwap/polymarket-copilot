# ML Phased Roadmap

Run `npm run dump:ml:phased-roadmap` for the full report.

## Constraints

- Do not remove or weaken hard safety/risk rules.
- Do not make ML a direct autonomous trader.
- Preserve current behavior unless explicitly gated.

## Phases (summary)

1. **Observability and structure** — Architecture map, multi-role types, target registry, segmented/calibration reports, config gating (done).
2. **Label and evaluation expansion** — Populate 6h/12h labels in shadow build; segmented report with scores; optional calibration.
3. **Exploration and champion/challenger** — Enable paper exploration allocator in staging; parallel champion/challenger scoring; comparison dumps.
4. **Execution realism** — Spread-adjusted and realizable-PnL targets; segment evaluation by spread/liquidity.

See `dump/ml-phased-roadmap-report.md` for the full list.
