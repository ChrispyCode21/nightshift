// `nightshift tidy` (DESIGN.md, "Tidying checkouts"): deletes the owner's local branches whose work
// is already on origin's default branch, and the clean worktrees they're checked out in. The rules
// are in lib/tidy.mjs; this file reads git and GitHub and acts on them.
//
//   node tidy.mjs <checkout> [--dry-run]     one checkout, registered or not
//   node tidy.mjs --all [--dry-run]          every enabled registered repo: its checkout and builder clone
//   node tidy.mjs --all --daily              the watcher's pass: --all once a day, from 9 PM local
//
// Prints what it did (or, with --dry-run, would do) and logs one line per checkout to
// nightshift.log; a dry run logs nothing and changes nothing but origin's remote-tracking refs.
// A registered repo uses the nightshift GitHub token and is skipped while a builder or reviewer run
// holds its lock; an unregistered checkout uses the owner's own gh login.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { home, loadRegistry } from './lib/config.mjs'
import { githubEnv } from './lib/github.mjs'
import { lockHolder, lockPath } from './lib/locks.mjs'
import {
  decideBranch,
  isClaudeWorktree,
  parseWorktrees,
  prCovers,
  RECENT_HOURS,
  summary,
  tidyDue,
} from './lib/tidy.mjs'

// Git reports "dubious ownership" for checkouts on drives that don't record owners (exFAT).
const env = {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: '*',
}
// The most commits a branch may have outside origin/main and still be compared with its PR's.
const MAX_BRANCH_COMMITS = 250

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const all = args.includes('--all')
const daily = args.includes('--daily')
const target = args.find((a) => !a.startsWith('--'))

const exec = (cmd, cmdArgs, opts) =>
  execFileSync(cmd, cmdArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 << 20,
    ...opts,
  })
const tryOr = (fallback, fn) => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

// The same line format as Write-NsLog in common.ps1 (local time, no zone).
function log(message) {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  appendFileSync(join(home(), 'logs', 'nightshift.log'), `${stamp} ${message}\r\n`)
}

const githubOf = (url) => /github\.com[:/](.+?)(\.git)?$/.exec(url)?.[1] ?? null

