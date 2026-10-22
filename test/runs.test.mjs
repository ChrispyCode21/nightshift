import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  decodeLog,
  formatLock,
  formatRun,
  lockHeld,
  newestLog,
  parseLock,
  parseRuns,
  processAlive,
  runFailure,
  runRecord,
  summarizeRun,
} from '../bin/lib/runs.mjs'

const PREFLIGHT = fileURLToPath(new URL('../bin/preflight.mjs', import.meta.url))

const CUT_OFF =
  'Background tasks still running 10m after the last turn (subagent "Tier 3 build issue 130"); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.'

test('runFailure: a run Claude Code cut off is a failure even when it exited 0', () => {
  const log = `Tier 3 is running in the background.\n${CUT_OFF}\n`
  assert.match(runFailure({ exitCode: 0, log }), /cut the run off.*Background tasks still running/)
})

test('runFailure: a timeout or a non-zero exit is a failure; a clean run is not', () => {
  assert.equal(runFailure({ exitCode: 1, timedOut: true }), 'timed out')
  assert.equal(runFailure({ exitCode: 2, log: 'done' }), 'exit code 2')
  assert.equal(runFailure({ exitCode: 0, log: 'Opened PR 12 for issue 130.' }), null)
})

test('decodeLog: reads the UTF-16 logs Windows PowerShell wrote, and UTF-8', () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(CUT_OFF, 'utf16le')])
  assert.equal(decodeLog(utf16), CUT_OFF)
  assert.equal(decodeLog(Buffer.from(`﻿${CUT_OFF}`, 'utf8')), CUT_OFF)
  assert.match(runFailure({ exitCode: 0, log: decodeLog(utf16) }), /cut the run off/)
})

test('parseLock and formatLock: the old and the runner format', () => {
  const old = 'pid 1836, since 2026-10-21T18:05:50.110Z'
  assert.deepEqual(parseLock(old), { pid: 1836, runner: false, since: '2026-10-21T18:05:50.110Z' })
  const lock = { pid: 4242, runner: true, since: '2026-10-21T18:05:50.110Z' }
  assert.equal(formatLock(lock), 'pid 4242 (runner), since 2026-10-21T18:05:50.110Z')
  assert.deepEqual(parseLock(formatLock(lock)), lock)
  assert.deepEqual(parseLock('garbage'), { pid: null, runner: false, since: null })
})

test('lockHeld: held while young, unless the runner that took it is gone', () => {
  const old = 'pid 1836, since 2026-10-21T18:05:50.110Z'
  const runner = 'pid 4242 (runner), since 2026-10-21T18:05:50.110Z'
  const dead = () => false
  const alive = () => true
  assert.equal(lockHeld(runner, { ageHours: 1, maxHours: 4, isAlive: alive }), true)
  assert.equal(lockHeld(runner, { ageHours: 1, maxHours: 4, isAlive: dead }), false)
  assert.equal(lockHeld(runner, { ageHours: 5, maxHours: 4, isAlive: alive }), false)
  // preflight's own pid always ends with the command, so only age can clear an old-format lock
  assert.equal(lockHeld(old, { ageHours: 1, maxHours: 4, isAlive: dead }), true)
  assert.equal(lockHeld(old, { ageHours: 4.1, maxHours: 4, isAlive: dead }), false)
})

test('processAlive: this process is, a pid that does not exist is not', () => {
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(2 ** 22 + 12345), false)
})

const START = '2026-10-22T10:00:00.000Z'
const END = '2026-10-22T10:00:41.000Z'
const summarize = (stdout) => summarizeRun(stdout, { start: START, end: END })

test('summarizeRun: the last lines, the refs and the duration of a plain log', () => {
  const log = 'Reviewed things.\nPR 12 for issue 130: merged\nPR 13: held\nPR 14: fixed\n\n'
  assert.deepEqual(summarize(log), {
    durationSeconds: 41,
    summary: 'PR 12 for issue 130: merged PR 13: held PR 14: fixed',
    refs: ['PR 12', 'issue 130', 'PR 13', 'PR 14'],
  })
})

