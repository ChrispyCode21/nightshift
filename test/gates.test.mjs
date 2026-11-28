import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaults } from '../bin/lib/config.mjs'
import {
  buildCandidates,
  isDue,
  isMajorBump,
  isOpenBlocker,
  isReviewable,
  nextMilestone,
  overUsage,
  pickMilestone,
  probeError,
  riskOf,
  usageFromStream,
  whyNotReviewed,
  withFollowUps,
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

test('nextMilestone: the one after the milestone being built, in the same order', () => {
  const versions = [
    { number: 1, title: 'Backlog' },
    { number: 4, title: 'v1.10.0' },
    { number: 3, title: 'v1.9.2' },
  ]
  assert.equal(nextMilestone(versions, 'semver').title, 'v1.10.0')
  const any = [
    { number: 7, title: 'Later' },
    { number: 2, title: 'Now' },
  ]
  assert.equal(nextMilestone(any, 'any').title, 'Later')
})

test('nextMilestone: nothing when there is no later milestone, or none are used', () => {
  const one = [
    { number: 1, title: 'Backlog' },
    { number: 2, title: 'v1.0.0' },
  ]
  assert.equal(nextMilestone(one, 'semver'), null)
  assert.equal(nextMilestone([], 'any'), null)
  assert.equal(nextMilestone(one, 'none'), null)
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

test('buildCandidates: an issue labeled on-hold waits under the default skip labels', () => {
  const { candidates, waiting } = gate([issue(1, { labels: [{ name: 'on-hold' }] }), issue(2)], {
    skipLabels: defaults().builder.skipLabels,
  })
  assert.deepEqual(
    candidates.map((c) => c.number),
    [2],
  )
  assert.deepEqual(waiting, ['#1 on-hold'])
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

const rateLimitLine = (status, fiveHour, sevenDay) =>
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      unifiedWindows: {
        five_hour: { utilization: fiveHour, resetsAt: 1792517400 },
        seven_day: { utilization: sevenDay, resetsAt: 1792573200 },
      },
    },
  })

test('usageFromStream: takes the last rate_limit_event and skips other lines', () => {
  const text = [
    '{"type":"system","subtype":"init"}',
    rateLimitLine('allowed', 0.4, 0.5),
    'not json',
    rateLimitLine('allowed_warning', 0.5, 0.87),
    '{"type":"result"}',
  ].join('\n')
  const usage = usageFromStream(text)
  assert.equal(usage.five_hour.utilization, 0.5)
  assert.equal(usage.seven_day.utilization, 0.87)
  assert.equal(usage.rejected, false)
  assert.equal(usageFromStream('{"type":"result"}'), null)
  assert.equal(usageFromStream(rateLimitLine('rejected', 1, 0.9)).rejected, true)
})

test('overUsage: a window at or past its limit counts; one below does not', () => {
  const windows = (fiveHour, sevenDay) => usageFromStream(rateLimitLine('allowed', fiveHour, sevenDay))
  assert.deepEqual(overUsage(windows(0.5, 0.87)), [])
  assert.deepEqual(overUsage(windows(0.85, 0.2)).length, 1)
  assert.match(overUsage(windows(0.85, 0.2))[0], /^five_hour 85% \(resets /)
  assert.match(overUsage(windows(0.1, 0.9))[0], /^seven_day 90%/)
  assert.equal(overUsage(windows(0.9, 0.95)).length, 2)
  assert.deepEqual(overUsage({ rejected: false }), []) // a window missing from the event
})

test('whyNotReviewed: drafts, forks, and PRs no listed author opened', () => {
  const pr = (extra) => ({
    number: 7,
    headRefName: 'feature-x',
    isDraft: false,
    isCrossRepository: false,
    ...extra,
  })
  assert.equal(whyNotReviewed(pr({ isDraft: true })), '#7 is a draft')
  assert.equal(whyNotReviewed(pr({ isCrossRepository: true })), '#7 is from a fork')
  assert.equal(
    whyNotReviewed(pr()),
    "#7 (feature-x) is not an agent or Dependabot PR, so nightshift won't review it",
  )
})

test('probeError: the result line Claude Code prints on stdout when it cannot run', () => {
  // As Claude Code 2.1 prints it when not logged in: exit 1, nothing on stderr.
  const notLoggedIn = [
    '{"type":"system","subtype":"init","model":"claude-haiku-5-5"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed"}',
    '{"duration_api_ms":0,"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}',
  ].join('\n')
  assert.equal(
    probeError({ stdout: notLoggedIn, stderr: '', status: 1 }),
    'Not logged in · Please run /login',
  )
  // no result line: the assistant message's error
  const [, assistant] = notLoggedIn.split('\n')
  assert.equal(probeError({ stdout: assistant }), 'authentication_failed: Not logged in · Please run /login')
  const apiError =
    '{"type":"result","subtype":"error_during_execution","is_error":true,"api_error_status":529}'
  assert.equal(probeError({ stdout: apiError }), 'error_during_execution (API 529)')
  // a successful result isn't an error; stderr's last line, then the exit code
  const ok = '{"type":"result","subtype":"success","is_error":false,"result":"Hi!"}'
  assert.equal(
    probeError({ stdout: ok, stderr: 'warn\nclaude: command not found\n', status: 1 }),
    'claude: command not found',
  )
  assert.equal(probeError({ stdout: 'not json', status: 1 }), 'exit code 1, no output')
  assert.equal(probeError({}), 'no output')
})

test('withFollowUps: follow-ups with no milestone are work when there is nothing else', () => {
  const idle = { status: 'idle', reason: 'Nothing to build in v1.0.0.', waiting: ['#2 on-hold'] }
  const candidates = [{ number: 5, title: 'f' }]
  assert.deepEqual(withFollowUps(idle, { candidates, waiting: ['#6 on-hold'] }), {
    status: 'work',
    milestone: null,
    release: false,
    candidates,
    waiting: ['#2 on-hold', '#6 on-hold'],
  })
})

test('withFollowUps: with none to take it stays idle, listing each waiting issue once', () => {
  const idle = { status: 'idle', reason: 'r', waiting: ['#2 on-hold'] }
  assert.deepEqual(withFollowUps(idle, { candidates: [], waiting: ['#2 on-hold'] }), idle)
  const bare = { status: 'idle', reason: 'r' }
  assert.deepEqual(withFollowUps(bare, { candidates: [], waiting: [] }), bare)
})

test('withFollowUps: one run takes only the oldest five', () => {
  const candidates = [1, 2, 3, 4, 5, 6, 7].map((number) => ({ number, title: 'f' }))
  const result = withFollowUps({ status: 'idle', reason: 'r' }, { candidates, waiting: [] })
  assert.deepEqual(
    result.candidates.map((c) => c.number),
    [1, 2, 3, 4, 5],
  )
})
