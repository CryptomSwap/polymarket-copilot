# Shadow Table Missing — Fix

## What was wrong

The **ShadowCandidate** and **MlShadowTrainingExample** models were added to `prisma/schema.prisma` but **no migration had been created** that creates these tables in the database. So:

- Any code calling `prisma.shadowCandidate.findMany()` or `prisma.mlShadowTrainingExample.*` failed with:  
  `The table public.ShadowCandidate does not exist in the current database` (or `MlShadowTrainingExample`).
- This is a **migration/schema sync issue**, not a trading-logic or shadow-db vs real-db distinction: the same schema is used for the same database; the tables were simply never created by a migration.

## Which tables were missing

| Table | Purpose |
|-------|--------|
| **ShadowCandidate** | Shadow-mode telemetry: one row per trade candidate (blocked or allowed) for post-trade evaluation. |
| **MlShadowTrainingExample** | ML training examples derived from ShadowCandidate + snapshots; used for shadow ML dataset and disagreement analysis. |

Both are analytics/telemetry only; they do not affect order execution or trading logic.

## Migration status

- **Before:** No migration in `prisma/migrations/` mentioned `ShadowCandidate` or `MlShadowTrainingExample`.
- **After:** A new additive migration was added:
  - **Folder:** `prisma/migrations/20260314210000_add_shadow_candidate_and_ml_shadow_training/`
  - **File:** `migration.sql`  
  It creates only these two tables and their indexes; no other tables or columns are changed.

## Commands to run locally

Use the **same database** your app uses (the one in `DATABASE_URL`). No separate “shadow DB” is required.

1. **Apply pending migrations (creates the missing tables):**
   ```bash
   npx prisma migrate deploy
   ```
   Or, for a dev database with migrate history tracked locally:
   ```bash
   npx prisma migrate dev
   ```
   This will run the new migration and create `ShadowCandidate` and `MlShadowTrainingExample`.

2. **Regenerate the Prisma client (optional but recommended):**
   ```bash
   npx prisma generate
   ```
   Usually run automatically after `migrate dev`; run explicitly after `migrate deploy` if needed.

3. **Confirm tables exist (optional):**
   ```bash
   npx prisma db execute --stdin <<< "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('ShadowCandidate', 'MlShadowTrainingExample');"
   ```
   Or inspect the database with any SQL client; you should see both tables.

## If something goes wrong

- **“Migration failed: relation already exists”**  
  The tables were created outside this migration (e.g. manually or by an old script). You can mark this migration as applied without running it:
  ```bash
  npx prisma migrate resolve --applied 20260314210000_add_shadow_candidate_and_ml_shadow_training
  ```
  Then run `npx prisma generate`.

- **“Database connection” or “schema not found”**  
  Check `DATABASE_URL` in `.env` and that the database is running and reachable. This fix does not introduce a separate “shadow” database; it only adds tables to the existing DB.

- **EPERM or file lock when running `prisma generate`**  
  Close other processes that might be using the Prisma client (e.g. running Next.js or worker), then run `npx prisma generate` again.

## Shadow-DB vs real-DB

There is **no** shadow-db vs real-db split in this codebase for these tables:

- **One database** (the one in `DATABASE_URL`) holds both production and shadow/analytics data.
- **ShadowCandidate** and **MlShadowTrainingExample** are just two more tables in that database, used for shadow telemetry and ML datasets.
- The fix is the same for every environment: ensure the migration that creates these tables has been applied to the database your app uses.

## Summary

| Question | Answer |
|----------|--------|
| Did a migration for ShadowCandidate exist before? | No. |
| Which tables were missing? | `ShadowCandidate`, `MlShadowTrainingExample`. |
| What was added? | One new migration: `20260314210000_add_shadow_candidate_and_ml_shadow_training`. |
| Exact command to fix local DB? | `npx prisma migrate deploy` (or `npx prisma migrate dev` in dev). |
| Shadow vs real DB? | Single DB; no distinction. Same fix everywhere. |
