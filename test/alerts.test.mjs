import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  alertLines,
  alertText,
  attentionStep,
  digestDue,
  digestText,
  healthStep,
  normalizeState,
  tickStep,
} from '../bin/lib/alerts.mjs'

const PREFLIGHT = fileURLToPath(new URL('../bin/preflight.mjs', import.meta.url))
const T0 = Date.parse('2026-11-21T09:45:00.000Z')
const at = (minutes) => new Date(T0 + minutes * 60_000)

// One check's results in order, the way the watcher reports them, with each delivered message
// marking the entry as the caller does.
function replay(results) {
  let entry = null
  const kinds = []
  for (const [minutes, problem] of results) {
    const step = healthStep(entry, { problem, now: at(minutes) })
    entry = step.entry
    if (step.message) {
      kinds.push(step.message.kind)
      if (entry) entry = { ...entry, alertedAt: at(minutes).toISOString() }
    }
  }
  return { entry, kinds }
}

test('healthStep: one failing pass is quiet; failing past the grace says "down" once', () => {
  assert.deepEqual(replay([[0, 'Not logged in']]).kinds, [])
  assert.deepEqual(
    replay([
      [0, 'x'],
      [0.2, 'x'],
      [0.4, 'x'],
    ]).kinds,
    [],
  ) // one pass, many repos
  assert.deepEqual(
    replay([
      [0, 'x'],
      [90, 'x'],
    ]).kinds,
    ['down'],
  )
  assert.deepEqual(
    replay([
      [0, 'x'],
      [90, 'x'],
      [180, 'x'],
      [270, 'x'],
    ]).kinds,
    ['down'],
  )
  const { entry } = replay([
    [0, 'first'],
    [90, 'second'],
  ])
  assert.equal(entry.since, at(0).toISOString()) // since the first failure
  assert.equal(entry.reason, 'second') // with the latest reason
})

test('healthStep: a pass in between starts over; recovery is news only after an alert', () => {
  assert.deepEqual(
    replay([
      [0, 'x'],
      [30, null],
      [90, 'x'],
    ]).kinds,
    [],
  )
  assert.deepEqual(
    replay([
      [0, 'x'],
      [90, 'x'],
      [180, null],
    ]).kinds,
    ['down', 'up'],
  )
  assert.equal(
    replay([
      [0, 'x'],
      [90, 'x'],
      [180, null],
    ]).entry,
    null,
  )
  assert.deepEqual(replay([[0, null]]), { entry: null, kinds: [] })
})

test('healthStep: a day later it says "still"; an alert not delivered is tried again', () => {
  const day = 24 * 60
  assert.deepEqual(
    replay([
      [0, 'x'],
      [90, 'x'],
      [90 + day - 1, 'x'],
      [90 + day, 'x'],
    ]).kinds,
    ['down', 'still'],
  )
  // the caller never set alertedAt (Discord refused): the next failing pass says "down" again
  const first = healthStep(null, { problem: 'x', now: at(0) })
  const second = healthStep(first.entry, { problem: 'x', now: at(90) })
  const third = healthStep(second.entry, { problem: 'x', now: at(180) })
  assert.deepEqual([second.message.kind, third.message.kind], ['down', 'down'])
})

test('healthStep: the reason is printable ASCII and short', () => {
  const { entry } = healthStep(null, {
    problem: `Not logged in · run /login\x1b[31m ${'x'.repeat(500)}`,
    now: at(0),
  })
  assert.match(entry.reason, /^Not logged in - run \/login x+\.\.\.$/)
  assert.ok(entry.reason.length <= 200)
})

