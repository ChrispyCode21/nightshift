# nightshift's command line (DESIGN.md, "Opting a repo in"). Run it from the installed plugin, or
# through the launcher in the nightshift home once one repo is registered:
#
#   nightshift.ps1 register <checkout> [-Name <n>] [-Builder <path>] [-Reviewer <path>]
#   nightshift.ps1 unregister <name>          removes the hook and the entry, leaves the checkouts
#   nightshift.ps1 enable|disable <name>      pauses a repo without touching its code
#   nightshift.ps1 status                     the registered repos, the watcher and recent log lines
#   nightshift.ps1 trigger <name> build|review [-Now]
#   nightshift.ps1 watch [-Off]               the 30-minute watcher (a Windows scheduled task)
#   nightshift.ps1 tick                       one watcher pass: Tier 0 for every enabled repo
#   nightshift.ps1 token [-Off]               the fine-grained GitHub token the agents use
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet('register', 'unregister', 'enable', 'disable', 'status', 'trigger', 'watch', 'tick', 'token')]
  [string]$Command,
  [Parameter(Position = 1)][string]$Target,
  [Parameter(Position = 2)][string]$Agent,
  [string]$Name,
  [string]$Builder,
  [string]$Reviewer,
  [switch]$Now,
  [switch]$Off
)
. (Join-Path $PSScriptRoot 'lib\common.ps1')
$WatchTask = 'nightshift watch'
$HookMark = 'nightshift pre-push hook'

# Write-Host, not Write-Output: callers pipe some functions to Out-Null, which would swallow it.
function Fail($message) { Write-Host "nightshift: $message"; exit 1 }
function Find-Repo($name) {
  $entry = Get-NsRepos | Where-Object name -eq $name | Select-Object -First 1
  if (-not $entry) { Fail "$name isn't registered." }
  $entry
}
function Get-HookPath($checkout) {
  if (git -C $checkout config --get core.hooksPath) { return $null }
  $common = git -C $checkout rev-parse --path-format=absolute --git-common-dir
  Join-Path $common 'hooks\pre-push'
}
function Slash($path) { $path -replace '\\', '/' }

