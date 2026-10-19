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

# The launcher in the nightshift home, refreshed from this plugin version.
function Install-NsLauncher {
  Copy-Item (Join-Path $NsRoot 'bin\run.ps1') $NsLauncher -Force
}
