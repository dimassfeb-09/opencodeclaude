# opencodeclaude - run Claude Code against OpenCode Zen (pay-as-you-go) and OpenCode Go (flat fee).
# Requires: Claude Code CLI (claude) and Node.js 20+.
#
# API keys are stored per plan in the config file (OPENCODE_GO_KEY / OPENCODE_ZEN_KEY).
# Legacy OPENCODE_API_KEY is a shared fallback for both.
#   opencodeclaude key            - set the key for the current plan (prompts)
#   opencodeclaude key go|zen [K] - set the key for a specific plan

$ErrorActionPreference = 'Stop'

# Force UTF-8 console output so box-drawing characters render on any codepage.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

# --- colors (ANSI; PowerShell 7 / Windows Terminal) -------------------------
$style = $PSStyle
if ($null -eq $style) { $style = $null }
$Accent = if ($style) { $style.Foreground.Cyan } else { '' }
$Bold   = if ($style) { $style.Bold } else { '' }
$Dim    = if ($style) { $style.Foreground.BrightBlack } else { '' }
$Green  = if ($style) { $style.Foreground.Green } else { '' }
$Yellow = if ($style) { $style.Foreground.Yellow } else { '' }
$Blue   = if ($style) { $style.Foreground.Blue } else { '' }
$Reset  = if ($style) { $style.Reset } else { '' }

function Show-Banner([string]$Title) {
  $line = '─' * ($Title.Length + 4)
  Write-Host ''
  Write-Host "$Accent$Bold┌$line┐$Reset"
  Write-Host "$Accent$Bold│  $Title  │$Reset"
  Write-Host "$Accent$Bold└$line┘$Reset"
  Write-Host ''
}

$ConfigDir  = if ($env:APPDATA) { Join-Path $env:APPDATA 'opencodeclaude' } else { Join-Path (Join-Path $HOME '.config') 'opencodeclaude' }
$ConfigFile = Join-Path $ConfigDir 'config'
$ProxyFile  = Join-Path $PSScriptRoot 'proxy.mjs'
$Port       = 3456

# Default model tiers. Claude/Qwen models run on both plans via Zen's
# Anthropic endpoint; the rest are served from the plan's chat/completions.
$GoOpus   = 'deepseek-v4-flash'
$GoSonnet = 'deepseek-v4-flash'
$GoHaiku  = 'deepseek-v4-flash'
$ZenOpus   = 'claude-opus-4-8'
$ZenSonnet = 'claude-sonnet-4-6'
$ZenHaiku  = 'claude-haiku-4-5'

function Read-Config {
  $cfg = @{}
  if (Test-Path $ConfigFile) {
    foreach ($line in Get-Content $ConfigFile) {
      if ($line -match '^([A-Z_]+)=(.*)$') { $cfg[$matches[1]] = $matches[2] }
    }
  }
  return $cfg
}

function Write-Config([hashtable]$cfg) {
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  $lines = @('OPENCODE_GO_KEY', 'OPENCODE_ZEN_KEY', 'OPENCODE_PLAN', 'OPENCODE_API_KEY') |
    Where-Object { $cfg[$_] } | ForEach-Object { "$_=$($cfg[$_])" }
  Set-Content -Path $ConfigFile -Value $lines -Encoding ASCII
  try {
    $acl  = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      "$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -Path $ConfigFile -AclObject $acl
  } catch { }
}

function Get-ListenerPid([int]$port) {
  if ($IsWindows) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) { return $c[0].OwningProcess }
    return $null
  }
  $out = & lsof -ti "tcp:$port" 2>$null
  if ($LASTEXITCODE -eq 0 -and $out) { return [int]$out[-1] }
  return $null
}

function Get-KeyFor([string]$Plan) {
  $cfg = Read-Config
  $name = "OPENCODE_$($Plan.ToUpper())_KEY"
  if ($cfg[$name]) { return $cfg[$name] }
  if ($cfg['OPENCODE_API_KEY']) { return $cfg['OPENCODE_API_KEY'] }
  if ($env:OPENCODE_API_KEY) { return $env:OPENCODE_API_KEY.Trim() }
  return $null
}

function Save-KeyFor([string]$Plan, [string]$Key) {
  $Key = $Key.Trim()
  if ([string]::IsNullOrEmpty($Key)) {
    Write-Host 'Refusing to save an empty key.'
    return
  }
  $cfg = Read-Config
  $cfg["OPENCODE_$($Plan.ToUpper())_KEY"] = $Key
  $cfg['OPENCODE_PLAN'] = $Plan
  Write-Config $cfg
  Write-Host "Key saved for the '$Plan' plan to $ConfigFile"
}