function tidyCheckout(checkout, ghEnv) {
  const git = (gitArgs, cwd = checkout) => exec('git', gitArgs, { cwd, env }).trim()
  const gh = (ghArgs) => exec('gh', ghArgs, { env: ghEnv }).trim()
  const out = []
  const say = (line) => out.push(line)

  git(['fetch', '--prune', 'origin'])
  const base = tryOr('origin/main', () => git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))
  const defaultBranch = base.replace(/^origin\//, '')
  const github = githubOf(tryOr('', () => git(['remote', 'get-url', 'origin'])))

  // Worktrees whose folder is gone don't hold their branch: `git worktree prune` drops them.
  const trees = parseWorktrees(git(['worktree', 'list', '--porcelain']))
  const mainPath = trees[0]?.path ?? checkout
  const holder = new Map(trees.filter((t) => t.branch && !t.prunable).map((t) => [t.branch, t]))

  // One call for all of the repo's PRs; null when GitHub can't be read, so no PR-based deletes.
  // A remote that isn't on GitHub has no PRs.
  let prsByHead = github ? null : new Map()
  if (github) {
    const list = tryOr(null, () =>
      JSON.parse(
        gh([
          'pr',
          'list',
          '-R',
          github,
          '--state',
          'all',
          '--limit',
          '1000',
          '--json',
          'number,state,headRefName,headRefOid,isCrossRepository',
        ]),
      ),
    )
    if (list) {
      prsByHead = new Map()
      for (const pr of list.filter((p) => !p.isCrossRepository))
        prsByHead.set(pr.headRefName, [...(prsByHead.get(pr.headRefName) ?? []), pr])
    } else say(`  couldn't read ${github}'s PRs; only branches already in ${base} can go`)
  }

  const refs = git([
    'for-each-ref',
    'refs/heads',
    '--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(objectname)',
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\0'))
  const remoteHas = (name) =>
    tryOr(false, () => (git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]), true))

  const decisions = []
  for (const [name, upstream, track, sha] of refs) {
    const remote = upstream
      ? track.includes('gone')
        ? 'gone'
        : 'tracking'
      : remoteHas(name)
        ? 'tracking'
        : 'none'
    const headName = upstream ? upstream.replace(/^origin\//, '') : name
    const inBase = tryOr(false, () => (git(['merge-base', '--is-ancestor', sha, base]), true))
    const tree = holder.get(name)
    let checkedOut = null
    if (tree) {
      const claude = isClaudeWorktree(mainPath, tree.path)
      const isMain = tree.path === mainPath
      checkedOut = { path: tree.path, main: isMain, claude, locked: tree.locked }
      if (!claude && !isMain) {
        // Before `status`, which can rewrite the index; --no-optional-locks keeps it from doing so.
        checkedOut.recent = recentlyUsed(git, tree.path)
        checkedOut.dirty = tryOr(
          true,
          () => git(['--no-optional-locks', 'status', '--porcelain'], tree.path) !== '',
        )
      }
    }
    // A merged PR's commits are only fetched for branches that need them.
    const needsCover = remote !== 'tracking' && name !== defaultBranch && !checkedOut?.claude
    const prs = prsByHead
      ? (prsByHead.get(headName) ?? []).map((pr) => ({
          number: pr.number,
          state: pr.state,
          covers: needsCover && pr.state === 'MERGED' && covered({ git, gh, github, sha, base, pr }),
        }))
      : null
    decisions.push({
      name,
      ...decideBranch({ name, isDefault: name === defaultBranch, remote, inBase, prs, checkedOut }),
    })
  }

  let deleted = 0
  let removedTrees = 0
  const kept = []
  if (!dryRun) git(['worktree', 'prune'])
  for (const d of decisions) {
    if (d.reason === 'default branch') continue
    if (d.action === 'keep') {
      kept.push(d)
      continue
    }
    const where = d.worktree ? ` and its worktree ${d.worktree}` : ''
    if (dryRun) {
      say(`  would delete ${d.name}${where} (${d.reason})`)
      deleted++
      if (d.worktree) removedTrees++
      continue
    }
    try {
      if (d.worktree) {
        git(['worktree', 'remove', d.worktree]) // never --force
        removedTrees++
      }
      git(['branch', '-D', d.name])
      deleted++
      say(`  deleted ${d.name}${where} (${d.reason})`)
    } catch (error) {
      const why = String(error.stderr || error.message)
        .trim()
        .split('\n')[0]
      kept.push({ name: d.name, reason: `couldn't delete: ${why}` })
    }
  }
  for (const k of kept) say(`  kept ${k.name}: ${k.reason}`)
  return { lines: out, line: summary({ deleted, worktrees: removedTrees, kept, dryRun }) }
}

// File activity in a worktree: its index, HEAD and HEAD's reflog in its git dir change with every
// commit, checkout, add or reset there. (A clean worktree's own files match HEAD, so edits show as
// changes in `git status` instead.)
function recentlyUsed(git, path) {
  return tryOr(true, () => {
    const gitDir = git(['rev-parse', '--absolute-git-dir'], path)
    const newest = Math.max(
      ...['index', 'HEAD', join('logs', 'HEAD')].map((f) =>
        tryOr(0, () => statSync(join(gitDir, f)).mtimeMs),
      ),
    )
    return Date.now() - newest < RECENT_HOURS * 3_600_000
  })
}

// Whether merged PR `pr` holds everything on the branch at `sha` (lib/tidy.mjs, prCovers).
function covered({ git, gh, github, sha, base, pr }) {
  return tryOr(false, () => {
    const branchCommits = git(['rev-list', `--max-count=${MAX_BRANCH_COMMITS + 1}`, sha, '--not', base])
      .split('\n')
      .filter(Boolean)
    if (branchCommits.length > MAX_BRANCH_COMMITS) return false
    const prCommits = JSON.parse(
      gh(['pr', 'view', String(pr.number), '-R', github, '--json', 'commits']),
    ).commits.map((c) => c.oid)
    if (prCovers({ branchCommits, prCommits })) return true
    const prTree = gh(['api', `repos/${github}/commits/${pr.headRefOid}`, '--jq', '.commit.tree.sha'])
    return prCovers({ branchCommits, prCommits, branchTree: git(['rev-parse', `${sha}^{tree}`]), prTree })
  })
}

// The registered repo a path belongs to, as its checkout or its builder clone.
const same = (a, b) => Boolean(a && b) && resolve(a).toLowerCase() === resolve(b).toLowerCase()

function run(checkout, entry) {
  const label = entry ? `[${entry.name} tidy]` : '[tidy]'
  const heldBy = entry
    ? ['build', 'review'].map((agent) => lockHolder(lockPath(entry.name, agent)) && agent).filter(Boolean)
    : []
  if (heldBy.length) {
    const why = `a ${heldBy.join(' and ')} run holds the lock`
    if (!dryRun) {
      console.log(`${checkout}: skipped; ${why}`)
      log(`${label} ${checkout}: skipped; ${why}`)
      return
    }
    console.log(`${checkout}: ${why}, so a real run would skip it today. What it would do otherwise:`)
  }
  try {
    const ghEnv = entry ? githubEnv(env) : env
    const { lines, line } = tidyCheckout(checkout, ghEnv)
    console.log(`${checkout}: ${line}`)
    for (const l of lines) console.log(l)
    if (!dryRun) log(`${label} ${checkout}: ${line}`)
  } catch (error) {
    const why = String(error.stderr || error.message)
      .trim()
      .split('\n')[0]
    console.log(`${checkout}: failed: ${why}`)
    if (!dryRun) log(`${label} ${checkout}: failed: ${why}`)
    process.exitCode = 1
  }
}

const repos = loadRegistry().repos.filter((r) => r.enabled !== false)
if (all) {
  for (const entry of repos) {
    const marker = join(home(), 'last-run', `${entry.name}-tidy`)
    if (daily) {
      const last = tryOr(null, () => statSync(marker).mtime)
      if (!tidyDue(new Date(), last)) continue
    }
    for (const path of [entry.checkout, entry.builder].filter(Boolean)) run(path, entry)
    if (daily && !dryRun) {
      mkdirSync(join(home(), 'last-run'), { recursive: true })
      writeFileSync(marker, '')
    }
  }
} else if (target) {
  const checkout = isAbsolute(target) ? target : resolve(target)
  run(
    checkout,
    loadRegistry().repos.find((r) => same(r.checkout, checkout) || same(r.builder, checkout)),
  )
} else {
  console.error('Usage: tidy.mjs <checkout> [--dry-run] | --all [--dry-run] [--daily]')
  process.exit(2)
}
