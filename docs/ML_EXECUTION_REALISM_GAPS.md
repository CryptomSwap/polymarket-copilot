# ML Execution Realism Gaps

Current labels are based on mark-to-market price movement (markout). They measure “price was right” more than “trade was realistically good” (after costs and fill).

## Gap summary

Run `npm run dump:ml:execution-realism-gap` for the full report. Main gaps:

- **Spread realism**: Entry/exit assume mid; real fills at bid/ask.
- **Liquidity realism**: Label does not condition on fill feasibility.
- **Fill realism**: Full fill at entry price assumed; partial fills not modeled.
- **Slippage**: Not applied in markout.
- **Label interpretation**: Favorable move vs realizable PnL after costs.

## Additive plan

1. Keep current markout-based labels; add spread-adjusted and realizable-PnL as optional targets.
2. Attach execution-quality snapshot to training rows for segmenting.
3. Segment evaluation by spread/liquidity; report metrics per segment.
4. Do not change live execution or safety rules.

See `dump/ml-execution-realism-gap-report.md` after running the dump.
