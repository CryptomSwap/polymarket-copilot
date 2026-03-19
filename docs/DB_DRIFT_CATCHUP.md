# Database drift catch-up

## What this is for

Your app can fail with:

```text
Invalid prisma.shadowCandidate.findMany() invocation:
The table public.ShadowCandidate does not exist in the current database.
```

even when `npx prisma migrate status` reports that the database schema is **up to date**. That happens when **migration history and the actual database schema have drifted**: the `_prisma_migrations` table says all migrations have been applied, but one or more tables were never created (or were dropped/restored from an older backup).

This document describes the catch-up migration that fixes that drift and the commands to run after adding it.

---

## Which tables were missing

The drift fix targets **analytics/shadow** tables that exist in `prisma/schema.prisma` but may be missing in the real database:

| Table | Purpose |
|-------|--------|
| **ShadowCandidate** | Shadow telemetry: one row per trade candidate (blocked or allowed) for post-trade evaluation. |
| **MlShadowTrainingExample** | ML training examples derived from ShadowCandidate; used for shadow ML dataset and disagreement analysis. |

No other tables are created by this catch-up. There are no separate “calibration” tables in the schema; calibration uses existing data.

---

## Whether migration history referenced them

- **Before the catch-up:** An earlier migration, `20260314210000_add_shadow_candidate_and_ml_shadow_training`, was added to create these tables. So migration history *did* reference them.
- **Drift:** In your case, `migrate status` still reports “up to date,” but the tables are missing. So either:
  - That migration was marked as applied (e.g. `prisma migrate resolve --applied`) without its SQL actually running, or
  - The database was recreated or restored from a backup from before that migration, while `_prisma_migrations` was left (or re-applied) in a state that includes that migration as applied, or
  - A different database is used at runtime than the one migrations were applied to.

So: migration history *did* reference these tables; the drift is between “what Prisma thinks is applied” and “what actually exists in the DB.”

---

## Why Prisma reported “up to date” despite missing tables

Prisma decides “up to date” by comparing:

1. The list of migration folders in `prisma/migrations/`
2. The rows in the `_prisma_migrations` table in the database

It does **not** re-inspect the database to check that every table from the schema actually exists. So if:

- Every migration in the folder is recorded as applied in `_prisma_migrations`, and  
- The migration that was supposed to create `ShadowCandidate` / `MlShadowTrainingExample` never actually ran (or the DB was reverted),

then Prisma still reports “up to date” while the tables are missing. That’s the drift this catch-up fixes.

---

## The catch-up migration

A **new** migration was added that creates the same tables using **IF NOT EXISTS** so it is safe to run even when:

- The tables already exist (no-op), or  
- They are missing (creates them).

- **Folder:** `prisma/migrations/20260314220000_db_drift_catchup_shadow_analytics/`
- **Contents:**  
  - `CREATE TABLE IF NOT EXISTS` for `ShadowCandidate` and `MlShadowTrainingExample`  
  - `CREATE INDEX IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS` for all indexes

So:

- If the tables are missing, applying this migration creates them.
- If they already exist, the migration runs without changing them (and without failing).

No trading logic is changed; only schema drift is fixed.

---

## Commands to run locally after this migration is added

Use the **same database** your app uses (the one in `DATABASE_URL`).

1. **Apply the new migration (creates missing tables if needed):**
   ```bash
   npx prisma migrate deploy
   ```
   Or in development, if you use the dev workflow:
   ```bash
   npx prisma migrate dev
   ```
   This will run `20260314220000_db_drift_catchup_shadow_analytics` and create `ShadowCandidate` and `MlShadowTrainingExample` if they don’t exist.

2. **Regenerate the Prisma client (recommended):**
   ```bash
   npx prisma generate
   ```
   Often run automatically after `migrate dev`; run explicitly after `migrate deploy` if needed.

3. **Confirm tables exist (optional):**
   ```bash
   npx prisma db execute --stdin <<< "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('ShadowCandidate', 'MlShadowTrainingExample');"
   ```
   Or use any SQL client; you should see both tables.

After that, the “table public.ShadowCandidate does not exist” error should be resolved, and migration history will include the catch-up migration so future deploys stay consistent.
