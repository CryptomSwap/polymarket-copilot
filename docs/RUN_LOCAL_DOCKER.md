# Run Local Docker (App + Worker + Postgres)

## Prerequisites
- Docker Desktop installed and running
- You have a working `.env` in this repo (Compose will load it via `env_file: .env`)

If you don’t have `.env` yet:
- Copy `.env.example` to `.env`
- Set `CREDENTIAL_ENCRYPTION_KEY` in `.env` (required for credential encryption)

## Start
From repo root:

```powershell
.\scripts\dev-up.ps1
```

This starts:
- `app` (Next.js dev server on `http://localhost:3000`)
- `worker` (background worker)

By default, Compose does NOT start a `postgres` container. It expects you already have Postgres running
(e.g. the existing `polymarket-postgres` container on `localhost:5432`).

## Stop

```powershell
.\scripts\dev-down.ps1
```

## Rebuild
If you change dependencies or want a clean image rebuild:

```powershell
.\scripts\dev-up.ps1 --rebuild
```

## Next.js: `SyntaxError: Unexpected end of JSON input` (load-manifest / font manifest)

Usually means `.next` has a **truncated or empty** manifest (common with **Docker bind mounts on Windows**).

**If you use Compose `app` service:** `.next` is stored in the **`app_next_cache` volume**, not your repo folder. Reset it:

```powershell
docker compose stop app
docker volume ls
# Remove the volume named like: <compose_project>_app_next_cache
docker volume rm YOUR_PROJECT_app_next_cache
docker compose up -d app
```

Compose project name defaults to the directory name (e.g. `polymarket-copilot_app_next_cache`).

**If you run `npm run dev` on the host (no Docker app):** delete the local cache and restart:

```powershell
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
npm run dev
```

## Inspect Logs

```powershell
.\scripts\dev-logs.ps1
```

Optional tail:

```powershell
.\scripts\dev-logs.ps1 --tail 400
```

## Run Only App / Only Worker

```powershell
docker compose up -d app
docker compose up -d worker
```

## Use compose-managed Postgres (optional)

If you want Docker Compose to start Postgres for you (named volume: `polymarket_postgres_data`), enable the
compose `postgres` profile:

```powershell
docker compose --profile postgres up -d app worker postgres
```

## Prisma Migrations (recommended to run manually)
This repo uses Prisma migrations under `prisma/migrations`.

To apply migrations once (after first start, or after adding migrations):

```powershell
docker compose exec app npx prisma migrate deploy
```

Notes:
- We run migrations manually to avoid accidentally applying migrations on a shared environment.
- If migrations fail for any reason, inspect output and fix DB state, then re-run.

## Run stale-job cleanup tool safely (inside Docker)
The cleanup tool is conservative and dry-run capable.

Dry run:

```powershell
docker compose exec worker npx tsx tools/cleanup-stale-job-runs.ts --dry-run
```

Apply:

```powershell
docker compose exec worker npx tsx tools/cleanup-stale-job-runs.ts --apply
```

## Environment Notes
- Compose uses `.env` for credentials/config, but it **overrides** `DATABASE_URL` inside containers using `DATABASE_URL_DOCKER`.
- In the default “reuse external Postgres” mode, `DATABASE_URL_DOCKER` should point to `host.docker.internal:5432`.
- In “compose-managed Postgres” mode, `DATABASE_URL_DOCKER` can point to `postgres:5432` (or use the default you prefer).

## Docker disk usage (scheduled safe cleanup)

To reclaim Docker **build cache / dangling images / stopped containers / unused networks** without touching the **Postgres data volume** or stopping running services, see **`docs/DOCKER_SAFE_CLEANUP.md`** (`scripts/docker-safe-cleanup.ps1`, `scripts/docker-disk-usage-report.ps1`).

