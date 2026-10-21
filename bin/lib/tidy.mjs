// `nightshift tidy`'s decisions (DESIGN.md, "Tidying checkouts"), as pure functions over what
// bin/tidy.mjs read from git and GitHub. No I/O here, so every rule is unit-tested
// (test/tidy.test.mjs).

// Worktrees the Claude desktop app made for its sessions. The app removes them when it archives a
// session; removing one ourselves breaks the session if it's resumed.
export const CLAUDE_WORKTREES = '.claude/worktrees/'

// A worktree with file activity this recent is in use, even when it's clean.
export const RECENT_HOURS = 24

const slash = (path) => path.replace(/\\/g, '/').replace(/\/+$/, '')

export const isClaudeWorktree = (checkout, path) =>
  slash(path)
    .toLowerCase()
    .startsWith(`${slash(checkout).toLowerCase()}/${CLAUDE_WORKTREES}`)

// `git worktree list --porcelain`: the main checkout first, then each worktree.
export function parseWorktrees(text) {
  const list = []
  for (const block of text.replace(/\r/g, '').split('\n\n')) {
    const lines = block.split('\n').filter(Boolean)
    if (!lines[0]?.startsWith('worktree ')) continue
    const tree = {
      path: lines[0].slice('worktree '.length),
      branch: null,
      detached: false,
      locked: false,
      prunable: false,
    }
    for (const line of lines.slice(1)) {
      if (line.startsWith('branch refs/heads/')) tree.branch = line.slice('branch refs/heads/'.length)
      else if (line === 'detached') tree.detached = true
      else if (line === 'locked' || line.startsWith('locked ')) tree.locked = true
      else if (line === 'prunable' || line.startsWith('prunable ')) tree.prunable = true
    }
    list.push(tree)
  }
  return list
}

// Whether a merged PR holds everything on the branch: each of the branch's commits that isn't in
// origin/main is one of the PR's commits, or the branch's tree is the PR head's tree (a branch
// rebased after it was pushed).
export const prCovers = ({ branchCommits, prCommits, branchTree, prTree }) =>
  branchCommits.every((sha) => prCommits.includes(sha)) || (Boolean(branchTree) && branchTree === prTree)

// Delete or keep one local branch. `facts`:
//   name, isDefault            the branch, and whether it's origin's default branch
//   remote                     'tracking' (on origin), 'gone' (upstream deleted) or 'none' (never pushed)
//   inBase                     its tip is in origin/main
//   prs                        PRs from this branch name, [{ number, state, covers }], or null when
//                              GitHub couldn't be read; `covers` (prCovers) only matters for merged ones
//   checkedOut                 null, or where it's checked out: { path, main, claude, dirty, locked, recent }
// Returns { action: 'delete' | 'keep', reason, worktree?, switchToMain? }. A 'delete' with `worktree`
// removes that worktree first.
export function decideBranch({ name, isDefault, remote, inBase, prs, checkedOut }) {
  const keep = (reason, extra = {}) => ({ action: 'keep', reason, ...extra })
  if (isDefault) return keep('default branch')
  if (remote === 'tracking') return keep('still on origin')
  if (checkedOut?.claude) return keep('in a Claude session worktree')
  const open = prs?.find((p) => p.state === 'OPEN')
  if (open) return keep(`open PR #${open.number}`)

  const merged = (prs ?? []).filter((p) => p.state === 'MERGED')
  const covering = merged.find((p) => p.covers)
  let reason
  if (covering) reason = `PR #${covering.number} merged`
  else if (inBase) reason = 'already in origin/main'
  else if (merged.length) return keep(`commits beyond PR #${merged[0].number}`)
  else if (prs === null) return keep("commits not in origin/main; couldn't read its PRs")
  else return keep('commits not in origin/main, no merged PR')

  if (checkedOut?.main)
    return keep(`${reason}, but it's checked out here: switch this checkout to main`, { switchToMain: true })
  if (checkedOut) {
    if (checkedOut.dirty) return keep(`${reason}, but its worktree has changes`)
    if (checkedOut.locked) return keep(`${reason}, but its worktree is locked`)
    if (checkedOut.recent) return keep(`${reason}, but its worktree was used in the last day`)
    return { action: 'delete', reason, worktree: checkedOut.path }
  }
  return { action: 'delete', reason }
}

// The log line for one checkout: "tidied N branches, M worktrees; kept K (why)". `kept` leaves out
// the default branch.
export function summary({ deleted, worktrees, kept, dryRun = false }) {
  const verb = dryRun ? 'would tidy' : 'tidied'
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`
  let line = `${verb} ${count(deleted, 'branch', 'branches')}, ${count(worktrees, 'worktree', 'worktrees')}; kept ${kept.length}`
  if (kept.length) {
    const byReason = new Map()
    for (const { name, reason } of kept) byReason.set(reason, [...(byReason.get(reason) ?? []), name])
    line += ` (${[...byReason].map(([reason, names]) => `${reason}: ${names.join(', ')}`).join('; ')})`
  }
  return line
}

// The watcher tidies from 9 PM local, once a day, so it never pulls a branch out from under a
// daytime session; the nightly builder starts at 2 AM.
export const TIDY_HOUR = 21

// Whether the watcher's daily tidy is due: it's past 9 PM and it hasn't run since 9 PM today.
// `last` is when it last ran (a Date), or null.
export function tidyDue(now, last) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), TIDY_HOUR)
  if (now < start) return false
  return !last || last < start
}
