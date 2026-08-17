<#
  Launches destiny2.exe and waits for its window, mirroring the launch+wait steps of
  tools/capture-game.ps1 (see a local capture script) — same kill
  existing / Start-Process -PassThru / poll MainWindowHandle shape. This script deliberately drops
  capture-game.ps1's later steps (the boot-settle sleep, image dump, and closing the game again):
  the MCP game_launch tool wants the game left running so an agent can talk to the console
  endpoint, not a single capture-and-close pass.

  Emits exactly one line of JSON on stdout describing the outcome, so the Node caller (src/game.ts)
  has something reliable to parse regardless of what PowerShell prints along the way.
#>
param(
  [Parameter(Mandatory = $true)] [string] $GameDir
)

$ErrorActionPreference = 'Stop'

function Write-Result($obj) {
  # [Console]::Out.WriteLine bypasses PowerShell's success-stream formatter, which otherwise wraps
  # long lines at the console width — game.ts's parser needs this JSON intact on one line.
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
}

Get-Process destiny2 -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$exe = Join-Path $GameDir 'destiny2.exe'
if (-not (Test-Path $exe)) {
  Write-Result @{ ok = $false; error = "destiny2.exe not found at $exe" }
  exit 1
}

$p = Start-Process $exe -WorkingDirectory $GameDir -PassThru

# The window appears once the renderer is up, which is right before Sunrise scans the image.
for ($i = 0; $i -lt 120 -and $p.MainWindowHandle -eq 0; $i++) {
  Start-Sleep -Milliseconds 500
  $p.Refresh()
  if ($p.HasExited) {
    Write-Result @{ ok = $false; error = "process exited early with code $($p.ExitCode)"; pid = $p.Id }
    exit 1
  }
}

if ($p.MainWindowHandle -eq 0) {
  Write-Result @{ ok = $false; error = 'no window after 60s'; pid = $p.Id }
  exit 1
}

Write-Result @{ ok = $true; pid = $p.Id }
exit 0
