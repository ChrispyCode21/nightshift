// The labels nightshift relies on (DESIGN.md, "Labels"). GitHub labels belong to one repository, so
// `nightshift.ps1 register` creates these in each repo it registers, through bin/labels.mjs.

// `color` is six hex digits without the `#`; GitHub caps a description at 100 characters.
export const STANDARD_LABELS = [
  {
    name: 'on-hold',
    color: 'fbca04',
    description: 'Paused: not under active development. The nightshift builder skips this.',
  },
  {
    name: 'agent-needs-info',
    color: 'd876e3',
    description: "Builder is waiting on the owner's answer",
  },
  {
    name: 'agent-followup',
    color: '0e8a16',
    description: 'Follow-up the reviewer found out of scope; the builder skips it until this is removed',
  },
  {
    name: 'standards',
    color: '5319e7',
    description: 'The rolling issue where the reviewer lists departures from the baseline',
  },
  {
    name: 'touches-data',
    color: 'b60205',
    description: "Changes stored data; the reviewer leaves it for the owner when the repo's config says so",
  },
  {
    name: 'touches-gates',
    color: 'b60205',
    description:
      "Changes a gate or check; the reviewer leaves it for the owner when the repo's config says so",
  },
  {
    name: 'reviewed',
    color: 'ededed',
    description: 'The nightshift reviewer has looked at this PR',
  },
  {
    name: 'nightshift',
    color: '1d76db',
    description: 'For the builder when the repo builds from labeled issues (milestones: none)',
  },
  {
    name: 'question',
    color: 'd876e3',
    description: 'A question for the owner; the nightshift builder skips this',
  },
]

// The standard labels whose names the repo doesn't have. GitHub compares label names without
// regard to case, so "On-Hold" counts as "on-hold".
export function missingLabels(existingNames, standard = STANDARD_LABELS) {
  const have = new Set(existingNames.map((n) => n.toLowerCase()))
  return standard.filter((l) => !have.has(l.name.toLowerCase()))
}

// Creates the missing standard labels in `repo` and never changes one that exists (no --force).
// `runGh(args)` runs gh and throws when it fails. Returns { created, existing, failed }, where
// failed is [{ name, error }]; it throws only when the repo's labels can't be listed.
export function ensureLabels(repo, runGh, standard = STANDARD_LABELS) {
  const listed = JSON.parse(runGh(['label', 'list', '-R', repo, '--limit', '1000', '--json', 'name']) || '[]')
  const missing = missingLabels(
    listed.map((l) => l.name),
    standard,
  )
  const created = []
  const failed = []
  for (const { name, color, description } of missing) {
    try {
      runGh(['label', 'create', name, '-R', repo, '--color', color, '--description', description])
      created.push(name)
    } catch (error) {
      failed.push({
        name,
        error: String(error.stderr || error.message)
          .trim()
          .split('\n')[0],
      })
    }
  }
  const existing = standard.filter((l) => !missing.includes(l)).map((l) => l.name)
  return { created, existing, failed }
}
