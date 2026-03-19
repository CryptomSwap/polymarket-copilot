$ErrorActionPreference = "Stop"

$Rebuild = $false
if ($args -contains "--rebuild") { $Rebuild = $true }

 $WithPostgres = $false
 if ($args -contains "--postgres" -or $args -contains "--with-postgres") { $WithPostgres = $true }

Write-Host "Starting Docker Compose stack..."
if ($Rebuild) {
  if ($WithPostgres) {
    docker compose up -d --build --profile postgres
  } else {
    docker compose up -d --build
  }
} else {
  if ($WithPostgres) {
    docker compose up -d --profile postgres
  } else {
    docker compose up -d
  }
}

Write-Host "Done."

