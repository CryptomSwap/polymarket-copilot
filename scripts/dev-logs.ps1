$ErrorActionPreference = "Stop"

$Tail = 200
if ($args -contains "--tail") {
  $idx = [array]::IndexOf($args, "--tail")
  if ($idx -ge 0 -and $idx -lt $args.Length - 1) { $Tail = [int]$args[$idx + 1] }
}

Write-Host "Tailing app + worker logs (tail=$Tail)..."
docker compose logs -f --tail=$Tail app worker

