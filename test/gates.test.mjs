import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildCandidates,
  isDue,
  isMajorBump,
  isOpenBlocker,
  isPeak,
  isReviewable,
  pickMilestone,
  riskOf,
} from '../bin/lib/gates.mjs'

test('pickMilestone: semver takes the lowest version and ignores other titles', () => {
  const ms = [
    { number: 1, title: 'Agent pipeline' },
    { number: 4, title: 'v1.10.0' },
    { number: 3, title: 'v1.9.2' },
  ]
  assert.equal(pickMilestone(ms, 'semver').title, 'v1.9.2')
  assert.equal(pickMilestone([{ number: 1, title: 'Backlog' }], 'semver'), null)
})

test('pickMilestone: any takes the oldest; none takes nothing', () => {
  const ms = [
    { number: 7, title: 'Later' },
    { number: 2, title: 'Now' },
  ]
  assert.equal(pickMilestone(ms, 'any').title, 'Now')
  assert.equal(pickMilestone(ms, 'none'), null)
})

const issue = (number, extra = {}) => ({
  number,
  title: `#${number}`,
  user: { login: 'owner' },
  labels: [],
  ...extra,
})
const gate = (issues, extra = {}) =>
  buildCandidates({
    issues,
    me: 'owner',
    skipLabels: ['agent-needs-info'],
    closing: new Set(),
    branches: [],
    branchPrefix: 'agent/issue-',
    openSubIssues: () => false,
    openBlockers: () => [],
    ...extra,
  })

test("buildCandidates: only the owner's issues, oldest first", () => {
  const { candidates } = gate([issue(9), issue(3), issue(5, { user: { login: 'stranger' } })])
  assert.deepEqual(
    candidates.map((c) => c.number),
    [3, 9],
  )
})

test('buildCandidates: labels, open PRs, left-over branches and blockers wait, with reasons', () => {
  const { candidates, waiting } = gate(
    [issue(1, { labels: [{ name: 'agent-needs-info' }] }), issue(2), issue(3), issue(4), issue(5)],
    {
      closing: new Set([2]),
      branches: ['agent/issue-3-old-try'],
      openBlockers: (n) => (n === 4 ? [1] : []),
    },
  )
  assert.deepEqual(
    candidates.map((c) => c.number),
    [5],
  )
  assert.deepEqual(waiting, [
    '#1 agent-needs-info',
    '#2 has an open PR',
    '#3 left-over branch agent/issue-3-old-try',
    '#4 blocked by #1',
  ])
})

test('buildCandidates: a parent with open sub-issues is skipped silently', () => {
  const { candidates, waiting } = gate([issue(1), issue(2)], { openSubIssues: (n) => n === 1 })
  assert.deepEqual(
    candidates.map((c) => c.number),
    [2],
  )
  assert.deepEqual(waiting, [])
})

test('isOpenBlocker: only "closed as completed" unblocks', () => {
  assert.equal(isOpenBlocker({ state: 'closed', state_reason: 'completed' }), false)
  assert.equal(isOpenBlocker({ state: 'closed', state_reason: 'not_planned' }), true)
  assert.equal(isOpenBlocker({ state: 'open' }), true)
})

const pr = (extra = {}) => ({
  isDraft: false,
  isCrossRepository: false,
  headRefName: 'agent/issue-5-x',
  author: { login: 'owner' },
  ...extra,
})
const who = { me: 'owner', branchPrefix: 'agent/issue-', authors: ['agent', 'app/dependabot'] }

test("isReviewable: the builder's branch, opened by the owner, from this repo", () => {
  assert.equal(isReviewable(pr(), who), true)
})

test("isReviewable: a fork's PR never counts, whatever its branch is named", () => {
  assert.equal(isReviewable(pr({ isCrossRepository: true }), who), false)
  assert.equal(isReviewable(pr({ isCrossRepository: true, author: { login: 'app/dependabot' } }), who), false)
})

test("isReviewable: someone else's PR on a builder-like branch doesn't count", () => {
  assert.equal(isReviewable(pr({ author: { login: 'collaborator' } }), who), false)
})

test("isReviewable: listed apps count; drafts and the owner's other PRs don't", () => {
  assert.equal(
    isReviewable(pr({ headRefName: 'dependabot/npm/x', author: { login: 'app/dependabot' } }), who),
    true,
  )
  assert.equal(isReviewable(pr({ isDraft: true }), who), false)
  assert.equal(isReviewable(pr({ headRefName: 'claude/feature' }), who), false)
})

test('isDue: unreviewed is due; after review, only commits by someone else make it due', () => {
  const base = { labels: ['reviewed'], labeledAt: '2026-10-19T10:00:00Z', me: 'owner' }
  assert.equal(isDue({ ...base, labels: [], commits: [] }), true)
  const owners = [{ committedDate: '2026-10-19T11:00:00Z', authors: [{ login: 'owner' }] }]
  assert.equal(isDue({ ...base, commits: owners }), false)
  const bots = [{ committedDate: '2026-10-19T11:00:00Z', authors: [{ login: 'dependabot[bot]' }] }]
  assert.equal(isDue({ ...base, commits: bots }), true)
  const older = [{ committedDate: '2026-10-19T09:00:00Z', authors: [{ login: 'dependabot[bot]' }] }]
  assert.equal(isDue({ ...base, commits: older }), false)
})

test('isMajorBump: the leading number changes', () => {
  assert.equal(isMajorBump('Bump vite from 7.1.2 to 8.0.0'), true)
  assert.equal(isMajorBump('Bump vite from 7.1.2 to 7.2.0'), false)
  assert.equal(isMajorBump('Bump actions/checkout from v6 to v7'), true)
})

test('riskOf: high risk from paths, labels or a major bump', () => {
  const highRisk = { paths: ['src/engine/'], labels: ['touches-data'] }
  const base = { author: 'owner', title: 't', body: '', labels: [], paths: ['src/ui/a.tsx'] }
  assert.equal(riskOf(base, highRisk).highRisk, false)
  assert.equal(riskOf({ ...base, paths: ['src/engine/x.ts'] }, highRisk).highRisk, true)
  assert.equal(riskOf({ ...base, labels: ['touches-data'] }, highRisk).highRisk, true)
  const major = riskOf({ ...base, author: 'app/dependabot', title: 'Bump x from 1.0.0 to 2.0.0' }, highRisk)
  assert.deepEqual(major, { kind: 'dependabot-major', highRisk: true, touchesWorkflows: false })
})

test('isPeak: 5–11 AM Pacific, across daylight saving', () => {
  assert.equal(isPeak(new Date('2026-10-19T12:00:00Z')), true) // 5:00 AM PDT
  assert.equal(isPeak(new Date('2026-10-19T17:59:00Z')), true) // 10:59 AM PDT
  assert.equal(isPeak(new Date('2026-10-19T18:00:00Z')), false) // 11:00 AM PDT
  assert.equal(isPeak(new Date('2026-12-01T12:00:00Z')), false) // 4:00 AM PST
  assert.equal(isPeak(new Date('2026-12-01T13:00:00Z')), true) // 5:00 AM PST
})
