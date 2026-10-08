# Runs a local LiveKit server for development.
# Needs livekit-server.exe (https://github.com/livekit/livekit/releases) on PATH
# or in $env:LIVEKIT_BIN.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $PSScriptRoot "dev.env"
if (-not (Test-Path $envFile)) { $envFile = Join-Path $PSScriptRoot "dev.env.example" }
$vars = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $vars[$Matches[1]] = $Matches[2] }
}
$env:LIVEKIT_KEYS = "$($vars['LIVEKIT_API_KEY']): $($vars['LIVEKIT_API_SECRET'])"
$bin = if ($env:LIVEKIT_BIN) { $env:LIVEKIT_BIN } else { "livekit-server" }
& $bin --config (Join-Path $root "infrastructure/livekit/livekit.dev.yaml")
