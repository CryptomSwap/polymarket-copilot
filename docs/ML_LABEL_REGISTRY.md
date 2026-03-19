# ML Label Registry

See **ML_TARGETS_AND_LABELS.md** for the full description. The canonical registry is in `lib/ml/targets/registry.ts`.

**Target truth audit** (schema, population counts, active model, mismatches):

```bash
npm run dump:ml:target-truth-audit
```

Outputs: `dump/ml-target-truth-audit.json`, `dump/ml-target-truth-audit.md`.

**Label registry report**:

```bash
npm run dump:ml:label-registry
```

Outputs: `dump/ml-label-registry-report.json`, `dump/ml-label-registry-report.md`.
