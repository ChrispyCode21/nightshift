// Tier 0's decisions, as pure functions over data preflight.mjs fetched from GitHub. No I/O here,
// so every rule is unit-tested (test/gates.test.mjs).

export function semver(title) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(title)
  return m && m.slice(1).map(Number)
}

const bySemver = (a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2]

// The milestone the builder works in: "semver", the lowest open vX.Y.Z; "any", the oldest open
// milestone; "none", no milestone (issues labeled `nightshift` instead).
export function pickMilestone(milestones, mode) {
  if (mode === 'none') return null
  if (mode === 'any') return [...milestones].sort((a, b) => a.number - b.number)[0] ?? null
  return (
    milestones
      .map((m) => ({ ...m, v: semver(m.title) }))
      .filter((m) => m.v)
      .sort(bySemver)[0] ?? null
  )
}

// Splits the open issues into what can be built now and what's waiting, and why. `openSubIssues`
// and `openBlockers` look an issue up (they cost an API call, so only issues that pass the cheap
// checks are looked up).
export function buildCandidates({
  issues,
  me,
  skipLabels,
  closing,
  branches,
  branchPrefix,
  openSubIssues,
  openBlockers,
}) {
  const skip = new Set(skipLabels)
  const waiting = []
  const candidates = []
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    if (issue.pull_request || issue.user.login !== me) continue
    const label = issue.labels.map((l) => l.name).find((l) => skip.has(l))
    const left = branches.find((b) => b.startsWith(`${branchPrefix}${issue.number}-`))
    if (label) waiting.push(`#${issue.number} ${label}`)
    else if (closing.has(issue.number)) waiting.push(`#${issue.number} has an open PR`)
    else if (left) waiting.push(`#${issue.number} left-over branch ${left}`)
    else if (openSubIssues(issue.number))
      continue // a parent waits for its sub-issues
    else {
      const blockers = openBlockers(issue.number)
      if (blockers.length)
        waiting.push(`#${issue.number} blocked by ${blockers.map((n) => `#${n}`).join(', ')}`)
      else candidates.push({ number: issue.number, title: issue.title })
    }
  }
  return { candidates, waiting }
}

// "Blocked by" counts until the blocker is closed as completed (not as "not planned").
export const isOpenBlocker = (b) => !(b.state === 'closed' && b.state_reason === 'completed')

// A PR the reviewer may touch: from this repo (a fork can copy any branch name), not a draft, and
// either on the builder's branches opened by the owner ("agent" in `authors`) or by a listed app.
export function isReviewable(pr, { me, branchPrefix, authors }) {
  if (pr.isDraft || pr.isCrossRepository) return false
  if (authors.includes('agent') && pr.headRefName.startsWith(branchPrefix) && pr.author.login === me)
    return true
  return authors.filter((a) => a !== 'agent').includes(pr.author.login)
}

// Due: never reviewed, or someone other than the owner committed since the `reviewed` label went on.
export function isDue({ labels, labeledAt, commits, me }) {
  if (!labels.includes('reviewed')) return true
  if (!labeledAt) return true
  return commits.some((c) => c.committedDate > labeledAt && !c.authors.some((a) => a.login === me))
}

// A Dependabot major bump changes the leading number in any "from X to Y".
export const isMajorBump = (text) =>
  [...text.matchAll(/from v?(\d+)\S* to v?(\d+)/g)].some((m) => m[1] !== m[2])

export function riskOf({ author, title, body, labels, paths }, highRisk) {
  const dependabot = author === 'app/dependabot'
  const major = dependabot && isMajorBump(`${title}\n${body}`)
  return {
    kind: dependabot ? (major ? 'dependabot-major' : 'dependabot') : 'agent',
    highRisk:
      major ||
      labels.some((l) => highRisk.labels.includes(l)) ||
      paths.some((p) => highRisk.paths.some((prefix) => p.startsWith(prefix))),
    touchesWorkflows: paths.some((p) => p.startsWith('.github/workflows/')),
  }
}
