# nightshift design

nightshift runs two agents on any repo you opt in: a **builder** that turns a milestone's issues into PRs (or asks numbered questions on them), and a **reviewer** that reviews, fixes and merges those PRs (or holds them for you). It's the agent pipeline from Logtelligent (`.github/agent/PIPELINE.md` there), with Logtelligent's assumptions pulled out into a per-repo config file.

## Goals

- **Any repo, opt-in only.** Agents run only where the repo has a config file *and* you registered its checkout on this machine.
- **Your plan, not API credit.** Desktop scheduled tasks and `claude -p` on your login. No GitHub Actions, no API keys.
- **Off-peak.** Nightly runs, and triggered runs deferred past Anthropic's peak hours (5–11 AM Pacific).
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

**Schedule.** Two desktop scheduled tasks: builder at 2:00 AM, reviewer at 4:00 AM Central. Each loops over the registry, one repo at a time, at most one build per repo per night. Before starting each repo it checks the clock, and a repo it reaches during peak hours waits for the deferred run.

**Triggers.** One watcher (a Windows scheduled task, every 30 minutes) runs Tier 0 for every registered repo; a pre-push hook in each registered checkout starts the reviewer when you push to an agent or Dependabot branch; `nightshift trigger <repo> build|review` by hand. All go through `trigger.ps1`: lock check, refresh, Tier 0, then run headless or defer past peak.

## Opting a repo in

Two keys, both required:

1. **`.claude/nightshift.json` in the repo**, committed. Says *how* the agents work there. Reviewed like any code.
2. **A registry entry on this machine** (`%USERPROFILE%\.nightshift\repos.json`). Says *that* they run there, and where.

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

`nightshift register <checkout>` reads the repo's config (refusing if there's none), creates the builder's clone and the reviewer's worktree, installs the pre-push hook, and adds the entry. `unregister` removes the hook and the entry and leaves the checkouts. `enabled: false` pauses a repo without touching its code.

A clone or fork that already has the config file runs nothing until it's registered.

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

A draft; yours to edit before it's built.

| Rule | Checked by |
|---|---|
| `no-inline-components`: components are defined at module level, never inside another component's body | script (AST) |
| `no-inline-styles`: no `style={{…}}` or `style="…"` for anything a class or token can express | script |
| `tokens-only`: colors, spacing, radii, font sizes and shadows come from design tokens, not raw values | script, given the repo's token file |
| `use-primitives`: where the repo has a shared component (button, field, card), raw elements with the same role aren't used | script, given the repo's primitives |
| `one-formatter`: dates, numbers and units are formatted through shared helpers | review |
| `pure-core`: domain logic has no UI, storage or I/O imports | review, plus a lint rule where the repo has one |
| `tests-with-logic`: new logic arrives with unit tests | review |

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
    preflight.mjs          Tier 0, reads the registry and config
    check.mjs              the baseline's script rules
    trigger.ps1            lock, refresh, gate, run or defer
    nightshift.ps1         register, unregister, trigger, status
    hooks/pre-push
  schema/
    nightshift.schema.json the config's JSON Schema
  defaults/
    nightshift.json        the defaults above
```

Installed once with `/plugin marketplace add ChrispyCode21/nightshift`, then `/plugin install nightshift`. Skills are namespaced (`/nightshift:build-next-issue`); scripts are found through the plugin's install path, so nothing is copied into each repo except its config.

## Moving Logtelligent over

1. Build nightshift to the point where its builder and reviewer pass on a scratch repo.
2. In Logtelligent: add `.claude/nightshift.json` (above), the release issue text, and point `check-conventions.mjs`'s rules at the baseline's names so exceptions line up.
3. Register it, switch the two desktop scheduled tasks to the nightshift skills, and run each by hand once.
4. Remove `.claude/skills/build-next-issue/`, `.claude/skills/review-agent-prs/` and the scripts in `.github/agent/` from Logtelligent; PIPELINE.md shrinks to what's specific to it (labels, merge rules, the Actions history) and links here.

## To verify before building

- A desktop scheduled task can run a plugin skill (`/nightshift:build-next-issue`) as its prompt, in a session whose folder is the repo.
- A plugin's `bin/` scripts can be located from a skill (the plugin root path) on Windows.
- `claude -p` loads installed plugins in headless runs.
