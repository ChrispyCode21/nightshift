# nightshift design

nightshift runs two agents on any repo you opt in: a **builder** that turns a milestone's issues into PRs (or asks numbered questions on them), and a **reviewer** that reviews, fixes and merges those PRs (or holds them for you). It's the agent pipeline from Logtelligent (`.github/agent/PIPELINE.md` there), with Logtelligent's assumptions pulled out into a per-repo config file.

## Goals

- **Any repo, opt-in only.** Agents run only where the repo has a config file *and* you registered its checkout on this machine.
- **Your plan, not API credit.** Desktop scheduled tasks and `claude -p` on your login. No GitHub Actions, no API keys.
- **Only the GitHub access the agents need.** They run only the gh commands nightshift uses, and with a fine-grained token, only on the registered repos ("GitHub access").
- **Off-peak.** Nightly runs, and triggered runs deferred past Anthropic's peak hours (5–11 AM Pacific).
- **Your usage first.** No run starts once the plan's 5-hour window is at 85% or its weekly window at 90%.
- **Cheap when idle.** Tier 0 is a script; a night with nothing to do costs no tokens.
- **Each repo's standards win for what the agent writes; your baseline is reported, not imposed** ("Standards").

Not goals: hosting anything, multiple users, or running on repos you haven't registered.

## How it runs

The same mechanics Logtelligent uses now (its PIPELINE.md, "Tiers" and "Triggers"), changed only to loop over registered repos.

**Tiers.** One coordinating session per run handles commands and GitHub writes; subagents do the thinking, passing files, not transcripts.

| Tier | Model | Builder | Reviewer |
|---|---|---|---|
| 0: gate | none | `preflight.mjs build`: open build PR, milestone, candidates | `preflight.mjs review`: PRs due, risk hints |
| 1: plan | Sonnet | `issue.md` (the packet) and `plan.md` (a verdict) | compliance and correctness reviews, into `review.md` |
| 2: advise | Opus | reviews a build plan against `issue.md` only | decides each finding from `review.md`, the diff and `issue.md` only |
| 3: execute | Sonnet | builds the approved plan, runs the checks | makes the fixes, runs the checks |

**Schedule.** Two desktop scheduled tasks: builder at 2:00 AM, reviewer at 4:00 AM Central. Each loops over the registry, one repo at a time, at most one build per repo per night. Before starting each repo it checks the clock and the plan's usage: a repo it reaches during peak hours waits for the deferred run, and one it reaches with usage near the limits (`USAGE_LIMITS` in `gates.mjs`) waits for the next run. `preflight.mjs usage` reads the usage from one tiny headless Haiku run, the only place Claude Code reports it outside its interactive status line.

**Triggers.** One watcher (a Windows scheduled task, every 30 minutes) runs Tier 0 for every registered repo; a pre-push hook in each registered checkout starts the reviewer when you push to an agent or Dependabot branch; `nightshift trigger <repo> build|review` by hand. All go through `trigger.ps1`: lock check, refresh, Tier 0, then run headless or defer past peak, unless usage is near the limits. The Windows scheduled tasks run under `conhost.exe --headless`, so they never open a window.

