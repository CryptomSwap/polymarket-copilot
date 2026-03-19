$ErrorActionPreference = "Stop"

Write-Host "Stopping Docker Compose stack..."
docker compose down -v

Write-Host "Done."