test('attentionStep: a new list is news; the same list is quiet; a changed one is news again', () => {
  const items = ['#211 agent-needs-info', '#212 agent-followup']
  const first = attentionStep(null, { items, title: 'open issues', now: at(0) })
  assert.equal(first.message.kind, 'waiting')
  const told = { ...first.entry, notified: true }
  const same = attentionStep(told, { items, title: 'open issues', now: at(90) })
  assert.equal(same.message, null)
  assert.equal(same.entry.since, at(0).toISOString())
  assert.equal(same.entry.at, at(90).toISOString())
  const changed = attentionStep(told, {
    items: ['#211 agent-needs-info'],
    title: 'open issues',
    now: at(180),
  })
  assert.deepEqual(changed.message.items, ['#211 agent-needs-info'])
  // not delivered last time: try again with the same list
  assert.equal(attentionStep(first.entry, { items, now: at(90) }).message.kind, 'waiting')
})

test('attentionStep: an empty list clears it; a gate that did not look leaves it', () => {
  const entry = attentionStep(null, { items: ['#1 on-hold'], now: at(0) }).entry
  assert.deepEqual(attentionStep(entry, { items: [], now: at(90) }), { entry: null, message: null })
  assert.deepEqual(attentionStep(entry, { items: undefined, now: at(90) }), { entry, message: null })
  assert.deepEqual(attentionStep(null, { items: [], now: at(0) }), { entry: null, message: null })
})

test('tickStep: records the pass, and a gap when the last one was 3 hours or more ago', () => {
  const empty = normalizeState(null)
  const one = tickStep(empty, at(0))
  assert.deepEqual([one.lastTick, one.gaps], [at(0).toISOString(), []])
  assert.deepEqual(tickStep(one, at(90)).gaps, [])
  assert.deepEqual(tickStep(one, at(180)).gaps, [{ from: at(0).toISOString(), to: at(180).toISOString() }])
  // a 4-hour pass (runs in it) and the next one right after: no gap; an end never records one
  const ended = tickStep(one, at(240), { end: true })
  assert.deepEqual([ended.lastTick, ended.gaps], [at(240).toISOString(), []])
  assert.deepEqual(tickStep(ended, at(250)).gaps, [])
})

test('digestDue: once a day, from the first pass after 8 AM local', () => {
  const local = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute)
  assert.equal(digestDue(null, local(24, 7, 59)), false)
  assert.equal(digestDue(null, local(24, 8, 15)), true)
  assert.equal(digestDue(local(24, 8, 15).toISOString(), local(24, 20)), false)
  assert.equal(digestDue(local(23, 9).toISOString(), local(24, 8, 15)), true)
  assert.equal(digestDue(local(23, 9).toISOString(), local(24, 6)), false)
})

test('normalizeState: anything the file held reads as a state', () => {
  for (const raw of [null, 'x', [], { health: [], gaps: {} }]) {
    assert.deepEqual(normalizeState(raw), {
      health: {},
      attention: {},
      gaps: [],
      lastTick: null,
      lastDigest: null,
    })
  }
})

test('alertText: health and attention messages say who, what and why; ASCII and short', () => {
  const down = alertText({ kind: 'down', since: at(0).toISOString(), reason: 'Not logged in' }, 'usage')
  assert.match(
    down,
    /^nightshift: every repo is stopped: the Claude Code usage check \(claude -p\) has failed since \w{3} \d\d:\d\d\.\nWhy: Not logged in$/,
  )
  assert.match(
    alertText({ kind: 'up', since: at(0).toISOString() }, 'usage'),
    /^nightshift: every repo is running again/,
  )
  assert.match(
    alertText({ kind: 'still', since: at(0).toISOString(), reason: 'x' }, 'gate macworx review'),
    /^nightshift: macworx review is still stopped: its GitHub check/,
  )
  assert.match(
    alertText({ kind: 'down', since: at(0).toISOString(), reason: 'x' }, 'refresh macworx build'),
    /macworx build is stopped: refreshing its checkout/,
  )
  const waiting = alertText(
    {
      kind: 'waiting',
      title: 'open issues in v0.6.0, but none the builder can take',
      items: ['#211 agent-needs-info', '#212 agent-followup'],
    },
    'macworx build',
  )
  assert.equal(
    waiting,
    'nightshift: macworx has open issues in v0.6.0, but none the builder can take:\n- #211 agent-needs-info\n- #212 agent-followup',
  )
  const long = alertText(
    { kind: 'waiting', title: 't', items: Array.from({ length: 100 }, (_, i) => `#${i} ${'x'.repeat(100)}`) },
    'r build',
  )
  assert.ok(long.length <= 1900)
  assert.match(long, /^[\x20-\x7e\n]+$/)
})