switch ($Command) {
  'register' {
    if (-not $Target) { Fail 'Usage: register <checkout>' }
    $checkout = (Resolve-Path $Target).Path
    if (-not (Test-Path (Join-Path $checkout '.claude\nightshift.json'))) {
      Fail "$checkout has no .claude\nightshift.json. Commit one first: it's the repo's half of opting in."
    }
    $url = git -C $checkout remote get-url origin
    $github = Get-NsGithub $url
    if (-not $github) { Fail "origin ($url) isn't a GitHub repo." }
    $repoName = if ($Name) { $Name } else { ($github -split '/')[1].ToLower() }
    git -C $checkout remote set-head origin --auto 2>&1 | Out-Null

    # The builder works in its own clone, the reviewer in a worktree kept at the default branch.
    $builderPath = if ($Builder) { $Builder } else { "$checkout-builder" }
    if (-not (Test-Path $builderPath)) {
      git clone $url $builderPath 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "couldn't clone $url into $builderPath." }
    }
    git -C $builderPath remote set-head origin --auto 2>&1 | Out-Null
    $reviewerPath = if ($Reviewer) { $Reviewer } else { "$checkout-reviewer" }
    if (-not (Test-Path $reviewerPath)) {
      git -C $checkout fetch origin 2>&1 | Out-Null
      git -C $checkout worktree add --detach $reviewerPath origin/HEAD 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "couldn't add the reviewer's worktree at $reviewerPath." }
    }

    Install-NsLauncher
    $hook = Get-HookPath $checkout
    $hookNote = if (-not $hook) {
      'not installed: this repo sets core.hooksPath. Call the launcher from your own pre-push (see bin/hooks/pre-push).'
    } elseif ((Test-Path $hook) -and -not (Select-String -Quiet -Path $hook -Pattern $HookMark)) {
      "not installed: $hook already exists. Merge bin/hooks/pre-push into it by hand."
    } else {
      $template = Get-Content (Join-Path $NsRoot 'bin\hooks\pre-push') -Raw
      $text = $template.Replace('__LAUNCHER__', (Slash $NsLauncher)).Replace('__REVIEWER__', (Slash $reviewerPath)).Replace('__BUILDER__', (Slash $builderPath))
      [IO.File]::WriteAllText($hook, $text.Replace("`r`n", "`n"))
      "installed ($hook)"
    }

    $repos = @(Get-NsRepos | Where-Object name -ne $repoName)
    $repos += [pscustomobject]@{
      name = $repoName; github = $github; checkout = $checkout
      builder = $builderPath; reviewer = $reviewerPath; enabled = $true
    }
    Save-NsRepos $repos
    Write-NsLog "[$repoName] registered"
    Write-Output "Registered $repoName ($github)."
    Write-Output "  checkout  $checkout"
    Write-Output "  builder   $builderPath"
    Write-Output "  reviewer  $reviewerPath"
    Write-Output "  hook      $hookNote"
  }
  'unregister' {
    $entry = Find-Repo $Target
    $hook = Get-HookPath $entry.checkout
    if ($hook -and (Test-Path $hook) -and (Select-String -Quiet -Path $hook -Pattern $HookMark)) { Remove-Item $hook }
    Save-NsRepos @(Get-NsRepos | Where-Object name -ne $Target)
    Write-NsLog "[$Target] unregistered"
    Write-Output "Unregistered $Target. Its checkouts are left in place."
  }
  { $_ -in 'enable', 'disable' } {
    Find-Repo $Target | Out-Null
    $repos = @(Get-NsRepos | ForEach-Object {
        if ($_.name -eq $Target) { $_ | Add-Member -Force enabled ($Command -eq 'enable') }
        $_
      })
    Save-NsRepos $repos
    Write-Output "$Target ${Command}d."
  }
  'status' {
    $ready = node (Join-Path $NsRoot 'bin\preflight.mjs') repos | Out-String | ConvertFrom-Json
    foreach ($r in $ready.repos) {
      $line = if ($r.ready) { 'ready' } else { $r.reason }
      Write-Output ("{0,-20} {1,-36} {2}" -f $r.name, $r.github, $line)
    }
    if (-not $ready.repos) { Write-Output 'No repos registered.' }
    $task = Get-ScheduledTask -TaskName $WatchTask -ErrorAction SilentlyContinue
    Write-Output "`nWatcher: $(if ($task) { $task.State } else { 'not installed' })"
    Write-Output "GitHub:  $(if (Test-Path $NsToken) { 'the nightshift token' } else { 'your own gh login (nightshift.ps1 token narrows it)' })"
    $log = Join-Path $NsHome 'logs\nightshift.log'
    if (Test-Path $log) { Write-Output "`nRecent:"; Get-Content $log -Tail 8 }
  }
  'trigger' {
    if ($Agent -notin 'build', 'review') { Fail 'Usage: trigger <name> build|review [-Now]' }
    Find-Repo $Target | Out-Null
    & (Join-Path $PSScriptRoot 'trigger.ps1') -Agent $Agent -Repo $Target -Now:$Now
  }
  'watch' {
    if ($Off) {
      Unregister-ScheduledTask -TaskName $WatchTask -Confirm:$false -ErrorAction SilentlyContinue
      Write-Output 'Watcher removed.'
      break
    }
    Install-NsLauncher
    $action = New-NsHiddenAction 'nightshift.ps1 tick'
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(15) -RepetitionInterval (New-TimeSpan -Minutes 30)
    # A pass still running when the next is due makes the next one skip.
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $WatchTask -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Output "Watcher installed: '$WatchTask' in Task Scheduler, every 30 minutes."
  }
  'tick' {
    foreach ($entry in Get-NsRepos | Where-Object { $_.enabled -ne $false }) {
      & (Join-Path $PSScriptRoot 'trigger.ps1') -Agent review -Repo $entry.name
      & (Join-Path $PSScriptRoot 'trigger.ps1') -Agent build -Repo $entry.name
    }
  }
  'token' {
    if ($Off) {
      Remove-Item -LiteralPath $NsToken -ErrorAction SilentlyContinue
      Write-Output 'Token removed. The agents use your own gh login again.'
      break
    }
    Write-Output 'Paste a fine-grained GitHub token (DESIGN.md, "GitHub access" says which permissions).'
    Write-Output 'It is stored encrypted, readable only by this Windows user on this machine.'
    $secure = Read-Host -AsSecureString 'Token'
    if ($secure.Length -eq 0) { Fail 'No token given; nothing changed.' }
    $env:GH_TOKEN = [Net.NetworkCredential]::new('', $secure).Password
    $login = gh api user --jq .login 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $login) {
      Remove-Item Env:GH_TOKEN
      Fail "GitHub didn't accept that token; nothing changed."
    }
    Set-Content -LiteralPath $NsToken -Value ($secure | ConvertFrom-SecureString) -Encoding ascii
    Write-NsLog 'GitHub token set'
    Write-Output "Saved. The agents now act as $login with this token. Checking each registered repo:"
    foreach ($entry in Get-NsRepos) {
      gh pr list -R $entry.github --state all --limit 1 --json number,statusCheckRollup 2>$null | Out-Null
      $note = if ($LASTEXITCODE -eq 0) { 'can read PRs and checks' } else { "can't read PRs or checks: add it to the token" }
      Write-Output ("  {0,-36} {1}" -f $entry.github, $note)
    }
    Remove-Item Env:GH_TOKEN
  }
}
