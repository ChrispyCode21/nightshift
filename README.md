# nightshift

Off-peak builder and reviewer agents for any repo you opt in, packaged as a Claude Code plugin. They run on your Claude plan from the desktop app and the CLI, not on API credit. How it works and why: [DESIGN.md](DESIGN.md).

## Install

```powershell
claude plugin marketplace add ChrispyCode21/nightshift
claude plugin install nightshift@nightshift
```

## Opt a repo in

1. Commit a `.claude/nightshift.json` to the repo (`{}` works; see DESIGN.md, "The config file").
2. Register its checkout on this machine. That creates the builder's clone (`<checkout>-builder`) and the reviewer's worktree (`<checkout>-reviewer`) installs the pre-push hook and creates the standard labels (see Labels below):

```powershell
$ns = (Get-Content "$env:USERPROFILE\.claude\plugins\installed_plugins.json" -Raw | ConvertFrom-Json).plugins.'nightshift@nightshift'[0].installPath
& "$ns\bin\nightshift.ps1" register D:\Projects\MyRepo
```

Optionally, give the agents a fine-grained GitHub token scoped to the registered repos, instead of your full gh login (DESIGN.md, "GitHub access" lists the permissions): `nightshift.ps1 token`.

Optionally, get a Discord message when something needs you: the builder opened a PR, the builder left a question on an issue (`Result: built PR <n>` or `need answers on issue <m>`), or a repo's agent is stuck (three runs in a row that came to nothing, so it now waits 2 hours between tries) and when it recovers. Runs that find nothing to do stay quiet. Create a webhook in a channel's settings, then `nightshift.ps1 discord`.

After the first registration, `%USERPROFILE%\.nightshift\run.ps1 nightshift.ps1 <command>` runs the installed version from anywhere.

## Labels

GitHub labels belong to one repository; there are no account-wide labels. `register` creates nightshift's standard labels in the repo it registers: `on-hold`, `agent-needs-info`, `agent-followup`, `standards`, `touches-data`, `touches-gates`, `reviewed`, `nightshift` and `question`. It only creates the ones that are missing, never changes one that exists, and only warns if it can't (a token that doesn't include the repo yet: add it, then run `register` again with the same options; that also re-enables a disabled repo). The list is `bin/lib/labels.mjs`.

Putting `on-hold` on an issue pauses that issue for the builder: it skips it and reports it as waiting. It doesn't pause the repo (`disable` does) or the reviewer. Remove the label to resume.

The builder skips issues labeled `agent-needs-info`, `agent-followup`, `question` or `on-hold` (`builder.skipLabels` in `defaults/nightshift.json`). A repo whose own `.claude/nightshift.json` sets `builder.skipLabels` replaces that list (arrays replace, objects merge; `bin/lib/config.mjs`), so it must include `on-hold` itself:

```json
{ "builder": { "skipLabels": ["agent-needs-info", "agent-followup", "question", "on-hold", "my-label"] } }
```

## Run it

- **Nightly:** two desktop scheduled tasks, `/nightshift:build-next-issue` at 2:00 AM and `/nightshift:review-prs` at 4:00 AM (local time; outside Anthropic's peak hours).
- **When something happens:** `nightshift.ps1 watch` installs a Windows task that checks every registered repo every 90 minutes, waking the PC if it's asleep, at no token cost until there's work. During peak hours it defers the work to 11:05 AM Pacific.
- **By hand:** `nightshift.ps1 trigger <repo> build|review` (`-Now` skips the peak-hours, back-off and usage checks).

## Commands

| Command | Does |
|---|---|
| `register <checkout>` | opts a checkout in on this machine (the repo must have its config file) and creates the standard labels in the repo |
| `unregister <name>` | removes the hook and the entry; leaves the checkouts |
| `enable` / `disable <name>` | pauses a repo without touching its code |
| `status` | the registered repos, the watcher, and the last 15 log lines (each run ends with what it did) |
| `trigger <name> build\|review` | runs one agent for one repo now, if Tier 0 finds work, and prints what it does as it goes |
| `logs [<name>]` / `logs -List` | prints the newest run log (for one repo), or lists the last 20 runs from `runs.jsonl` |
| `watch` / `watch -Off` | installs or removes the 90-minute watcher |
| `token` / `token -Off` | sets or removes the fine-grained GitHub token the agents use |
| `discord` / `discord -Off` | sets or removes the Discord webhook that hears about PRs opened, questions left and stuck repos (DESIGN.md, "Back-off") |
| `tidy [<checkout>] [-DryRun]` | deletes local branches whose work is on `main` and their clean worktrees; the watcher runs it nightly after 9 PM (DESIGN.md, "Tidying checkouts") |

State (registry, locks, logs, and `runs.jsonl`, one record per run) lives in `%USERPROFILE%\.nightshift\`.
