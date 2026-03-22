# Docker safe cleanup (local operators)

This repo runs **app**, **worker**, and optionally **postgres** via Docker Compose (`docker-compose.yml`). Docker disk use can grow from **images**, **build cache**, **stopped containers**, and **networks**. These scripts reclaim space **without stopping running containers** and **without removing the Postgres data volume** used for trading state.

## Audit summary (compose volumes)

| Compose volume key | On-disk name (default project) | Role |
|--------------------|-------------------------------|------|
| `polymarket_postgres_data` | `polymarket-copilot_polymarket_postgres_data` | **Postgres data — must never be auto-deleted** |
| `app_next_cache` | `polymarket-copilot_app_next_cache` | Next.js `.next` cache (rebuildable; optional manual/volume cleanup) |

Compose **project name** defaults to the **directory name** (`polymarket-copilot`) unless you set `COMPOSE_PROJECT_NAME` in the environment or in `.env`. Volume names are `{project}_{volume_key}`.

**Protected volume rule (scripts):** any Docker volume whose name contains the substring `polymarket_postgres_data` is **never** removed by `docker-safe-cleanup.ps1` / `docker-safe-cleanup.sh`.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/docker-safe-cleanup.ps1` | Scheduled-safe cleanup (Windows / PowerShell) |
| `scripts/docker-safe-cleanup.sh` | Same behavior for WSL / Linux / macOS |
| `scripts/docker-disk-usage-report.ps1` | `docker system df`, volume listing, protected list, recommendations |

### Disk usage report

From repo root (PowerShell):

```powershell
pwsh -NoProfile -File .\scripts\docker-disk-usage-report.ps1
```

Or via npm (Windows, calls PowerShell):

```powershell
npm run docker:disk-report
```

### Default cleanup (recommended for Task Scheduler)

Prunes:

- Docker **build cache** (`docker builder prune -f`)
- **Dangling** unused images (`docker image prune -f`)
- **Stopped** containers (`docker container prune -f`)
- **Unused** networks (`docker network prune -f`)

Does **not**:

- Stop, restart, or recreate running containers
- Run `docker compose down`
- Remove **any** volume by default (no `docker volume prune`)

Dry-run / plan (prints what would run; no mutating `docker` calls):

```powershell
pwsh -NoProfile -File .\scripts\docker-safe-cleanup.ps1 -WhatIf
```

Apply:

```powershell
pwsh -NoProfile -File .\scripts\docker-safe-cleanup.ps1
```

Logs append to `%TEMP%\polymarket-copilot-docker-safe-cleanup.log` unless you pass `-LogPath`.

### Optional flags (PowerShell)

| Flag | Effect |
|------|--------|
| `-IncludeAllUnusedImages` | `docker image prune -a -f` (more aggressive than dangling-only) |
| `-PruneAppNextCache` | Remove volumes whose names match `*app_next_cache*`, only if **not** used by a **running** container; never touches Postgres volumes |
| `-DangerousVolumePrune` | Runs `docker volume prune -f` — **removes all unused volumes** not referenced by any container; **off by default** |
| `-SkipBuildCache` | Skip `docker builder prune` |
| `-ComposeProjectName NAME` | Override project name for messages only (protection is substring-based) |
| `-RepoRoot PATH` | Default: parent of `scripts/` |

The script **refuses** `-DangerousVolumePrune` together with `-PruneAppNextCache` (confusing / redundant).

### Bash equivalent

```bash
chmod +x scripts/docker-safe-cleanup.sh
./scripts/docker-safe-cleanup.sh --dry-run
./scripts/docker-safe-cleanup.sh
# Optional:
./scripts/docker-safe-cleanup.sh --all-unused-images
./scripts/docker-safe-cleanup.sh --prune-app-next-cache
```

## Windows Task Scheduler (every few hours)

**Recommended cadence:** every **4–6 hours** while you are actively developing, or **daily** if usage is light. Avoid sub-hourly runs (noise, limited benefit).

### Exact action (recommended)

1. Open **Task Scheduler** → **Create Task…** (not a simple “Create Basic Task” if you want full control).
2. **General:** Run whether user is logged on or not (optional); configure for your account.
3. **Triggers:** New → **Daily** or **On a schedule** → repeat every **4 hours** for a duration of **1 day** (or use multiple triggers), as you prefer.
4. **Actions:** **Start a program**
   - **Program/script:** `pwsh.exe`  
     If `pwsh` is not installed, use: `powershell.exe`
   - **Add arguments:**
     ```text
     -NoProfile -ExecutionPolicy Bypass -File "C:\Users\User\Polymarket\polymarket-copilot\scripts\docker-safe-cleanup.ps1"
     ```
     Adjust the path if your clone lives elsewhere.
5. **Conditions:** Optionally uncheck “Start only if on AC power” if you need it on battery.
6. **Settings:** Allow task to run on demand; if missed, run as soon as possible (optional).

**Safety notes:**

- The task only runs the **safe** cleanup path (no volume prune, no Postgres deletion, no container stop).
- **Do not** schedule `-DangerousVolumePrune` or raw `docker volume prune -f` unless you fully understand that **unused** named volumes from **other** projects can be deleted.
- **Do not** schedule `docker system prune -a --volumes` or similar all-in-one commands; they are easy to misconfigure and can remove data you still care about.

### Disable

- Task Scheduler → find the task → **Disable** or **Delete**.

### Verify

- Inspect `%TEMP%\polymarket-copilot-docker-safe-cleanup.log` after a run.
- Run `npm run docker:disk-report` (or the `.ps1` report) before/after to see `docker system df`.

## What not to do

- Do **not** put `docker volume rm` for `*polymarket_postgres_data*` in any automated job.
- Do **not** schedule `docker compose down -v` or `docker volume prune` without a narrow allowlist.
- Do **not** assume `docker system prune` defaults are safe for volumes — this project’s scripts **avoid** global volume prune unless you opt in with `-DangerousVolumePrune`.

## Related doc

See `docs/RUN_LOCAL_DOCKER.md` for stack startup and the `app_next_cache` volume when fixing corrupt Next.js manifests.
