// What a headless run leaves behind, judged with no I/O so it's unit-tested (test/runs.test.mjs):
// whether Claude Code cut it off, what it said at the end, and whether the lock it took is still held.

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

// The log's text is data from a run that read issues and PRs: it is printed, never executed or fed
// to a model. Reduced to printable ASCII it can't fake log lines or escape sequences, and survives
// the code pages Windows PowerShell 5.1 reads node's output and nightshift.log in.
const REPLACEMENTS = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...' }

export function toAscii(text, max = Infinity) {
  const clean = String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC, e.g. a terminal title
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI, e.g. colors
    .replace(/[–—‘’“”…]/g, (c) => REPLACEMENTS[c])
    .replace(/\s+/g, ' ') // also stops text from starting a new log line
    .replace(/[^\x20-\x7e]/g, '?') // remaining control characters and non-ASCII
    .trim()
  return clean.length > max ? `${clean.slice(0, max - 3).trimEnd()}...` : clean
}

const REF = /\b(?:PR|issue) \d+|#\d+|github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+/g
const SUMMARY_LINES = 3
const SUMMARY_CHARS = 160
const MAX_REFS = 20

// From a run's stdout (the coordinator's final reply; never stderr): the last few non-empty lines
// as one short line (the review report is one line per PR), the PRs and issues it names, and how
// long the run took.
export function summarizeRun(stdout, { start, end = new Date() } = {}) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim())
  const seconds = (new Date(end) - new Date(start)) / 1000
  return {
    durationSeconds: Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : null,
    summary: toAscii(lines.slice(-SUMMARY_LINES).join(' '), SUMMARY_CHARS) || '(no output)',
    refs: [...new Set(toAscii(stdout).match(REF) ?? [])].slice(0, MAX_REFS),
  }
}

// One runs.jsonl record. `failure` is runFailure's reason, whose 'timed out' is its own outcome.
export function runRecord({ start, end, repo, agent, exitCode, failure, durationSeconds, refs, log }) {
  const outcome = failure === 'timed out' ? 'timed-out' : failure ? 'failed' : 'finished'
  const reason = failure ? toAscii(failure, SUMMARY_CHARS) : null
  return { start, end, repo, agent, exitCode, outcome, reason, durationSeconds, refs, log }
}

// The records in runs.jsonl's text; a line that doesn't parse is skipped.
export function parseRuns(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    try {
      const record = JSON.parse(line)
      return record && typeof record === 'object' ? [record] : []
    } catch {
      return []
    }
  })
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
