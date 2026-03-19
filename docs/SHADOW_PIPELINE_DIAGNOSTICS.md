# Shadow pipeline diagnostics

Use this to verify whether shadow candidates, shadow evaluations, and ML shadow dataset rows are actually being produced when review endpoints report zero counts.

## What it checks

The script `tools/check-shadow-pipeline.ts` is **read-only**. It queries the database and prints:

| Output | Meaning |
|--------|--------|
| **ShadowCandidate total** | Number of rows in `ShadowCandidate` (candidates recorded by shadow telemetry). |
| **ShadowCandidate blocked / allowed / submitted** | Counts by `wasBlocked` (true = blocked, false = allowed) and `wasSubmitted` (true = order was submitted). |
| **ShadowCandidate evaluated count** | Rows with `evaluatedAt` set (evaluation job has run). |
| **ShadowCandidate with markout24h count** | Rows with 24h markout filled (needed for outcome classification). |
| **Recent 10 ShadowCandidate rows** | Short summary of latest candidates (id, createdAt, blocked, submitted, evaluated, markout24h, outcome). |
| **MlShadowTrainingExample total** | Number of ML training rows (built from ShadowCandidates by the dataset job). |
| **Recent 10 MlShadowTrainingExample rows** | Short summary of latest examples. |
| **Shadow disagreement can run?** | Yes if there are evaluated candidates and ML examples (and an active shadow model). |
| **Calibration can run?** | Yes if there are any ShadowCandidate rows. |

## How to run

From the project root:

```bash
npm run check:shadow-pipeline
```

Uses `DATABASE_URL` from your environment (e.g. `.env`). No API or app server required.

## Interpreting “all counts zero”

If review endpoints are healthy but counts are zero, the script tells you where the pipeline is empty:

1. **No ShadowCandidate rows**  
   Shadow telemetry is not writing candidates. Check that the bot/runtime is recording shadow candidates (e.g. `lib/shadow-telemetry/record.ts` is invoked when candidates are staged). No rows ⇒ evaluation and calibration have nothing to read.

2. **ShadowCandidate rows exist but none evaluated**  
   Candidates are being recorded, but the evaluation job is not running or not updating `evaluatedAt` / markouts. Check the shadow-evaluation job (e.g. scheduled job or API that runs evaluation). Until candidates are evaluated, disagreement and calibration have no outcomes to analyze.

3. **MlShadowTrainingExample rows are not being built**  
   Evaluation may be fine, but the ML shadow dataset build (e.g. `persistShadowTrainingExamples` or the ml-shadow-dataset job) is not running or not creating rows. Check the dataset build job/API. Without ML examples, shadow disagreement has nothing to score.

## Tables missing

If you see an error that the table `ShadowCandidate` or `MlShadowTrainingExample` does not exist, run migrations first:

```bash
npx prisma migrate deploy
```

See `docs/DB_DRIFT_CATCHUP.md` if migration history and actual schema have drifted.

## Constraints

- Read-only: no writes, no trading logic.
- Safe when tables are empty: counts are zero and “recent” lists are empty.
- Concise, operator-oriented output for quick checks.