function Set-Plan([string]$Plan) {
  $Plan = $Plan.Trim().ToLower()
  if ($Plan -notin @('go', 'zen', 'free')) {
    Write-Host "Plan must be 'go', 'zen' or 'free'."
    exit 1
  }
  $cfg = Read-Config
  $cfg['OPENCODE_PLAN'] = $Plan
  Write-Config $cfg
  Write-Host "$Green Plan set to '$Plan'.$Reset"
}

function Get-Plan {
  $p = (Read-Config)['OPENCODE_PLAN']
  if ($p -in @('go', 'zen', 'free')) { return $p }
  return 'go'
}

function Get-PlanConfigured {
  return $null -ne (Read-Config)['OPENCODE_PLAN']
}

function Invoke-PlanPrompt {
  Show-Banner 'Choose your OpenCode plan'
  Write-Host "$Dim  1) $Green$Bold go$Reset$Dim   - flat-fee Go subscription$Reset"
  Write-Host "$Dim  2) $Green$Bold zen$Reset$Dim  - pay-as-you-go Zen$Reset"
  Write-Host "$Dim  3) $Green$Bold free$Reset$Dim - no account needed, free models only$Reset"
  Write-Host ''
  for ($i = 0; $i -lt 3; $i++) {
    $p = (Read-Host "$Accent$Bold Choose plan [1/2/3]$Reset").Trim().ToLower()
    if ($p -eq '1' -or $p -eq 'go') { Set-Plan 'go'; return }
    if ($p -eq '2' -or $p -eq 'zen') { Set-Plan 'zen'; return }
    if ($p -eq '3' -or $p -eq 'free') { Set-Plan 'free'; return }
    Write-Host "$Yellow Pick 1, 2, 3, 'go', 'zen' or 'free'.$Reset"
  }
  Write-Host "$Yellow Aborting after 3 invalid attempts.$Reset"
  exit 1
}

function Invoke-Setup([string]$Plan) {
  Show-Banner "opencodeclaude - API key ($Plan)"
  Write-Host "$Dim Get a key:$Reset $Blue${Bold}https://opencode.ai/auth$Reset"
  Write-Host ''
  for ($i = 0; $i -lt 3; $i++) {
    $secure = Read-Host -AsSecureString "$Accent$Bold OpenCode API key for $Plan$Reset"
    $bstr   = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $key    = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    $key = $key.Trim()
    if ($key) { Save-KeyFor $Plan $key; return }
    Write-Host "$Yellow Key can't be empty.$Reset"
  }
  Write-Host "$Yellow Aborting after 3 empty attempts.$Reset"
  exit 1
}

# --- subcommands -----------------------------------------------------------
if ($args.Count -ge 1) {
  switch -Regex ($args[0]) {
    '^(key|config|set-key|change|change-key|--key|--config|--set-key|--change|--change-key)$' {
      $setPlan = Get-Plan
      $inline = $null
      if ($args.Count -ge 2) {
        if ($args[1] -in @('go', 'zen')) {
          $setPlan = $args[1]
          if ($args.Count -ge 3) { $inline = $args[2] }
        } else {
          $inline = $args[1]
        }
      }
      if ($inline) { Save-KeyFor $setPlan $inline } else { Invoke-Setup $setPlan }
      Write-Host "Done. Run 'opencodeclaude' to start."
      exit 0
    }
    '^(plan|--plan)$' {
      if ($args.Count -ge 2) { Set-Plan $args[1] } else { Write-Host "Current plan: $(Get-Plan)" }
      exit 0
    }
    '^(reset|--reset)$' {
      if (Test-Path $ConfigFile) { Remove-Item $ConfigFile -Force }
      Write-Host 'Stored keys removed.'
      exit 0
    }
    '^(uninstall|--uninstall)$' {
      # Stop any proxy still running.
      $stalePid = Get-ListenerPid $Port
      if ($stalePid) { Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue }
      # Remove shims (Windows). Deferred to a detached process: the .cmd shim
      # may be the very batch file running this script, and deleting it while
      # cmd.exe is executing it produces "The batch file cannot be found."
      if ($IsWindows) {
        $shims = @("$env:APPDATA\npm\opencodeclaude.cmd",
                   "$env:LOCALAPPDATA\Microsoft\WindowsApps\opencodeclaude.cmd")
        $cmd = 'Start-Sleep -Milliseconds 1000; ' + (($shims | ForEach-Object {
                 "Remove-Item -Force -LiteralPath '$_' -ErrorAction SilentlyContinue"
               }) -join '; ')
        Start-Process pwsh -ArgumentList '-NoProfile', '-Command', $cmd -WindowStyle Hidden | Out-Null
      }
      # Remove installed program dir, but only the install location - never the source folder.
      $installRoots = @()
      if ($env:LOCALAPPDATA) { $installRoots += Join-Path $env:LOCALAPPDATA 'Programs\opencodeclaude' }
      $share = if ($env:XDG_DATA_HOME) { Join-Path $env:XDG_DATA_HOME 'opencodeclaude' }
               else { Join-Path (Join-Path $HOME '.local') 'share\opencodeclaude' }
      $installRoots += $share
      $sourceKept = $true
      foreach ($dir in $installRoots) {
        if ($PSScriptRoot -eq $dir) {
          Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
          $sourceKept = $false
        }
      }
      # Remove stored key/plan config.
      Remove-Item -Recurse -Force $ConfigDir -ErrorAction SilentlyContinue
      Write-Host 'opencodeclaude uninstalled.'
      if ($sourceKept) { Write-Host "Source folder $PSScriptRoot was kept." }
      exit 0
    }
  }
}

