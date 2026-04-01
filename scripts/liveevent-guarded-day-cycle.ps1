param(
  [Parameter(Mandatory = $true)]
  [string]$Day,
  [string]$ReportsRoot = "C:/Users/User/Polymarket/disk-audit/reports",
  [string]$ArchiveRoot = "C:/Users/User/Polymarket/archive",
  [string]$PostgresContainer = "polymarket-copilot-postgres-1",
  [string]$DatabaseName = "polymarket_copilot",
  [string]$DatabaseUser = "postgres",
  [int]$StabilizationMinutes = 15,
  [int]$BaselineP2024PerWindow = 35,
  [string]$ConfirmationText = ""
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
  Write-Error $Message
  exit 1
}

function Ensure-Dir([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

function Invoke-EndpointChecks([string]$OutFile) {
  $urls = @(
    "http://localhost:3000/api/health",
    "http://localhost:3000/api/ops/worker-status",
    "http://localhost:3000/api/live/stream-health",
    "http://localhost:3000/api/live/events"
  )
  $rows = @()
  foreach ($u in $urls) {
    try {
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $r = Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 20
      $sw.Stop()
      $content = if ($null -ne $r.Content) { $r.Content } else { "" }
      $rows += [pscustomobject]@{
        url        = $u
        ok         = $true
        status     = [int]$r.StatusCode
        elapsed_ms = $sw.ElapsedMilliseconds
        body       = $content.Substring(0, [Math]::Min(500, $content.Length))
      }
    } catch {
      $rows += [pscustomobject]@{
        url        = $u
        ok         = $false
        status     = $null
        elapsed_ms = $null
        error      = $_.Exception.Message
      }
    }
  }
  $rows | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $OutFile
  return $rows
}

function Assert-AllEndpointsHealthy($Rows) {
  foreach ($row in $Rows) {
    if (-not $row.ok -or $row.status -ne 200) {
      Fail "Runtime endpoint check failed: $($row.url) status=$($row.status) ok=$($row.ok)"
    }
  }
}

function Write-PsqlOutput([string]$Sql, [string]$OutFile) {
  $Sql | docker exec -i $PostgresContainer psql -U $DatabaseUser -d $DatabaseName -P pager=off > $OutFile
}

function Require-File([string]$Path, [string]$Reason) {
  if (-not (Test-Path -LiteralPath $Path)) {
    Fail "Required file missing ($Reason): $Path"
  }
  $item = Get-Item -LiteralPath $Path
  if ($item.Length -eq 0) {
    Fail "Required file is empty ($Reason): $Path"
  }
}

try {
  $dayStart = [DateTime]::ParseExact($Day, "yyyy-MM-dd", $null)
} catch {
  Fail "Invalid -Day value '$Day'. Expected format yyyy-MM-dd."
}
$nextDay = $dayStart.AddDays(1)
$dayStartText = $dayStart.ToString("yyyy-MM-dd 00:00:00")
$nextDayText = $nextDay.ToString("yyyy-MM-dd 00:00:00")
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $ReportsRoot ("liveevent-guarded-cycle-" + $Day + "-" + $stamp)
$archiveCsv = Join-Path $ArchiveRoot ("liveevent_" + $Day + "_day.csv")

Ensure-Dir $ReportsRoot
Ensure-Dir $ArchiveRoot
Ensure-Dir $runDir

Write-Host "Run directory: $runDir"
Write-Host "Target slice: [$dayStartText, $nextDayText)"

# Phase A — archive verification
$sliceStatsFile = Join-Path $runDir "01_archive_slice_stats.txt"
$exportSqlHostFile = Join-Path $runDir "02_archive_export.sql"
$restoreSqlHostFile = Join-Path $runDir "03_archive_restore_test.sql"
$restoreOutFile = Join-Path $runDir "04_archive_restore_test.txt"
$manifestFile = Join-Path $runDir "05_archive_manifest.json"

$sliceStatsSql = @"
SELECT count(*) AS rows, min("createdAt") AS min_time, max("createdAt") AS max_time
FROM "public"."LiveEvent"
WHERE "createdAt" >= timestamp '$dayStartText'
  AND "createdAt" < timestamp '$nextDayText';
"@
Write-PsqlOutput -Sql $sliceStatsSql -OutFile $sliceStatsFile
Require-File -Path $sliceStatsFile -Reason "archive slice stats"

$exportSql = @"
COPY (
  SELECT *
  FROM "public"."LiveEvent"
  WHERE "createdAt" >= timestamp '$dayStartText'
    AND "createdAt" < timestamp '$nextDayText'
  ORDER BY "createdAt", "id"
) TO STDOUT WITH CSV HEADER;
"@
$exportSql | Set-Content -Encoding utf8 $exportSqlHostFile
docker cp $exportSqlHostFile "$PostgresContainer`:/tmp/liveevent_export_$Day.sql" | Out-Null
cmd /c "docker exec -i $PostgresContainer psql -U $DatabaseUser -d $DatabaseName -P pager=off -f /tmp/liveevent_export_$Day.sql > $archiveCsv"
Require-File -Path $archiveCsv -Reason "archive csv export"

docker cp $archiveCsv "$PostgresContainer`:/tmp/liveevent_$Day`_day.csv" | Out-Null
$restoreSql = @"
BEGIN;
CREATE TEMP TABLE liveevent_restore_test (LIKE "public"."LiveEvent" INCLUDING ALL);
COPY liveevent_restore_test FROM '/tmp/liveevent_$Day`_day.csv' WITH CSV HEADER;
SELECT count(*) AS restored_rows, min("createdAt") AS min_time, max("createdAt") AS max_time FROM liveevent_restore_test;
ROLLBACK;
"@
$restoreSql | Set-Content -Encoding utf8 $restoreSqlHostFile
Write-PsqlOutput -Sql $restoreSql -OutFile $restoreOutFile
Require-File -Path $restoreOutFile -Reason "archive restore test output"
if (-not (Select-String -Path $restoreOutFile -Pattern "ROLLBACK" -Quiet)) {
  Fail "Restore test did not finish correctly (ROLLBACK missing)."
}

$hash = (Get-FileHash -Path $archiveCsv -Algorithm SHA256).Hash
$sizeBytes = (Get-Item -LiteralPath $archiveCsv).Length
$manifest = [ordered]@{
  table            = "LiveEvent"
  cutoff_start     = $dayStartText
  cutoff_end       = $nextDayText
  checksum_sha256  = $hash
  file_path        = $archiveCsv
  file_size_bytes  = $sizeBytes
  generated_at     = (Get-Date).ToString("s")
}
$manifest | ConvertTo-Json | Set-Content -Encoding utf8 $manifestFile
Require-File -Path $manifestFile -Reason "archive manifest"

# Phase B — runtime pre-check gate
$precheckFile = Join-Path $runDir "06_runtime_prechecks.json"
$precheckRows = Invoke-EndpointChecks -OutFile $precheckFile
Require-File -Path $precheckFile -Reason "runtime pre-checks"
Assert-AllEndpointsHealthy -Rows $precheckRows

# Phase C — delete gate
$preDeleteDbFile = Join-Path $runDir "07_predelete_verify.txt"
$dryRunFile = Join-Path $runDir "08_dry_run_delete.txt"
$prodDeleteFile = Join-Path $runDir "09_production_delete.txt"

$preDeleteSql = @"
SELECT count(*) AS rows, min("createdAt") AS min_time, max("createdAt") AS max_time
FROM "public"."LiveEvent"
WHERE "createdAt" >= timestamp '$dayStartText'
  AND "createdAt" < timestamp '$nextDayText';
SELECT count(*) AS total_table_rows FROM "public"."LiveEvent";
"@
Write-PsqlOutput -Sql $preDeleteSql -OutFile $preDeleteDbFile
Require-File -Path $preDeleteDbFile -Reason "pre-delete verify"

$dryRunSql = @"
\timing on
BEGIN;
DELETE FROM "public"."LiveEvent"
WHERE "createdAt" >= timestamp '$dayStartText'
  AND "createdAt" < timestamp '$nextDayText';
ROLLBACK;
\timing off
"@
Write-PsqlOutput -Sql $dryRunSql -OutFile $dryRunFile
Require-File -Path $dryRunFile -Reason "dry-run delete"

Write-Host ""
Write-Host "Production delete confirmation required."
Write-Host "Slice: [$dayStartText, $nextDayText)"
$confirmation = if ([string]::IsNullOrWhiteSpace($ConfirmationText)) {
  Read-Host "Type DELETE-$Day exactly to proceed"
} else {
  $ConfirmationText
}
if ($confirmation -ne ("DELETE-" + $Day)) {
  Fail "Operator confirmation did not match. Aborting before production delete."
}

# Hard gate: refuse production delete if runtime pre-check artifact missing.
Require-File -Path $precheckFile -Reason "runtime pre-check gate before production delete"

$prodDeleteSql = @"
\timing on
BEGIN;
DELETE FROM "public"."LiveEvent"
WHERE "createdAt" >= timestamp '$dayStartText'
  AND "createdAt" < timestamp '$nextDayText';
COMMIT;
\timing off
"@
Write-PsqlOutput -Sql $prodDeleteSql -OutFile $prodDeleteFile
Require-File -Path $prodDeleteFile -Reason "production delete output"

# Phase D — post-delete validation
$postDbFile = Join-Path $runDir "10_post_delete_db_validation.txt"
$postRuntimeFile = Join-Path $runDir "11_runtime_postchecks.json"

$postDeleteSql = @"
SELECT count(*) AS rows_deleted_window_remaining
FROM "public"."LiveEvent"
WHERE "createdAt" >= timestamp '$dayStartText'
  AND "createdAt" < timestamp '$nextDayText';
SELECT min("createdAt") AS new_min_created_at FROM "public"."LiveEvent";
SELECT count(*) AS rows_next_day
FROM "public"."LiveEvent"
WHERE "createdAt" >= timestamp '$nextDayText'
  AND "createdAt" < timestamp '$($nextDay.AddDays(1).ToString("yyyy-MM-dd 00:00:00"))';
SELECT count(*) AS rows_last_24h
FROM "public"."LiveEvent"
WHERE "createdAt" >= now() - interval '24 hours';
SELECT count(*) AS total_table_rows FROM "public"."LiveEvent";
"@
Write-PsqlOutput -Sql $postDeleteSql -OutFile $postDbFile
Require-File -Path $postDbFile -Reason "post-delete db validation"
if (-not (Select-String -Path $postDbFile -Pattern "rows_deleted_window_remaining" -Quiet)) {
  Fail "Post-delete DB validation output missing expected marker."
}

$postRows = Invoke-EndpointChecks -OutFile $postRuntimeFile
Require-File -Path $postRuntimeFile -Reason "runtime post-checks"
Assert-AllEndpointsHealthy -Rows $postRows

# Phase E — stabilization gate
$logsFile = Join-Path $runDir "12_logs_${StabilizationMinutes}m.txt"
$summaryFile = Join-Path $runDir "13_stabilization_summary.json"

Write-Host "Waiting $StabilizationMinutes minutes for stabilization gate..."
Start-Sleep -Seconds ($StabilizationMinutes * 60)
docker compose logs --since "$($StabilizationMinutes)m" app worker > $logsFile
Require-File -Path $logsFile -Reason "stabilization logs"

$allP2024 = (Select-String -Path $logsFile -Pattern "code: 'P2024'" | Measure-Object).Count
$workerP2024 = (Select-String -Path $logsFile -Pattern "^worker-1\s+\|\s+code: 'P2024'" | Measure-Object).Count
$appP2024 = (Select-String -Path $logsFile -Pattern "^app-1\s+\|\s+code: 'P2024'" | Measure-Object).Count
$liveEventModel = (Select-String -Path $logsFile -Pattern "modelName: 'LiveEvent'" | Measure-Object).Count
$shadowModel = (Select-String -Path $logsFile -Pattern "modelName: 'ShadowCandidate'" | Measure-Object).Count
$journalModel = (Select-String -Path $logsFile -Pattern "modelName: 'OrderLifecycleJournalEntry'" | Measure-Object).Count

$verdict = if ($allP2024 -le $BaselineP2024PerWindow) { "proceed_later" } else { "pause_rollout" }
$summary = [ordered]@{
  day                        = $Day
  stabilization_minutes      = $StabilizationMinutes
  baseline_p2024_per_window  = $BaselineP2024PerWindow
  total_p2024                = $allP2024
  worker_p2024               = $workerP2024
  app_p2024                  = $appP2024
  model_liveevent_hits       = $liveEventModel
  model_shadowcandidate_hits = $shadowModel
  model_journal_hits         = $journalModel
  verdict                    = $verdict
  run_dir                    = $runDir
  generated_at               = (Get-Date).ToString("s")
}
$summary | ConvertTo-Json | Set-Content -Encoding utf8 $summaryFile

Write-Host ""
Write-Host "Cycle completed."
Write-Host "Run dir: $runDir"
Write-Host "P2024 total/worker/app: $allP2024 / $workerP2024 / $appP2024"
Write-Host "Final verdict: $verdict"
exit 0
