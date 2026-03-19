# Shadow Model Offline Backtest

Offline backtest for the shadow ML model: scores historical `MlShadowTrainingExample` rows, simulates taking trades when score ≥ threshold, and reports PnL using a **starting bankroll** and **fixed fraction of bankroll per trade**. Uses `intendedPrice` / `markout12h` with optional slippage and transaction cost.

**No live trading or execution integration** — simulation only.

## Baseline

- **Target:** `labelGoodDecision12h`
- **Thresholds compared:** 0.2, 0.25, 0.3
- **Position sizing:** Fixed fraction of current bankroll per trade (default 2%)

## Run

```bash
npm run backtest:shadow-model -- [options]
```

**Note:** Use `--` before flags so npm forwards them to the script (e.g. `npm run backtest:shadow-model -- --limit=1000 --slippage-bps=15`).

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--limit=N` | Max historical rows to load | 5000 |
| `--model-run-id=ID` | Use specific model run | latest TRAINED shadow run |
| `--from=YYYY-MM-DD` | Filter examples created on or after | — |
| `--to=YYYY-MM-DD` | Filter examples created on or before | — |
| `--source=SOURCE` | Filter by `candidateSource` (e.g. `offline_historical`) | — |
| `--slippage-bps=N` | Slippage in bps (entry+exit); 0 is valid | 10 |
| `--cost-bps=N` | Fixed cost per trade in bps; 0 is valid | 0 |
| `--bankroll=N` | Starting bankroll in dollars | 10000 |
| `--size-pct=N` | % of bankroll risked per trade (e.g. 1 or 2) | 2 |

### Examples

```bash
# Default: latest shadow model, 5000 rows, $10k bankroll, 2% per trade, 10 bps slippage
npm run backtest:shadow-model

# Custom bankroll and sizing
npm run backtest:shadow-model -- --bankroll=50000 --size-pct=1 --limit=2000

# Offline historical only, date range, zero cost
npm run backtest:shadow-model -- --source=offline_historical --from=2025-01-01 --to=2025-03-01 --slippage-bps=15 --cost-bps=0

# Specific model run
npm run backtest:shadow-model -- --model-run-id=clxxx...
```

## Output

For each threshold (0.2, 0.25, 0.3):

- **numTrades** — Count of simulated trades (score ≥ threshold).
- **winRate** — Fraction of trades with net return > 0.
- **avg return/trade** — Average net return per trade (decimal, after slippage/cost).
- **starting bankroll** / **ending bankroll** — In dollars.
- **total return** — (ending − starting) / starting, in %.
- **max drawdown** — Peak-to-trough decline in bankroll, in % (0–100%).

Equity = bankroll after each trade; drawdown = (peak − bankroll) / peak, so it cannot exceed 100%.

## Implementation

- **Lib:** `lib/ml/backtest/` — `runBacktest()` with bankroll and `sizeFractionPerTrade`; types in `types.ts`.
- **CLI:** `tools/backtest-shadow-model.ts` — parses all flags (including `--slippage-bps=0`, `--cost-bps=0`), passes bankroll/size, prints report and rerun command.

## Rerun command

The script prints a full rerun command at the end (including the options you used). To rerun the backtest for thresholds 0.2, 0.25, and 0.3 with the same parameters:

```bash
npm run backtest:shadow-model -- --limit=5000 --slippage-bps=10 --cost-bps=0 --bankroll=10000 --size-pct=2
```

Add `--from=YYYY-MM-DD`, `--to=YYYY-MM-DD`, or `--source=offline_historical` as needed.
