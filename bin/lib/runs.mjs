// What a headless run leaves behind, judged with no I/O so it's unit-tested (test/runs.test.mjs):
// whether Claude Code cut it off, and whether the lock it took is still held.

// Claude Code's own messages for a headless run it ended early. `claude -p` can exit 0 after them,
// so the exit code alone can't tell a finished run from a cut-off one.
const CUT_OFF = [
  /Background tasks still running .*?stopping them/i, // the 10-minute wait for background subagents
  /Reached max turns/i,
  /Execution error/i,
]

// The text of a run log. Windows PowerShell redirects as UTF-16 with a byte-order mark; the
// launcher now writes UTF-8, but older logs are still read.
export function decodeLog(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le').replace(/^﻿/, '')
  return buffer.toString('utf8').replace(/^﻿/, '')
}

// Why a run didn't finish its work, or null: a non-zero exit, a timeout, or Claude Code's message
// that it stopped the run's background subagents.
export function runFailure({ exitCode, timedOut = false, log = '' }) {
  if (timedOut) return 'timed out'
  const cut = CUT_OFF.find((pattern) => pattern.test(log))
  if (cut) return `Claude Code cut the run off: ${log.match(cut)[0]}`
  if (exitCode !== 0) return `exit code ${exitCode}`
  return null
}

// A lock file's text: "pid 1836, since 2026-10-21T18:05:50.110Z", with "(runner)" after the pid
// when it's the launcher's, which lives as long as the run does. preflight.mjs's own pid ends
// with the command, so only a runner's pid says whether the run is still going.
export function parseLock(text) {
  const m = /^pid (\d+)( \(runner\))?, since (\S+)/.exec(text.trim())
  return m
    ? { pid: Number(m[1]), runner: Boolean(m[2]), since: m[3] }
    : { pid: null, runner: false, since: null }
}

export const formatLock = ({ pid, runner, since }) => `pid ${pid}${runner ? ' (runner)' : ''}, since ${since}`

// Held: younger than `maxHours`, and, if a runner took it, that process is still alive.
export function lockHeld(text, { ageHours, maxHours, isAlive }) {
  if (ageHours >= maxHours) return false
  const { pid, runner } = parseLock(text)
  return !(runner && !isAlive(pid))
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM' // it exists, just isn't ours
  }
}