**Long runs.** `claude -p` ends its session when the coordinator ends its turn, and stops any subagent still in the background 10 minutes later ("Background tasks still running…"), which cuts a Tier 3 build off before it is pushed. `trigger.ps1` raises that wait to 70 minutes (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`) and kills a run after 3 hours. It exports its own pid for the lock (`pid N (runner)`), so a lock whose launcher has died is stale at once instead of after 4 hours, and it releases the lock when the run ends however it ends. A run is logged `finished (0) in 41s: <summary>` only if it exited 0 and neither its log nor its stderr shows Claude Code cut it off (`runFailure` in `lib/runs.mjs`); otherwise `failed: <why> in 41s`, and the 3-hour cool-down applies. The `outcome` step writes both that line and one record in `runs.jsonl` (start, end, repo, agent, exit code, outcome, duration, the PRs and issues named, log file name). The summary is the last few lines of stdout, never stderr, cut to printable ASCII: it is text from a run that read issues and PRs, so it is only printed, never executed or fed back to a model.

## Tidying checkouts

GitHub deletes a PR's branch when it merges (auto-delete is on for the registered repos), but git never deletes local branches or worktrees, and every Claude session leaves its own behind. nightshift already cleans up after its own runs; `nightshift tidy` does the same for the owner's checkouts.

`nightshift.ps1 tidy [<checkout>] [-DryRun]`: with no path it tidies every enabled registered repo's checkout and builder clone; with a path it tidies that checkout, registered or not (like nightshift's own). For each checkout it runs `git fetch --prune origin`, then looks at every local branch other than origin's default branch and deletes it (`git branch -D`) when nothing on it would be lost:

- **Its PR merged.** The branch isn't on origin any more, GitHub has a merged PR from it, and every commit on the branch that isn't in `origin/main` is one of that PR's commits, or the branch's tree is the PR head's tree. Squash and rebase merges are why it asks GitHub: `git branch -d` refuses those branches because `main` has different commits with the same content.
- **Or it's already in `origin/main`.** The branch isn't on origin and its tip is an ancestor of `origin/main`. Sessions leave these behind when they switch branches partway through.

It keeps, and reports, everything else. That covers a branch still on origin, one with an open PR, one with commits beyond its merged PR, one with commits not in `origin/main` and no merged PR (never pushed, or its PR closed unmerged), and every branch when GitHub can't be read and the branch isn't already in `origin/main`. It also keeps the branch the checkout itself is on. When that branch would otherwise go, the report says to switch the checkout to `main`, or it's kept every night.

Worktrees:

- **`.claude/worktrees/`** belongs to Claude desktop sessions, and the app removes a session's worktree when it archives the session. `tidy` never removes one, even an idle one: a resumed session would find it gone. Their branches are kept while the worktree exists and go by the rules above once the app has removed it.
- **Any other worktree** on a branch that would go is removed with `git worktree remove` (never `--force`), then its branch is deleted. It's left alone, with a report, when it's in use: it has changes (`git status --porcelain`), it's locked, or its `index`, `HEAD` or HEAD's reflog changed in the last day. A worktree on a detached HEAD, like the reviewer's, has no branch and is never touched.
- `git worktree prune` drops the records of worktree folders that are already gone, so their branches can go too.

One line per checkout goes to `nightshift.log`: `tidied N branches, M worktrees; kept K (why)`. `-DryRun` prints what it would do, logs nothing and changes nothing but origin's remote-tracking refs (the fetch).

**Locks and GitHub.** A registered repo with a builder or reviewer lock is skipped for the day, so `tidy` never changes a checkout under a run. A dry run reports the lock and still shows what it would do. A registered repo is read with the nightshift token, like Tier 0. An unregistered checkout probably isn't on that token, so it uses the owner's own gh login, which `tidy` only reads PRs with.

**Daily run.** The watcher runs `tidy` for the registered repos once a day, on its first `tick` after 9 PM local, before that pass starts any run. That way it never pulls a branch out from under a daytime session, and it's done before the 2 AM builder. `last-run\<repo>-tidy` in the nightshift home records the day's run. The rules are `bin/lib/tidy.mjs` (unit-tested in `test/tidy.test.mjs`); `bin/tidy.mjs` reads git and GitHub and acts on them.

## GitHub access

The agents act as you on GitHub, and everything they read in issues, comments and PRs is untrusted text. Two limits keep text that tries to steer them from reaching more than PRs and issues:

- **Only nightshift's gh commands.** The skills run gh through `node bin/gh.mjs`, which allows `pr` (checks, comment, create, diff, edit, list, merge, view), `issue` (comment, create, edit, list, view), `label` (create, list), `repo view`, `run` (list, view) and `api` with GET or POST, and refuses the rest (`auth token`, `secret`, `repo delete`, `workflow run`, `api -X DELETE`, …). Headless runs don't allow `gh` itself at all. The list is in `bin/lib/github.mjs`.
- **A fine-grained token (optional, recommended).** Without one, gh uses your own login, which reaches every repo you can. `nightshift.ps1 token` stores a fine-grained token, encrypted with Windows DPAPI for your user, and Tier 0, `gh.mjs` and `trigger.ps1` use it. A token that can't be read stops the run; it never falls back to your login. `token -Off` goes back to your login.

Create the token at GitHub → Settings → Developer settings → Fine-grained tokens:

| Setting | Value |
|---|---|
| Repository access | Only select repositories: the registered ones |
| Contents | Read and write (merging) |
| Pull requests | Read and write |
| Issues | Read and write (comments, labels, sub-issues, blockers) |
| Actions, Commit statuses | Read-only (CI results for `pr checks` and failure logs) |
| Workflows | Only if a repo sets `ownerMerges.dependabotWorkflows: false`, so the reviewer can merge PRs that change `.github/workflows/` |

`token` checks the token against GitHub before saving it, then lists each registered repo and whether the token can read its PRs and checks. Register a new repo, and add it to the token too. Fine-grained tokens expire: when one does, runs log gh's error, and `token` sets the new one.

What the token doesn't cover: `git push` uses your SSH key, as before, so branch protection is still what guards the default branch. And the agents can run any `node` or `npm` command, so these limits stop steered gh commands, not a determined script; the full answer would be running nightshift as its own Windows user.

## Opting a repo in

Two keys, both required:

1. **`.claude/nightshift.json` in the repo**, committed. Says *how* the agents work there. Reviewed like any code.
2. **A registry entry on this machine** (`%USERPROFILE%\.nightshift\repos.json`). Says *that* they run there, and where. Not AppData: the Claude desktop app is a packaged app whose processes see a private copy of AppData, so its scheduled runs and Task Scheduler's runs wouldn't share the registry, locks or logs there.

```json
{
  "repos": [
    {
      "name": "logtelligent",
      "github": "ChrispyCode21/logtelligent",
      "checkout": "D:\\Projects\\Logtelligent",
      "builder": "D:\\Projects\\Logtelligent-builder",
      "reviewer": "D:\\Projects\\Logtelligent-reviewer",
      "enabled": true
    }
  ]
}
```

`nightshift register <checkout>` reads the repo's config (refusing if there's none), creates the builder's clone and the reviewer's worktree, installs the pre-push hook (in the repo's `.git/hooks`; a repo that sets `core.hooksPath`, or already has a pre-push hook, calls the launcher from its own instead), adds the entry, and creates the standard labels in the GitHub repo ("Labels"). Hooks and scheduled tasks call `run.ps1` in the nightshift home, which finds the plugin's current install folder, so they survive plugin updates. `unregister` removes the hook and the entry and leaves the checkouts. `enabled: false` pauses a repo without touching its code.

A clone or fork that already has the config file runs nothing until it's registered.

### Labels

GitHub labels are per repository (there are no account-wide labels), and labels added by name before they existed ended up with no color or description. So `register` creates the standard ones (`bin/lib/labels.mjs`, run by `bin/labels.mjs` with the nightshift token like every other gh call): `on-hold`, `agent-needs-info` (added by the builder when it asks questions), `agent-followup` (the reviewer's issues for out-of-scope findings), `standards` (the rolling standards issue), `touches-data` and `touches-gates` (the labels the examples above list in `ownerMerges.labels` and `highRisk.labels`; both lists are empty by default), `reviewed` (on every PR the reviewer has seen), `nightshift` (the builder's issues when `milestones` is `"none"`) and `question`. A label that exists, in any capitalisation, is left alone; one that can't be created is a warning, never a failed registration, and running `register` again with the same options (`-Name`, `-Builder`, `-Reviewer`) retries, and re-enables a repo that was disabled.

`on-hold` is how an issue is paused: `builder.skipLabels` lists the labels whose issues the builder skips and reports as waiting. Only that issue is paused; `enabled: false` pauses the whole repo. A repo's own `builder.skipLabels` replaces the default list (arrays replace, objects merge), so it must include `on-hold` itself.

## The config file

Every field has a default; a repo can start with `{}` plus its check command. Logtelligent's:

```json
{
  "checks": {
    "fast": "npm run check:fast",
    "e2e": "npx playwright test",
    "install": "npm ci"
  },
  "builder": {
    "milestones": "semver",
    "authors": "owner",
    "branchPrefix": "agent/issue-",
    "docs": ["SPEC.md", "CLAUDE.md", "ARCHITECTURE.md"],
    "spec": { "path": "SPEC.md", "recordDecisionsFirst": true },
    "workedExamples": { "paths": ["src/engine/"], "approveOnIssue": true, "section": "SPEC.md §7" },
    "neverEdit": [".github/workflows/", ".github/rulesets/", ".claude/"],
    "release": { "issueText": ".claude/nightshift/release-issue.md" }
  },
  "reviewer": {
    "authors": ["agent", "app/dependabot", "app/claude"],
    "projectReviewer": ".claude/agents/architecture-reviewer.md",
    "highRisk": { "paths": ["src/engine/", "src/storage/"], "labels": ["touches-data", "touches-gates"] },
    "ownerMerges": {
      "labels": ["touches-data", "touches-gates"],
      "release": true,
      "dependabotWorkflows": true
    },
    "mergeNotes": { "touches-data": "Export a backup on the phone before merging." },
    "mergeMethod": "merge"
  },
  "standards": {
    "baseline": true,
    "rules": ["ARCHITECTURE.md"],
    "checker": "scripts/check-conventions.mjs",
    "exceptions": [{ "rule": "no-raw-elements", "where": "src/ui/ImportButton.tsx", "reason": "Native file picker needs a raw <button>." }]
  }
}
```

Defaults when a field is absent:

| Field | Default | Effect |
|---|---|---|
| `builder.milestones` | `"semver"` | build from the lowest open `vX.Y.Z` milestone. `"any"`: the oldest open milestone; `"none"`: open issues labeled `nightshift`. |
| `builder.skipLabels` | `["agent-needs-info", "agent-followup", "question", "on-hold"]` | the builder skips an issue with any of these labels. A repo's own list replaces this one, so include `on-hold` in it. |
| `builder.docs` | `["README.md", "CLAUDE.md"]` if present | what Tier 1 reads before planning |
| `builder.spec` | none | no spec: the issue alone is the spec, and decisions are recorded on the issue |
| `builder.workedExamples` | none | no number tables to approve |
| `builder.release` | none | no release issues |
| `reviewer.projectReviewer` | the plugin's generic reviewer | |
| `reviewer.highRisk` | none | Opus is skipped when there are no findings |
| `reviewer.ownerMerges` | `{ "release": true, "dependabotWorkflows": true }` | |
| `standards.baseline` | `true` | |

The skills read the config at Tier 0 (`preflight.mjs` prints the resolved config with its result), so a prompt never says "SPEC.md" unless the repo's config does.

## Standards

Three layers, which govern different actions, so they never conflict:

1. **What the agent writes follows the repo.** The repo's own rules (the `rules` docs, the `checker`, and the patterns in the code it touches) decide how new code looks. Consistency inside a repo beats a better pattern applied in one place.
2. **Where the repo is silent, the baseline applies.** A repo with no rule about tokens gets tokens in new code.
3. **Where the repo breaks the baseline, the agent reports it.** Not fixed in the PR (out of scope), but added to one rolling issue per repo, labeled `standards`: each finding once, with where and which rule. You turn it into cleanup work or an exception.

An **exception** (`standards.exceptions`) says a deviation is deliberate, with a reason; the agent stops reporting it. Without exceptions, the same finding would come back every night.

### The baseline

Rules that pay for themselves: each catches a mistake that's common in agent-written code, costly to find later, and cheap to check. "Lint" means the repo's linter where it has the rule, otherwise `nightshift check`.

**UI**

| Rule | Checked by |
|---|---|
| `no-inline-components`: components are defined at module level, never inside another component's body | script (AST) |
| `no-inline-styles`: no `style={{…}}` or `style="…"` for anything a class or token can express | script |
| `tokens-only`: colors, spacing, radii, font sizes, shadows and z-indexes come from design tokens, not raw values | script, given the repo's token file |
| `use-primitives`: where the repo has a shared component (button, field, card), raw elements with the same role aren't used | script, given the repo's primitives |
| `accessible-by-default`: interactive elements are real controls (`<button>`, `<a href>`, inputs) with accessible names; images have `alt`; nothing is clickable without being focusable | lint (jsx-a11y rules) |
| `respects-preferences`: motion honors `prefers-reduced-motion`, colors work in light and dark, and text pairs meet WCAG AA contrast | review, plus a contrast check on the token file |
| `fits-small-screens`: no fixed widths or sideways scrolling at 320px | review, or the repo's layout tests |

**Code**

| Rule | Checked by |
|---|---|
| `one-formatter`: dates, numbers and units are formatted through shared helpers | review |
| `pure-core`: domain logic has no UI, storage or I/O imports | review, plus a lint rule where the repo has one |
| `strict-types`: TypeScript `strict` on; no `any`, no unexplained `!`, and `@ts-expect-error` with a reason instead of `@ts-ignore` | lint |
| `no-floating-promises`: every promise is awaited, returned or explicitly handled | lint (type-aware) |
| `no-swallowed-errors`: no empty `catch`, and no `catch` that only logs where the caller needed to know | script, then review |
| `no-debug-leftovers`: no `console.log`, `debugger`, commented-out code or `.only` in tests | script |
| `no-dead-code`: no unused exports, files or dependencies | script (a knip-style pass) |
| `named-constants`: domain numbers (limits, rates, thresholds) are named constants, not literals in logic | review |

**Data**

| Rule | Checked by |
|---|---|
| `validate-at-boundaries`: data from the network, storage, files or the URL is parsed and checked where it enters, and typed only after that | review |
| `migrate-stored-data`: changing the shape of stored data comes with a versioned migration and a test that upgrades old data | review |
| `no-secrets`: no keys, tokens or credentialed URLs in code, config or fixtures | script (pattern scan) |

**Tests and dependencies**

| Rule | Checked by |
|---|---|
| `tests-with-logic`: new logic arrives with unit tests, and a fixed bug with a test that would have caught it | review |
| `deterministic-tests`: unit tests control time, randomness and the network instead of using the real ones | review, plus a script for `Date.now()`, `Math.random()` and `fetch` in tests without a fake |
| `earn-each-dependency`: no new dependency for what the platform or an existing one already does; versions pinned by the lockfile | review, plus a script for lockfile drift |

Rules a script can check ship as `nightshift check`, a generic version of Logtelligent's `check-conventions.mjs` configured by the repo (token file, primitives, exceptions). Scripts are reliable where prompts aren't: the review tiers handle only the rules marked "review".

`nightshift check` runs in the reviewer's Tier 1 for the report, never as a gate: a repo's CI decides what's green, and nightshift doesn't add failing checks to a repo that didn't ask for them.

## Plugin layout

```
nightshift/
  .claude-plugin/
    plugin.json            name, version, description
    marketplace.json       so it installs from this repo
  skills/
    build-next-issue/SKILL.md
    review-prs/SKILL.md
    register/SKILL.md      walks you through register / unregister
  agents/
    plan-reviewer.md       Tier 2 (Opus) for the builder
    finding-judge.md       Tier 2 (Opus) for the reviewer
    code-reviewer.md       the generic Tier 1 compliance reviewer
  bin/
    preflight.mjs          Tier 0: reads GitHub, the registry and the repo's config
    lib/gates.mjs          Tier 0's rules as pure functions, unit-tested
    updates.mjs            the watcher's update questions; rules in lib/updates.mjs
    labels.mjs             creates the standard labels in a repo; rules in lib/labels.mjs
    tidy.mjs               deletes merged local branches and their clean worktrees; rules in lib/tidy.mjs
    lib/locks.mjs          the builder's and reviewer's lock files
    lib/config.mjs         the registry, the config and its defaults
    check.mjs              the baseline's script rules
    trigger.ps1            lock, refresh, gate, run or defer
    nightshift.ps1         register, unregister, enable, disable, status, trigger, watch, tidy
    run.ps1                the launcher, copied to the nightshift home
    lib/common.ps1         the scripts' shared helpers
    hooks/pre-push         the hook template register fills in
  schema/
    nightshift.schema.json the config's JSON Schema
  defaults/
    nightshift.json        the defaults above
```

Installed once with `claude plugin marketplace add ChrispyCode21/nightshift`, then `claude plugin install nightshift@nightshift`. Skills are namespaced (`/nightshift:build-next-issue`); scripts are found through the plugin's install path, so nothing is copied into each repo except its config.

## How updates reach a machine

A merge to `main` changes nothing on a machine by itself. Two things have to happen, and neither is automatic:

1. **The installed plugin.** Claude Code runs the cached copy in `~/.claude/plugins/cache/nightshift/<version>`, and `claude plugin update` installs only a new `version` from `plugin.json`. So a PR that changes `bin/`, `skills/`, `agents/` or `hooks/` must bump `version`; CI's "Plugin version bumped" step fails it otherwise. The owner then runs `claude plugin marketplace update nightshift` and `claude plugin update nightshift@nightshift`.
2. **The watcher task.** Its action (the `conhost.exe --headless` command line) is stored in Task Scheduler when `nightshift watch` runs. On each `tick` the watcher compares the installed version (from `installed_plugins.json`, as `run.ps1` reads it) with the version it last registered for, kept in `update-state.json` in the nightshift home. When they differ it registers itself again exactly as `nightshift watch` does and records the version; when they match it leaves the task alone.

The watcher only tells the owner about updates: nothing runs `claude plugin update` unasked, so the owner decides when new agent behavior starts (a buggy or test version never installs itself). Once a day, on a `tick`, it reads `version` from `plugin.json` on `main` through `gh`; when that is newer than the installed version it logs the line to `nightshift.log` and shows a Windows toast with the version and the two commands. The version compare and the once-a-day rule are `bin/lib/updates.mjs` (unit-tested), called through `bin/updates.mjs`. The check uses the nightshift token when one is set, which then needs read access to this repo's contents; if main can't be read it logs that and tries again tomorrow.

Possible later: Claude Code can auto-update third-party marketplaces (`"autoUpdate": true` in `extraKnownMarketplaces`, off by default). It isn't used: reports differ on whether it reinstalls plugin code, and it would install whatever merges to `main` unseen. If it's turned on, the re-register step above already handles the new version.

## Moving Logtelligent over

1. Build nightshift to the point where its builder and reviewer pass on a scratch repo.
2. In Logtelligent: add `.claude/nightshift.json` (above), the release issue text, and point `check-conventions.mjs`'s rules at the baseline's names so exceptions line up.
3. Register it, switch the two desktop scheduled tasks to the nightshift skills, and run each by hand once.
4. Remove `.claude/skills/build-next-issue/`, `.claude/skills/review-agent-prs/` and the scripts in `.github/agent/` from Logtelligent; PIPELINE.md shrinks to what's specific to it (labels, merge rules, the Actions history) and links here.

## To verify before building

- ✅ The plugin validates (`claude plugin validate .`) and installs from GitHub: `claude plugin marketplace add ChrispyCode21/nightshift` (add `#<branch>` to try a branch), then `claude plugin install nightshift@nightshift`. The private repo clones over SSH with your git credentials.
- ✅ `claude -p "/nightshift:ping"` runs the plugin skill headless from another repo, and the skill finds `bin/` through `${CLAUDE_PLUGIN_ROOT}`.
- ✅ A desktop scheduled task runs a plugin skill given as its prompt (`/nightshift:ping`), and the skill runs the plugin's scripts.

Found along the way: a local folder can't be a marketplace on an exFAT drive like `D:` (no file owners to check, the same reason git reports "dubious ownership" there), so development installs come from GitHub branches too.
