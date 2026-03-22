<#
.SYNOPSIS
  Operator report: Docker disk usage, project-related volumes, protected resources, suggested cleanup.
#>
param(
  [string] $RepoRoot = "",

  [string] $ComposeProjectName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $scriptDir = $PSScriptRoot
  if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
  $RepoRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
}

function Test-DockerAvailable {
  docker version *> $null
  return $LASTEXITCODE -eq 0
}

function Get-ComposeProjectName {
  param([string] $Root, [string] $Override)
  if ($Override) { return $Override.Trim() }
  if ($env:COMPOSE_PROJECT_NAME) { return $env:COMPOSE_PROJECT_NAME.Trim() }

  $envFile = Join-Path $Root ".env"
  if (Test-Path $envFile) {
    Get-Content $envFile -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_ -match '^\s*COMPOSE_PROJECT_NAME\s*=\s*(.+)\s*$') {
        $val = $Matches[1].Trim().Trim('"').Trim("'")
        if ($val) { return $val }
      }
    }
  }

  return (Split-Path $Root -Leaf)
}

function Test-ProtectedVolumeName {
  param([string] $VolumeName)
  return $VolumeName -match 'polymarket_postgres_data'
}

if (-not (Test-DockerAvailable)) {
  Write-Error "Docker CLI not available or daemon not responding."
  exit 1
}

$project = Get-ComposeProjectName -Root $RepoRoot -Override $ComposeProjectName
$expectedPg = "${project}_polymarket_postgres_data"
$expectedNext = "${project}_app_next_cache"

Write-Host ""
Write-Host "========== Docker disk usage (docker system df) ==========" -ForegroundColor Cyan
docker system df

Write-Host ""
Write-Host "========== Detailed space (docker system df -v) ==========" -ForegroundColor Cyan
docker system df -v

Write-Host ""
Write-Host "========== Project-related volumes (name contains project or polymarket-copilot assets) ==========" -ForegroundColor Cyan
docker volume ls --format "table {{.Name}}\t{{.Driver}}\t{{.Mountpoint}}"

Write-Host ""
Write-Host "---------- Resolved compose project: $project ----------" -ForegroundColor Yellow
Write-Host "Expected Postgres data volume (compose): $expectedPg"
Write-Host "Expected Next.js cache volume (compose):   $expectedNext"

Write-Host ""
Write-Host "========== PROTECTED (never auto-removed by docker-safe-cleanup.ps1) ==========" -ForegroundColor Green
Write-Host "- Any volume whose name contains: polymarket_postgres_data"
Write-Host "- Default cleanup does NOT run docker volume prune."
Write-Host "- Optional -PruneAppNextCache only removes volumes matching *app_next_cache* and not used by a running container."

Write-Host ""
Write-Host "========== Reclaimable categories (typical) ==========" -ForegroundColor Cyan
Write-Host "- Build cache:        docker builder prune -f          (safe; script default)"
Write-Host "- Dangling images:    docker image prune -f            (safe; script default)"
Write-Host "- Stopped containers: docker container prune -f          (safe; script default)"
Write-Host "- Unused networks:    docker network prune -f            (safe; script default)"
Write-Host "- All unused images:  docker image prune -a -f         (more aggressive; optional flag on script)"
Write-Host "- app_next cache vol: optional -PruneAppNextCache       (safe-ish; may force Next rebuild)"

Write-Host ""
Write-Host "========== Recommended next action ==========" -ForegroundColor Magenta
Write-Host "1) Preview:  pwsh -NoProfile -File .\scripts\docker-safe-cleanup.ps1 -WhatIf"
Write-Host "2) Apply:    pwsh -NoProfile -File .\scripts\docker-safe-cleanup.ps1"
Write-Host "3) Logs:     see %TEMP%\polymarket-copilot-docker-safe-cleanup.log"

exit 0
