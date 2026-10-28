# Shared by trigger.ps1 and nightshift.ps1 (dot-sourced). The nightshift home holds the registry,
# locks, logs and the launcher. It's in the user profile, not AppData: the Claude desktop app's
# processes see a private copy of AppData, so its scheduled runs and Task Scheduler's runs wouldn't
# share state there.

# Continue, not Stop: in Windows PowerShell, git's progress on stderr would otherwise end a script.
$ErrorActionPreference = 'Continue'

$NsHome = if ($env:NIGHTSHIFT_HOME) { $env:NIGHTSHIFT_HOME } else { Join-Path $env:USERPROFILE '.nightshift' }
$NsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path # this file is bin\lib\common.ps1
$NsRegistry = Join-Path $NsHome 'repos.json'
$NsLauncher = Join-Path $NsHome 'run.ps1'
# The fine-grained GitHub token the agents use, when the owner has set one (DESIGN.md, "GitHub access").
$NsToken = Join-Path $NsHome 'gh-token'
# The Discord webhook the owner is told about stuck repos on, when set (DESIGN.md, "Back-off").
$NsDiscord = Join-Path $NsHome 'discord-webhook'
foreach ($dir in 'logs', 'locks', 'last-run') { New-Item -ItemType Directory -Force (Join-Path $NsHome $dir) | Out-Null }

# Git reports "dubious ownership" on drives that don't record owners (exFAT); runs inherit these.
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = '*'

function Write-NsLog($message) {
  [IO.File]::AppendAllText((Join-Path $NsHome 'logs\nightshift.log'), "$(Get-Date -Format s) $message`r`n")
}

function Get-NsRepos {
  if (-not (Test-Path $NsRegistry)) { return @() }
  @((Get-Content $NsRegistry -Raw | ConvertFrom-Json).repos)
}

function Save-NsRepos($repos) {
  # UTF-8 without a byte-order mark (Windows PowerShell's Set-Content -Encoding utf8 adds one).
  [IO.File]::WriteAllText($NsRegistry, (ConvertTo-Json -InputObject @{ repos = @($repos) } -Depth 5))
}

# "owner/name" from a remote URL (https or ssh).
function Get-NsGithub($url) {
  if ($url -match 'github\.com[:/](.+?)(\.git)?$') { return $Matches[1] }
  $null
}

# The repo's config, as committed (only the fields the scripts need; the skills get the merged one).
function Get-NsBranchPrefix($checkout) {
  $path = Join-Path $checkout '.claude\nightshift.json'
  $config = if (Test-Path $path) { Get-Content $path -Raw | ConvertFrom-Json } else { $null }
  if ($config.builder.branchPrefix) { $config.builder.branchPrefix } else { 'agent/issue-' }
}

# Points gh at the nightshift token for this process and everything it starts, when there is one.
# Returns $false when the token is there but can't be read: callers stop rather than fall back to
# the owner's own gh login, which can do far more.
function Use-NsToken {
  if (-not (Test-Path $NsToken)) { return $true }
  try {
    $secure = (Get-Content -Raw -LiteralPath $NsToken).Trim() | ConvertTo-SecureString -ErrorAction Stop
    $env:GH_TOKEN = [Net.NetworkCredential]::new('', $secure).Password
    return [bool]$env:GH_TOKEN
  } catch {
    return $false
  }
}

# The launcher in the nightshift home, refreshed from this plugin version.
function Install-NsLauncher {
  Copy-Item (Join-Path $NsRoot 'bin\run.ps1') $NsLauncher -Force
}

# A Task Scheduler action that runs the launcher with no window. powershell.exe's -WindowStyle
# Hidden still opens one first (and, where Windows Terminal is the default terminal, a whole
# terminal window that stays), so the console host runs it headless instead.
function New-NsHiddenAction($arguments) {
  New-ScheduledTaskAction -Execute 'conhost.exe' `
    -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$NsLauncher`" $arguments"
}
