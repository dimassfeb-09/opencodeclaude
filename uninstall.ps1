# uninstall.ps1 - remove opencodeclaude (Windows).
# Run locally:  pwsh -ExecutionPolicy Bypass -File uninstall.ps1
# Or hosted:
#   irm https://raw.githubusercontent.com/dimassfeb-09/opencodeclaude/main/uninstall.ps1 | iex
$ErrorActionPreference = 'SilentlyContinue'

# Stop any proxy still listening on the default port.
Get-NetTCPConnection -LocalPort 3456 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# Remove shims (npm global dir, or WindowsApps fallback).
foreach ($shim in "$env:APPDATA\npm\opencodeclaude.cmd",
                   "$env:LOCALAPPDATA\Microsoft\WindowsApps\opencodeclaude.cmd") {
  Remove-Item -Force $shim
}

# Remove installed files and stored key/plan config.
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\opencodeclaude"
Remove-Item -Recurse -Force "$env:APPDATA\opencodeclaude"

Write-Host 'opencodeclaude uninstalled.'