# --- resolve plan, then key ------------------------------------------------
if (-not (Get-PlanConfigured)) {
  Invoke-PlanPrompt
}

$plan = Get-Plan
$freeMode = $plan -eq 'free'
$key = $null

if (-not $freeMode) {
  $key = Get-KeyFor $plan

  if (-not $key -and $env:OPENCODE_API_KEY) {
    $key = $env:OPENCODE_API_KEY.Trim()
    Write-Host 'Using OPENCODE_API_KEY from environment; saving for next time.'
    Save-KeyFor $plan $key
  }

  if (-not $key) {
    Invoke-Setup $plan
    $key = Get-KeyFor $plan
  }

  if (-not $key) {
    Write-Host "No API key available for the '$plan' plan. Run 'opencodeclaude key' to set one."
    exit 1
  }
}

# --- prereqs ---------------------------------------------------------------
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host 'claude CLI not found on PATH.'
  Write-Host 'Install Claude Code first: https://docs.claude.com/en/docs/claude-code'
  exit 127
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'node not found on PATH. OpenCode Go / Zen non-Claude models need the proxy.'
  exit 127
}

# --- plan & models ---------------------------------------------------------
$plan = Get-Plan
$freeMode = $plan -eq 'free'
Write-Host "$Accent$Bold ● opencodeclaude$Reset  $Dim> using$Reset $Green$Bold$plan$Reset$Dim plan$Reset$Dim  (change: opencodeclaude plan go|zen|free, key: opencodeclaude key)$Reset"
if ($plan -eq 'go') {
  $env:ANTHROPIC_DEFAULT_OPUS_MODEL   = $GoOpus
  $env:ANTHROPIC_DEFAULT_SONNET_MODEL = $GoSonnet
  $env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = $GoHaiku
  $defaultModel = $GoSonnet
} elseif ($plan -eq 'zen') {
  $env:ANTHROPIC_DEFAULT_OPUS_MODEL   = $ZenOpus
  $env:ANTHROPIC_DEFAULT_SONNET_MODEL = $ZenSonnet
  $env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = $ZenHaiku
  $defaultModel = $ZenSonnet
} else {
  $freeModel = 'deepseek-v4-flash-free'
  $env:ANTHROPIC_DEFAULT_OPUS_MODEL   = $freeModel
  $env:ANTHROPIC_DEFAULT_SONNET_MODEL = $freeModel
  $env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = $freeModel
  $defaultModel = $freeModel
}

# --- proxy -----------------------------------------------------------------
$env:OPENCODE_GO_KEY  = Get-KeyFor 'go'
$env:OPENCODE_ZEN_KEY = Get-KeyFor 'zen'
$env:OPENCODE_API_KEY = $key
$env:OPENCODE_PLAN    = $plan

$proxyProc = $null
try {
  # Kill any stale opencodeclaude proxy already on the port so we always run current code.
  $healthy = $false
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $healthy = $true }
  } catch { }
  if ($healthy) {
    $stalePid = Get-ListenerPid $Port
    if ($stalePid) {
      Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 500
    }
  }

  $proxyProc = Start-Process -FilePath node -ArgumentList $ProxyFile -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
  }
  if (-not $healthy) {
    Write-Host 'Proxy failed to start. Is port 3456 free?'
    if ($proxyProc) { Stop-Process -Id $proxyProc.Id -Force -ErrorAction SilentlyContinue }
    exit 1
  }

  # --- launch ----------------------------------------------------------------
  $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$Port"
  $env:ANTHROPIC_API_KEY  = if ($freeMode) { 'opencode-free' } else { $key }
  $env:ANTHROPIC_AUTH_TOKEN = $env:ANTHROPIC_API_KEY
  $env:ANTHROPIC_MODEL    = $defaultModel
  $env:CLAUDE_CODE_SUBAGENT_MODEL = $env:ANTHROPIC_DEFAULT_HAIKU_MODEL
  $env:CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1'
  $env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'

  & claude @args
  $code = $LASTEXITCODE
} finally {
  if ($proxyProc) {
    Stop-Process -Id $proxyProc.Id -Force -ErrorAction SilentlyContinue
  }
}

exit $code
