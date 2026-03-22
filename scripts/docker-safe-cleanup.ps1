<#
.SYNOPSIS
  Conservative Docker disk cleanup for local operators (does not stop containers or touch Postgres data).

.DESCRIPTION
  Prunes: build cache, dangling images (optional: all unused images), stopped containers, unused networks.
  Never removes volumes by default. Never targets the compose Postgres volume (polymarket_postgres_data).

  Protected rule: any volume whose name contains "polymarket_postgres_data" is never removed by this script.

.NOTES
  Idempotent and safe to run on a schedule. Does not run docker compose stop/down or container restart.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string] $RepoRoot = "",

  [string] $ComposeProjectName,

  [string] $LogPath = (Join-Path $env:TEMP "polymarket-copilot-docker-safe-cleanup.log"),

  [switch] $IncludeAllUnusedImages,

  [switch] $PruneAppNextCache,

  [switch] $DangerousVolumePrune,

  [switch] $SkipBuildCache
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $scriptDir = $PSScriptRoot
  if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
  $RepoRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
}

function Write-Log {
  param([string] $Message, [string] $Level = "INFO")
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$ts] [$Level] $Message"
  Write-Host $line
  try {
    Add-Content -LiteralPath $script:LogFile -Value $line -Encoding utf8 -ErrorAction SilentlyContinue -WhatIf:$false
  } catch { }
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
  if ([string]::IsNullOrWhiteSpace($VolumeName)) { return $true }
  return $VolumeName -match 'polymarket_postgres_data'
}

function Test-SafeAppNextCacheVolumeName {
  param([string] $VolumeName)
  if ([string]::IsNullOrWhiteSpace($VolumeName)) { return $false }
  if (Test-ProtectedVolumeName $VolumeName) { return $false }
  return $VolumeName -match 'app_next_cache'
}

function Get-VolumeUsedByRunningContainer {
  param([string] $VolumeName)
  $ids = docker ps -q --filter "volume=$VolumeName" 2>$null
  if ($LASTEXITCODE -ne 0) { return $true }
  return [string]::IsNullOrWhiteSpace($ids) -eq $false
}

function Invoke-DockerCleanupStep {
  param(
    [string] $Caption,
    [string[]] $Arguments,
    [switch] $AllowNonZero
  )
  Write-Log "RUN: docker $($Arguments -join ' ')"
  if (-not $PSCmdlet.ShouldProcess($Caption, "docker $($Arguments -join ' ')")) {
    Write-Log "SKIP (WhatIf): $($Arguments -join ' ')" "DRYRUN"
    return
  }
  & docker @Arguments
  $code = $LASTEXITCODE
  if ($code -ne 0 -and -not $AllowNonZero) {
    throw "Docker command failed (exit $code): docker $($Arguments -join ' ')"
  }
}

$script:LogFile = $LogPath

if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
  Write-Error "RepoRoot is not a directory: $RepoRoot"
  exit 2
}

if (-not (Test-DockerAvailable)) {
  Write-Error "Docker CLI not available or daemon not responding. Start Docker Desktop and retry."
  exit 1
}

$project = Get-ComposeProjectName -Root $RepoRoot -Override $ComposeProjectName
$expectedPgVol = "${project}_polymarket_postgres_data"

Write-Log "=== polymarket-copilot docker-safe-cleanup ==="
Write-Log "RepoRoot: $RepoRoot"
Write-Log "Compose project name (resolved): $project"
Write-Log "Expected Postgres volume name (compose default): $expectedPgVol"
Write-Log 'PROTECTED: any volume with substring polymarket_postgres_data is NEVER removed by this script.'
Write-Log "Log file: $LogPath"

if ($DangerousVolumePrune -and $PruneAppNextCache) {
  Write-Error 'Refusing: -DangerousVolumePrune and -PruneAppNextCache together is unnecessary; use one volume strategy.'
  exit 2
}

try {
  if (-not $SkipBuildCache) {
    Invoke-DockerCleanupStep "Prune build cache" @("builder", "prune", "-f")
  } else {
    Write-Log 'SKIP: build cache prune (-SkipBuildCache)'
  }

  if ($IncludeAllUnusedImages) {
    Invoke-DockerCleanupStep "Prune all unused images" @("image", "prune", "-a", "-f")
  } else {
    Invoke-DockerCleanupStep "Prune dangling images" @("image", "prune", "-f")
  }

  Invoke-DockerCleanupStep "Prune stopped containers" @("container", "prune", "-f")
  Invoke-DockerCleanupStep "Prune unused networks" @("network", "prune", "-f")

  if ($PruneAppNextCache) {
    Write-Log "Optional: prune unused app_next_cache volumes (never Postgres)."
    $volLines = docker volume ls --format "{{.Name}}" 2>$null
    if ($LASTEXITCODE -ne 0) { throw "docker volume ls failed" }

    foreach ($vol in $volLines) {
      $v = $vol.Trim()
      if (-not (Test-SafeAppNextCacheVolumeName $v)) { continue }
      if (Test-ProtectedVolumeName $v) { continue }

      if (Get-VolumeUsedByRunningContainer $v) {
        Write-Log "SKIP app_next_cache volume - in use by running container: $v"
        continue
      }

      $cap = "Remove safe cache volume $v"
      Write-Log "RUN: docker volume rm $v"
      if ($PSCmdlet.ShouldProcess($cap, "docker volume rm $v")) {
        docker volume rm $v 2>&1 | ForEach-Object { Write-Log $_ }
        if ($LASTEXITCODE -ne 0) {
          Write-Log "NOTE: could not remove $v - likely still referenced by a stopped container or other use. Non-fatal." "WARN"
        }
      } else {
        Write-Log "SKIP (WhatIf): docker volume rm $v" "DRYRUN"
      }
    }
  }

  if ($DangerousVolumePrune) {
    Write-Log 'DANGEROUS: docker volume prune -f removes ALL unused volumes not referenced by any container.' "WARN"
    Invoke-DockerCleanupStep "Prune all unused volumes (DANGEROUS)" @("volume", "prune", "-f") -AllowNonZero
  } else {
    Write-Log 'SKIP: generic volume prune (off by default). Pass -DangerousVolumePrune to enable docker volume prune -f (can remove other unused volumes).'
  }

  Write-Log "=== cleanup finished ==="
  exit 0
} catch {
  Write-Log "ERROR: $($_.Exception.Message)" "ERROR"
  exit 1
}