test('digestText: problems, gaps, and per repo the runs since the last digest and what waits', () => {
  const state = {
    ...normalizeState(null),
    lastDigest: at(0).toISOString(),
    health: {
      usage: {
        since: at(0).toISOString(),
        last: at(90).toISOString(),
        reason: 'Not logged in',
        alertedAt: null,
      },
    },
    attention: { 'macworx build': { items: ['#211 agent-needs-info'], at: at(90).toISOString() } },
    gaps: [{ from: at(100).toISOString(), to: at(400).toISOString() }],
  }
  const run = (minutes, extra) => ({
    repo: 'macworx',
    agent: 'review',
    end: at(minutes).toISOString(),
    outcome: 'finished',
    summary: 'merged PR 3',
    reason: null,
    ...extra,
  })
  const records = [
    run(-10, { summary: 'before the last digest' }),
    run(30),
    run(60, { outcome: 'failed', reason: 'exit code 1' }),
  ]
  const text = digestText({ state, records, repos: ['macworx', 'logtelligent'], now: at(24 * 60) })
  const lines = text.split('\n')
  assert.match(lines[0], /^nightshift daily, .*if one doesn't, the watcher has stopped\.$/)
  assert.match(
    text,
    /Stopped: every repo: the Claude Code usage check \(claude -p\) failing since .*: Not logged in/,
  )
  assert.match(text, /The watcher didn't run from .* to /)
  assert.match(
    text,
    /macworx: 2 runs \(1 finished, 1 failed\)\. last review: exit code 1\. waiting on you: #211 agent-needs-info\./,
  )
  assert.match(text, /logtelligent: no runs\. nothing waiting on you\./)
  assert.doesNotMatch(text, /before the last digest/)
})

test('alertLines: one line per open problem and waiting list', () => {
  const state = {
    ...normalizeState(null),
    health: { token: { since: at(0).toISOString(), last: at(0).toISOString(), reason: 'x' } },
    attention: { 'macworx review': { items: ['#57 is a draft'], at: at(0).toISOString() } },
  }
  const [health, waiting] = alertLines(state)
  assert.match(health, /^stopped: every repo: reading the nightshift GitHub token/)
  assert.match(waiting, /^waiting: macworx review: #57 is a draft \(as of /)
})

const preflight = (dir, ...args) =>
  spawnSync(process.execPath, [PREFLIGHT, ...args], {
    env: { ...process.env, NIGHTSHIFT_HOME: dir },
    encoding: 'utf8',
  })

test('preflight health, digest, alerts: state in alerts.json; no webhook sends nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightshift-'))
  try {
    writeFileSync(join(dir, 'repos.json'), JSON.stringify({ repos: [] }))
    const failing = preflight(dir, 'health', '--key', 'token', '--problem', "couldn't read the token")
    assert.equal(failing.status, 0, failing.stdout)
    const saved = JSON.parse(readFileSync(join(dir, 'alerts.json'), 'utf8'))
    assert.equal(saved.health.token.reason, "couldn't read the token")
    const lines = JSON.parse(preflight(dir, 'alerts').stdout).lines
    assert.equal(lines.length, 1)
    assert.equal(preflight(dir, 'health', '--key', 'token', '--ok').status, 0)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'alerts.json'), 'utf8')).health, {})
    assert.equal(preflight(dir, 'health', '--key', 'token').status, 1) // neither --problem nor --ok

    const digest = JSON.parse(preflight(dir, 'digest', '--force').stdout)
    assert.equal(digest.notice, 'digest: no webhook')
    assert.match(digest.text, /^nightshift daily/)
    assert.ok(JSON.parse(readFileSync(join(dir, 'alerts.json'), 'utf8')).lastDigest)
    assert.equal(preflight(dir, 'digest').status, 10) // just sent: not due
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