test('summarizeRun: UTF-16 logs read the same, an empty log is (no output)', () => {
  const text = 'Built issue 7, opened PR 9\n'
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  assert.deepEqual(summarize(decodeLog(utf16)), summarize(text))
  assert.deepEqual(summarize(''), { durationSeconds: 41, summary: '(no output)', refs: [] })
  assert.equal(summarizeRun('x', { start: 'not a date' }).durationSeconds, null)
})

test('summarizeRun: refs include #n and GitHub URLs; a cut-off log keeps its last lines', () => {
  const log = `See #5 and https://github.com/o/r/pull/8\n${CUT_OFF}\n`
  const { refs, summary } = summarize(log)
  assert.deepEqual(refs, ['#5', 'github.com/o/r/pull/8', 'issue 130'])
  assert.match(summary, /Background tasks still running/)
})

test('summarizeRun: truncated, and only printable ASCII, whatever the run printed', () => {
  const { summary } = summarize(
    `\x1b[31mred\x1b[0m \x1b]0;title\x07 em — dash … café\nfake [x finished (0)]\n${'x'.repeat(400)}`,
  )
  assert.ok(summary.length <= 160)
  assert.match(summary, /^[\x20-\x7e]+$/)
  const small = summarize('\x1b[31mred\x1b[0m \x1b]0;title\x07 em — dash … café\r\nnext')
  assert.equal(small.summary, 'red em - dash ... caf? next')
})

test('outcome logic: stderr never becomes the summary, but a cut-off only in stderr still fails', () => {
  const stdout = 'PR 3: merged\n'
  const stderr = `${CUT_OFF}\n`
  assert.equal(summarize(stdout).summary, 'PR 3: merged')
  assert.match(runFailure({ exitCode: 0, log: `${stdout}\n${stderr}` }), /cut the run off/)
})

test('runRecord: finished, failed and timed-out; the reason is ASCII', () => {
  const base = {
    start: START,
    end: END,
    repo: 'foo',
    agent: 'review',
    exitCode: 0,
    durationSeconds: 41,
    refs: [],
    log: 'a.log',
  }
  assert.equal(runRecord({ ...base, failure: null }).outcome, 'finished')
  assert.equal(runRecord({ ...base, failure: null }).reason, null)
  assert.equal(runRecord({ ...base, failure: 'timed out' }).outcome, 'timed-out')
  const failed = runRecord({ ...base, exitCode: 1, failure: 'exit code 1 …' })
  assert.deepEqual([failed.outcome, failed.reason], ['failed', 'exit code 1 ...'])
})

test('parseRuns: a corrupt line is skipped', () => {
  const text = `${JSON.stringify({ repo: 'a' })}\n{oops\n\n42\n${JSON.stringify({ repo: 'b' })}\n`
  assert.deepEqual(parseRuns(text), [{ repo: 'a' }, { repo: 'b' }])
})

