#!/usr/bin/env bash
# Conservative Docker disk cleanup (no container stop/restart; Postgres data volumes never targeted).
# Protected: any volume name containing "polymarket_postgres_data".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_PATH="${TEMP:-/tmp}/polymarket-copilot-docker-safe-cleanup.log"
COMPOSE_PROJECT_NAME_RESOLVED=""
DRY_RUN=0
INCLUDE_ALL_UNUSED_IMAGES=0
PRUNE_APP_NEXT_CACHE=0
DANGEROUS_VOLUME_PRUNE=0
SKIP_BUILD_CACHE=0

usage() {
  cat <<'EOF'
Usage: docker-safe-cleanup.sh [options]

  --dry-run                 Print docker commands only; do not execute mutating steps
  --repo-root PATH          Default: parent of scripts/
  --compose-project NAME    Override COMPOSE_PROJECT_NAME detection
  --log PATH                Log file (default: $TEMP/... or /tmp/...)
  --all-unused-images       docker image prune -a -f (more aggressive)
  --prune-app-next-cache    Remove unused *app_next_cache* volumes only (not in use by running containers)
  --dangerous-volume-prune  docker volume prune -f (NOT recommended; off by default)
  --skip-build-cache        Skip docker builder prune
  -h, --help                This help

Protected volumes: any name containing polymarket_postgres_data is never removed.
EOF
}

log() {
  local level="${2:-INFO}"
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  local line="[$ts] [$level] $1"
  echo "$line"
  echo "$line" >>"$LOG_PATH" 2>/dev/null || true
}

resolve_compose_project() {
  if [[ -n "${COMPOSE_PROJECT_NAME_RESOLVED:-}" ]]; then
    echo "$COMPOSE_PROJECT_NAME_RESOLVED"
    return
  fi
  if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
    echo "$COMPOSE_PROJECT_NAME"
    return
  fi
  local envf="$REPO_ROOT/.env"
  if [[ -f "$envf" ]]; then
    local v
    v="$(grep -E '^\s*COMPOSE_PROJECT_NAME\s*=' "$envf" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs || true)"
    if [[ -n "$v" ]]; then
      echo "$v"
      return
    fi
  fi
  basename "$REPO_ROOT"
}

protected_volume() {
  [[ "$1" == *polymarket_postgres_data* ]]
}

safe_app_next_cache_volume() {
  local n="$1"
  protected_volume "$n" && return 1
  [[ "$n" == *app_next_cache* ]]
}

volume_in_use_running() {
  local n="$1"
  local ids
  ids="$(docker ps -q --filter "volume=$n" 2>/dev/null || true)"
  [[ -n "$ids" ]]
}

run_docker() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRYRUN: docker $*"
    return 0
  fi
  log "RUN: docker $*"
  docker "$@"
}

if ! docker version >/dev/null 2>&1; then
  echo "Docker CLI not available or daemon not responding." >&2
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --compose-project) COMPOSE_PROJECT_NAME_RESOLVED="$2"; shift 2 ;;
    --log) LOG_PATH="$2"; shift 2 ;;
    --all-unused-images) INCLUDE_ALL_UNUSED_IMAGES=1; shift ;;
    --prune-app-next-cache) PRUNE_APP_NEXT_CACHE=1; shift ;;
    --dangerous-volume-prune) DANGEROUS_VOLUME_PRUNE=1; shift ;;
    --skip-build-cache) SKIP_BUILD_CACHE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "$DANGEROUS_VOLUME_PRUNE" -eq 1 && "$PRUNE_APP_NEXT_CACHE" -eq 1 ]]; then
  echo "Refusing: --dangerous-volume-prune and --prune-app-next-cache together." >&2
  exit 2
fi

project="$(resolve_compose_project)"
expected_pg="${project}_polymarket_postgres_data"

log "=== polymarket-copilot docker-safe-cleanup (bash) ==="
log "RepoRoot: $REPO_ROOT"
log "Compose project name (resolved): $project"
log "Expected Postgres volume (compose default): $expected_pg"
log "PROTECTED: any volume with substring polymarket_postgres_data — NEVER removed by this script."
log "Log file: $LOG_PATH"

if [[ "$SKIP_BUILD_CACHE" -eq 0 ]]; then
  run_docker builder prune -f
else
  log "SKIP: build cache prune (--skip-build-cache)"
fi

if [[ "$INCLUDE_ALL_UNUSED_IMAGES" -eq 1 ]]; then
  run_docker image prune -a -f
else
  run_docker image prune -f
fi

run_docker container prune -f
run_docker network prune -f

if [[ "$PRUNE_APP_NEXT_CACHE" -eq 1 ]]; then
  log "Optional: prune unused app_next_cache volumes (never Postgres)."
  while IFS= read -r vol; do
    [[ -z "$vol" ]] && continue
    if ! safe_app_next_cache_volume "$vol"; then continue; fi
    if protected_volume "$vol"; then continue; fi
    if volume_in_use_running "$vol"; then
      log "SKIP app_next_cache volume (in use by running container): $vol"
      continue
    fi
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "DRYRUN: docker volume rm $vol"
      continue
    fi
    log "RUN: docker volume rm $vol"
    if ! docker volume rm "$vol" 2>/dev/null; then
      log "NOTE: could not remove $vol (likely referenced by a stopped container). Non-fatal." "WARN"
    fi
  done < <(docker volume ls --format '{{.Name}}')
fi

if [[ "$DANGEROUS_VOLUME_PRUNE" -eq 1 ]]; then
  log "DANGEROUS: docker volume prune -f" "WARN"
  run_docker volume prune -f || true
else
  log "SKIP: generic volume prune (off by default; use --dangerous-volume-prune to enable)."
fi

log "=== cleanup finished ==="
exit 0
