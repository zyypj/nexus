# Runs the Nexus server locally with values from scripts/dev.env (or the example).
# Usage: powershell -File scripts/dev-server.ps1 [-Release]
param([switch]$Release)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $PSScriptRoot "dev.env"
if (-not (Test-Path $envFile)) { $envFile = Join-Path $PSScriptRoot "dev.env.example" }
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2]) }
}
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $root "target" }
$profileArgs = @()
if ($Release) { $profileArgs = @("--release") }
Push-Location $root
try { cargo run -p nexus-server @profileArgs -- serve } finally { Pop-Location }
