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

// The skills end their reply with "Result: <what happened>"; the last such line says it best.
const RESULT_LINE = /^[\s*_>`-]*Result:[ \t*_]*(\S.*)$/gim

// From a run's stdout (the coordinator's final reply; never stderr): its "Result:" line, or else
// the last few non-empty lines, as one short line; the PRs and issues it names; and how long the
// run took.
export function summarizeRun(stdout, { start, end = new Date() } = {}) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim())
  const result = [...stdout.matchAll(RESULT_LINE)].at(-1)?.[1]?.replace(/[*_ ]+$/, '')
  const seconds = (new Date(end) - new Date(start)) / 1000
  return {
    durationSeconds: Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : null,
    summary: toAscii(result ?? lines.slice(-SUMMARY_LINES).join(' '), SUMMARY_CHARS) || '(no output)',
    refs: [...new Set(toAscii(stdout).match(REF) ?? [])].slice(0, MAX_REFS),
  }
}

// One runs.jsonl record. `failure` is runFailure's reason, whose 'timed out' is its own outcome.
export function runRecord({
  start,
  end,
  repo,
  agent,
  exitCode,
  failure,
  durationSeconds,
  refs,
  summary,
  log,
}) {
  const outcome = failure === 'timed out' ? 'timed-out' : failure ? 'failed' : 'finished'
  const reason = failure ? toAscii(failure, SUMMARY_CHARS) : null
  return { start, end, repo, agent, exitCode, outcome, reason, summary, durationSeconds, refs, log }
}

// How long the watcher leaves a repo's agent alone after runs that came to nothing, so a stuck run
// costs one run per wait, not one every 30 minutes. The wait grows with each setback in a row and
// stops at the last step; any run that did something starts it over.
export const BACKOFF_MINUTES = [30, 60, 120]

// The gate found work and the run still produced none: "Result: nothing built: <why>" or
// "Result: no PRs due". Questions, holds and merges are progress: their label takes the item out
// of the gate.
const NOTHING_DONE = /^(nothing built|no PRs due)\b/i

// A run that failed, timed out, was cut off, or found nothing to do after the gate said there was.
export const setback = (record) => record.outcome !== 'finished' || NOTHING_DONE.test(record.summary ?? '')

// When the agent may run again for `repo`, from its runs.jsonl records (oldest first): the number
// of setbacks in a row and the time they end, or null. `startedAt` is when trigger.ps1 last began a
// run for this repo and agent; one with no record after it died without reporting (the machine
// restarted, the launcher was killed), which counts as one more setback, from that start.
export function backoffUntil(records, { repo, agent, startedAt = null }) {
  const mine = records.filter((r) => r.repo === repo && r.agent === agent)
  let count = 0
  for (const record of mine.toReversed()) {
    if (!setback(record)) break
    count++
  }
  let from = count ? mine.at(-1).end : null
  const last = mine.at(-1)
  const started = Date.parse(startedAt)
  if (Number.isFinite(started) && !(Date.parse(last?.start) >= started)) {
    count++
    from = startedAt
  }
  const base = Date.parse(from)
  if (!count || !Number.isFinite(base)) return null
  return { count, until: base + BACKOFF_MINUTES[Math.min(count, BACKOFF_MINUTES.length) - 1] * 60_000 }
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

// A run log's file name: <repo>-<build|review>-<yyyyMMdd>-<HHmmss>.log. nightshift.log, *.prompt
// and *.err don't match. The repo is whatever precedes the agent, so "foo" never matches the
// "foo-bar" repo's logs.
const RUN_LOG = /^(.+)-(build|review)-(\d{8}-\d{6})\.log$/

export function runLogInfo(fileName) {
  const m = RUN_LOG.exec(fileName)
  return m ? { repo: m[1], agent: m[2], stamp: m[3] } : null
}

// The newest run log among `fileNames`, for one repo or any, by the stamp in the name (not the
// file name, which sorts by repo first); or null.
export function newestLog(fileNames, repo) {
  const logs = fileNames
    .map((name) => ({ name, info: runLogInfo(name) }))
    .filter(({ info }) => info && (!repo || info.repo === repo))
    .sort((a, b) => (a.info.stamp < b.info.stamp ? -1 : a.info.stamp > b.info.stamp ? 1 : 0))
  return logs.length ? logs[logs.length - 1].name : null
}

const pad = (n) => String(n).padStart(2, '0')

// One runs.jsonl record as a line of `nightshift.ps1 logs -List`: local time, repo, agent,
// outcome, duration, the PRs and issues it named, the log file.
export function formatRun(record) {
  const at = new Date(record.start)
  const time = Number.isNaN(at.getTime())
    ? '????-??-?? ??:??'
    : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  const seconds = Number.isFinite(record.durationSeconds) ? `${record.durationSeconds}s` : '-'
  const refs = Array.isArray(record.refs) && record.refs.length ? record.refs.join(', ') : '-'
  return [time, record.repo, record.agent, record.outcome, seconds, refs, record.log]
    .map((field) => toAscii(field ?? '-'))
    .join('  ')
}