test('preflight outcome: one run appends exactly one parseable line to runs.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightshift-'))
  try {
    const log = join(dir, 'foo-review-20261022-100000.log')
    writeFileSync(log, 'PR 3 for issue 2: merged\n')
    writeFileSync(`${log}.err`, `${CUT_OFF}\n`)
    writeFileSync(join(dir, 'runs.jsonl'), 'not json\n')
    const args = [
      '--exit',
      '0',
      '--log',
      log,
      '--err',
      `${log}.err`,
      '--start',
      START,
      '--repo',
      'foo',
      '--agent',
      'review',
    ]
    const run = spawnSync(process.execPath, [PREFLIGHT, 'outcome', ...args], {
      env: { ...process.env, NIGHTSHIFT_HOME: dir },
      encoding: 'utf8',
    })
    assert.equal(run.status, 10) // the cut-off is in stderr only
    assert.match(JSON.parse(run.stdout).summary, /^PR 3 for issue 2: merged$/)
    const records = parseRuns(readFileSync(join(dir, 'runs.jsonl'), 'utf8'))
    assert.equal(records.length, 1)
    assert.equal(readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').length, 2) // + the corrupt one
    assert.deepEqual(
      [records[0].repo, records[0].agent, records[0].outcome, records[0].log],
      ['foo', 'review', 'failed', 'foo-review-20261022-100000.log'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('newestLog: picks the newest by stamp, per repo, and never nightshift.log, .prompt or .err', () => {
  const files = [
    'foo-build-20261021-230000.log',
    'foo-review-20261022-040000.log',
    'foo-bar-review-20261022-050000.log',
    'foo-review-20261022-040000.log.err',
    'foo-review-20261022-060000.prompt',
    'nightshift.log',
    'zzz-build-20261020-010000.log',
  ]
  assert.equal(newestLog(files, 'foo'), 'foo-review-20261022-040000.log')
  assert.equal(newestLog(files, 'foo-bar'), 'foo-bar-review-20261022-050000.log')
  assert.equal(newestLog(files), 'foo-bar-review-20261022-050000.log')
  assert.equal(newestLog(files, 'nope'), null)
  assert.equal(newestLog(['nightshift.log']), null)
})

test('formatRun: one ASCII line per record, with placeholders for what is missing', () => {
  const line = formatRun({
    start: START,
    repo: 'foo',
    agent: 'review',
    outcome: 'finished',
    durationSeconds: 41,
    refs: ['PR 3', 'issue 2'],
    log: 'a.log',
  })
  assert.match(
    line,
    /^\d{4}-\d\d-\d\d \d\d:\d\d {2}foo {2}review {2}finished {2}41s {2}PR 3, issue 2 {2}a\.log$/,
  )
  assert.match(
    formatRun({ repo: 'foo', refs: [] }),
    /^\?\?\?\?-\?\?-\?\? \?\?:\?\? {2}foo {2}- {2}- {2}- {2}- {2}-$/,
  )
})

const preflight = (home, ...args) =>
  spawnSync(process.execPath, [PREFLIGHT, 'log', ...args], {
    env: { ...process.env, NIGHTSHIFT_HOME: home },
    encoding: 'utf8',
  })

test('preflight log --file prints a UTF-8 log and a UTF-16 log with a BOM identically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightshift-'))
  try {
    const text = 'PR 3 \u2014 merged \u2026 caf\u00e9\nline two\n'
    const utf8 = join(dir, 'a.log')
    const utf16 = join(dir, 'b.log')
    writeFileSync(utf8, text)
    writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
    assert.equal(preflight(dir, '--file', utf8).stdout, text)
    assert.equal(preflight(dir, '--file', utf16).stdout, text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preflight log --newest and --list: the newest log, the last 20 runs, and a message when empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightshift-'))
  try {
    const empty = preflight(dir, '--newest')
    assert.equal(empty.status, 10)
    assert.match(JSON.parse(empty.stdout).reason, /No run logs yet/)
    assert.match(JSON.parse(preflight(dir, '--list').stdout).reason, /No runs recorded yet/)

    mkdirSync(join(dir, 'logs'))
    for (const name of [
      'foo-build-20261021-230000.log',
      'foo-bar-review-20261022-050000.log',
      'nightshift.log',
    ])
      writeFileSync(join(dir, 'logs', name), 'x')
    assert.match(
      JSON.parse(preflight(dir, '--newest', '--repo', 'foo').stdout).path,
      /foo-build-20261021-230000\.log$/,
    )
    assert.equal(preflight(dir, '--newest', '--repo', 'nope').status, 10)

    const records = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({ start: START, repo: `r${i}`, log: `r${i}.log` }),
    )
    writeFileSync(join(dir, 'runs.jsonl'), `${records.join('\n')}\n{corrupt\n`)
    const { lines } = JSON.parse(preflight(dir, '--list').stdout)
    assert.equal(lines.length, 20)
    assert.match(lines[19], /r24/)
    assert.doesNotMatch(lines[0], /r4 /)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
