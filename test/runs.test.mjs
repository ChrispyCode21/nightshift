import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeLog, formatLock, lockHeld, parseLock, processAlive, runFailure } from '../bin/lib/runs.mjs'

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

test('the skills keep subagents in the foreground', async () => {
  const { readFileSync } = await import('node:fs')
  for (const skill of ['build-next-issue', 'review-prs']) {
    const text = readFileSync(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), 'utf8')
    assert.match(text, /Run every subagent in the foreground/, skill)
  }
})
