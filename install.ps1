# install.ps1 - one-time install of opencodeclaude (Windows).
# Requires: Node.js 20+ and the `claude` CLI. Runs on Windows PowerShell 5.1 too.
# Run locally:  powershell -ExecutionPolicy Bypass -File install.ps1
# Or hosted:
#   irm https://raw.githubusercontent.com/dimassfeb-09/opencodeclaude/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://raw.githubusercontent.com/dimassfeb-09/opencodeclaude/main'

$Src = $PSScriptRoot
if (-not (Test-Path "$Src\cli.mjs")) {
  # Running via `irm ... | iex`: fetch the files first.
  $Src = Join-Path $env:TEMP 'opencodeclaude-install'
  New-Item -ItemType Directory -Force -Path $Src | Out-Null
  foreach ($f in 'cli.mjs', 'proxy.mjs') {
    Write-Host "Downloading $f ..."
    Invoke-WebRequest "$RepoUrl/$f" -OutFile (Join-Path $Src $f)
  }
}

$Dest = Join-Path $env:LOCALAPPDATA 'Programs\opencodeclaude'
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item "$Src\cli.mjs", "$Src\proxy.mjs" -Destination $Dest -Force

# Shim in the npm global folder (already on PATH, same spot as `claude`) if present.
$npmDir = Join-Path $env:APPDATA 'npm'
$shimDir = if (Test-Path $npmDir) { $npmDir } else { Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps' }
$shim = Join-Path $shimDir 'opencodeclaude.cmd'
Set-Content -Path $shim -Value "@echo off`r`nnode `"$Dest\cli.mjs`" %*" -Encoding ASCII

Write-Host ''
Write-Host 'opencodeclaude installed.'
Write-Host "  Files: $Dest"
Write-Host "  Shim:  $shim"
Write-Host ''
Write-Host "Open a NEW terminal, then run: opencodeclaude"
Write-Host 'First run asks for your OpenCode API key (https://opencode.ai/auth).'
Write-Host 'Uninstall: delete the files and shim above.'
