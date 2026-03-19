# ML Architecture Review

This document summarizes the current ML pipeline. For the canonical map with file/function references, run:

```bash
npm run dump:ml:architecture-map
```

Outputs: `dump/ml-architecture-map.json`, `dump/ml-architecture-map.md`.

## Summary

- **Two pipelines**: (1) Recommendation ML (`lib/ml/features.ts`, `dataset.ts`) with labels from `RecommendationEvaluation` (6h/24h). (2) Shadow ML (`lib/ml/shadow-train/`, `lib/ml/shadow-dataset/`) with labels from outcome classification and markouts.
- **Train/test split**: Time-ordered; 80% train, 20% validation.
- **Scoring**: Shadow model only; `lib/ml/shadow-score/score-live.ts`. Paper engine uses score >= threshold; live execution does not use ML for decisions.
- **Single score overload**: One `shadowMlScore` is used for ranking, threshold gating, and display band. Multi-role types (`MlScoreBundle`) are additive for future separation.

See `dump/ml-architecture-map.md` for the full path list.
