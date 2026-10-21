import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decideBranch,
  isClaudeWorktree,
  parseWorktrees,
  prCovers,
  summary,
  tidyDue,
} from '../bin/lib/tidy.mjs'

const branch = (extra = {}) =>
  decideBranch({
    name: 'feature',
    isDefault: false,
    remote: 'gone',
    inBase: false,
    prs: [],
    checkedOut: null,
    ...extra,
  })
const merged = (number, covers = true) => ({ number, state: 'MERGED', covers })
const worktree = (extra = {}) => ({
  path: 'D:/Projects/Repo-extra',
  main: false,
  claude: false,
  dirty: false,
  locked: false,
  recent: false,
  ...extra,
})

test('decideBranch: deletes a gone branch whose merged PR holds all its commits', () => {
  assert.deepEqual(branch({ prs: [merged(12)] }), { action: 'delete', reason: 'PR #12 merged' })
})

test('decideBranch: deletes a never-pushed branch whose tip is in origin/main', () => {
  assert.deepEqual(branch({ remote: 'none', inBase: true }), {
    action: 'delete',
    reason: 'already in origin/main',
  })
})

test('decideBranch: keeps a branch with commits beyond its merged PR', () => {
  assert.deepEqual(branch({ prs: [merged(12, false)] }), { action: 'keep', reason: 'commits beyond PR #12' })
})

test('decideBranch: keeps a branch with no PR and commits not in origin/main', () => {
  assert.equal(branch({ remote: 'none' }).action, 'keep')
  assert.equal(branch({ remote: 'none' }).reason, 'commits not in origin/main, no merged PR')
  // closed without merging counts as no PR
  assert.equal(branch({ prs: [{ number: 3, state: 'CLOSED', covers: false }] }).action, 'keep')
})

test('decideBranch: keeps everything that needs a PR check when GitHub could not be read', () => {
  assert.equal(branch({ prs: null }).action, 'keep')
  assert.match(branch({ prs: null }).reason, /couldn't read its PRs/)
  // a branch already in origin/main needs no PR
  assert.equal(branch({ prs: null, inBase: true }).action, 'delete')
})

test('decideBranch: keeps the default branch, a branch still on origin, and one with an open PR', () => {
  assert.equal(branch({ isDefault: true, remote: 'tracking', inBase: true }).reason, 'default branch')
  assert.equal(branch({ remote: 'tracking', prs: [merged(4)] }).reason, 'still on origin')
  // a branch name reused for a new PR after an old one merged
  assert.deepEqual(branch({ prs: [merged(4), { number: 9, state: 'OPEN', covers: false }] }), {
    action: 'keep',
    reason: 'open PR #9',
  })
})

test('decideBranch: keeps the main checkout branch and says to switch it to main', () => {
  const d = branch({ prs: [merged(12)], checkedOut: worktree({ main: true }) })
  assert.equal(d.action, 'keep')
  assert.equal(d.switchToMain, true)
  assert.match(d.reason, /switch this checkout to main/)
  // not when it has work to keep
  assert.equal(branch({ checkedOut: worktree({ main: true }) }).switchToMain, undefined)
})

test('decideBranch: never touches a branch in a Claude session worktree', () => {
  const d = branch({ inBase: true, prs: [merged(12)], checkedOut: worktree({ claude: true }) })
  assert.deepEqual(d, { action: 'keep', reason: 'in a Claude session worktree' })
})

test('decideBranch: removes a clean, idle worktree with its branch; keeps one in use', () => {
  assert.deepEqual(branch({ prs: [merged(12)], checkedOut: worktree() }), {
    action: 'delete',
    reason: 'PR #12 merged',
    worktree: 'D:/Projects/Repo-extra',
  })
  assert.match(branch({ prs: [merged(12)], checkedOut: worktree({ dirty: true }) }).reason, /has changes/)
  assert.match(branch({ prs: [merged(12)], checkedOut: worktree({ locked: true }) }).reason, /locked/)
  assert.match(branch({ prs: [merged(12)], checkedOut: worktree({ recent: true }) }).reason, /last day/)
})

test('prCovers: every commit outside main is the PR’s, or the trees match', () => {
  assert.equal(prCovers({ branchCommits: ['a', 'b'], prCommits: ['a', 'b', 'c'] }), true)
  assert.equal(prCovers({ branchCommits: [], prCommits: [] }), true)
  assert.equal(prCovers({ branchCommits: ['a', 'x'], prCommits: ['a', 'b'] }), false)
  assert.equal(prCovers({ branchCommits: ['x'], prCommits: ['a'], branchTree: 't1', prTree: 't1' }), true)
  assert.equal(prCovers({ branchCommits: ['x'], prCommits: ['a'], branchTree: 't1', prTree: 't2' }), false)
  assert.equal(prCovers({ branchCommits: ['x'], prCommits: ['a'], branchTree: '', prTree: '' }), false)
})

test('parseWorktrees: the main checkout, a branch, a detached head, locked and prunable', () => {
  const text = [
    'worktree D:/Projects/Repo\nHEAD aaa\nbranch refs/heads/main\n',
    'worktree D:/Projects/Repo/.claude/worktrees/x\nHEAD bbb\nbranch refs/heads/claude/x\nlocked\n',
    'worktree D:/Projects/Repo-reviewer\nHEAD ccc\ndetached\n',
    'worktree D:/gone\nHEAD ddd\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n',
  ].join('\n')
  const trees = parseWorktrees(text)
  assert.deepEqual(
    trees.map((t) => [t.path, t.branch, t.detached, t.locked, t.prunable]),
    [
      ['D:/Projects/Repo', 'main', false, false, false],
      ['D:/Projects/Repo/.claude/worktrees/x', 'claude/x', false, true, false],
      ['D:/Projects/Repo-reviewer', null, true, false, false],
      ['D:/gone', 'old', false, false, true],
    ],
  )
})

test('isClaudeWorktree: under the checkout’s .claude/worktrees, in either slash and case', () => {
  assert.equal(isClaudeWorktree('D:\\Projects\\Repo', 'D:/projects/repo/.claude/worktrees/x'), true)
  assert.equal(isClaudeWorktree('D:/Projects/Repo', 'D:/Projects/Repo-reviewer'), false)
  assert.equal(isClaudeWorktree('D:/Projects/Repo', 'D:/Projects/Repo/.claude/other'), false)
})

test('summary: counts, and what was kept grouped by why', () => {
  assert.equal(summary({ deleted: 0, worktrees: 0, kept: [] }), 'tidied 0 branches, 0 worktrees; kept 0')
  assert.equal(
    summary({
      deleted: 1,
      worktrees: 1,
      kept: [
        { name: 'a', reason: 'still on origin' },
        { name: 'b', reason: 'still on origin' },
        { name: 'c', reason: 'open PR #3' },
      ],
      dryRun: true,
    }),
    'would tidy 1 branch, 1 worktree; kept 3 (still on origin: a, b; open PR #3: c)',
  )
})

test('tidyDue: from 9 PM local, once until 9 PM the next day', () => {
  const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute)
  assert.equal(tidyDue(at(21, 20, 59), null), false)
  assert.equal(tidyDue(at(21, 21, 5), null), true)
  assert.equal(tidyDue(at(21, 21, 35), at(21, 21, 5)), false)
  assert.equal(tidyDue(at(22, 1, 0), at(21, 21, 5)), false) // after midnight, not yet 9 PM
  assert.equal(tidyDue(at(22, 21, 5), at(21, 21, 5)), true)
  assert.equal(tidyDue(at(22, 23, 0), at(20, 21, 5)), true) // missed a day
})
