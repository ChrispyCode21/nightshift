# nightshift

Off-peak builder and reviewer agents for any repo you opt in, packaged as a Claude Code plugin. They run on your Claude plan from the desktop app and the CLI, not on API credit. How it works and why: [DESIGN.md](DESIGN.md).

## Install

```powershell
claude plugin marketplace add ChrispyCode21/nightshift
claude plugin install nightshift@nightshift
```

## Opt a repo in

1. Commit a `.claude/nightshift.json` to the repo (`{}` works; see DESIGN.md, "The config file").
2. Register its checkout on this machine. That creates the builder's clone (`<checkout>-builder`) and the reviewer's worktree (`<checkout>-reviewer`) and installs the pre-push hook:

```powershell
$ns = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw | ConvertFrom-Json).plugins.'nightshift@nightshift'[0].installPath
& "$ns\bin\nightshift.ps1" register D:\Projects\MyRepo
```

Optionally, give the agents a fine-grained GitHub token scoped to the registered repos, instead of your full gh login (DESIGN.md, "GitHub access" lists the permissions): `nightshift.ps1 token`.

After the first registration, `%USERPROFILE%\.nightshift\run.ps1 nightshift.ps1 <command>` runs the installed version from anywhere.

## Run it

- **Nightly:** two desktop scheduled tasks, `/nightshift:build-next-issue` at 2:00 AM and `/nightshift:review-prs` at 4:00 AM (local time; outside Anthropic's peak hours).
- **When something happens:** `nightshift.ps1 watch` installs a Windows task that checks every registered repo every 30 minutes, at no token cost until there's work. During peak hours it defers the work to 11:05 AM Pacific.
- **By hand:** `nightshift.ps1 trigger <repo> build|review` (`-Now` skips the peak-hours and cool-down checks).

## Commands

| Command | Does |
|---|---|
| `register <checkout>` | opts a checkout in on this machine (the repo must have its config file) |
| `unregister <name>` | removes the hook and the entry; leaves the checkouts |
| `enable` / `disable <name>` | pauses a repo without touching its code |
| `status` | the registered repos, the watcher, and recent log lines |
| `trigger <name> build\|review` | runs one agent for one repo now, if Tier 0 finds work |
| `watch` / `watch -Off` | installs or removes the 30-minute watcher |
| `token` / `token -Off` | sets or removes the fine-grained GitHub token the agents use |

State (registry, locks, logs) lives in `%USERPROFILE%\.nightshift\`.
