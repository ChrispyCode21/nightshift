// What the owner hears about beyond single runs (DESIGN.md, "Telling the owner"): a check that
// keeps failing before any run can start (health), work that waits on the owner (attention), and
// one digest a day, whose absence says the watcher itself has stopped. Pure functions over the
// state in alerts.json, unit-tested (test/alerts.test.mjs); preflight.mjs does the I/O.
import { toAscii } from './runs.mjs'

// A failing check is news once it has failed this long (two watcher passes in a row), then again
// once a day while it lasts.
export const HEALTH_GRACE_MINUTES = 60
export const HEALTH_REMIND_HOURS = 24
// The digest goes out with the first watcher pass after this hour, local time.
export const DIGEST_HOUR = 8
// Passes this far apart mean the watcher didn't run in between (the PC was off, or the task broke).
export const GAP_HOURS = 3

const REASON_CHARS = 200
const ITEM_CHARS = 120
const LINE_CHARS = 400
const MESSAGE_CHARS = 1900 // Discord refuses more than 2000

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// alerts.json's state, whatever the file held.
export function normalizeState(raw) {
  const s = isObject(raw) ? raw : {}
  return {
    health: isObject(s.health) ? s.health : {},
    attention: isObject(s.attention) ? s.attention : {},
    gaps: Array.isArray(s.gaps) ? s.gaps : [],
    lastTick: s.lastTick ?? null,
    lastDigest: s.lastDigest ?? null,
  }
}

// Health keys: "usage" and "token" stop every repo; "refresh <repo> <agent>" and
// "gate <repo> <agent>" stop one.
export function healthSubject(key) {
  if (key === 'usage') return { scope: 'every repo', check: 'the Claude Code usage check (claude -p)' }
  if (key === 'token')
    return { scope: 'every repo', check: 'reading the nightshift GitHub token (nightshift.ps1 token)' }
  const [kind, repo, agent] = String(key).split(' ')
  if (kind === 'refresh') return { scope: `${repo} ${agent}`, check: 'refreshing its checkout' }
  if (kind === 'gate') return { scope: `${repo} ${agent}`, check: 'its GitHub check (Tier 0)' }
  return { scope: String(key), check: 'a check' }
}

// One more result for a health check: `problem` is why it failed, or null when it passed. Returns
// the key's next entry (null: nothing failing) and the message it calls for, or null. The caller
// sets `alertedAt` on the entry once a 'down' or 'still' message was delivered, so one that
// couldn't be is tried again on the next pass.
export function healthStep(entry, { problem, now }) {
  const at = new Date(now).toISOString()
  if (!problem) return { entry: null, message: entry?.alertedAt ? { kind: 'up', since: entry.since } : null }
  const reason = toAscii(problem, REASON_CHARS)
  const next = { since: entry?.since ?? at, reason, last: at, alertedAt: entry?.alertedAt ?? null }
  const elapsed = (from) => Date.parse(at) - Date.parse(from)
  if (!next.alertedAt)
    return {
      entry: next,
      message:
        elapsed(next.since) >= HEALTH_GRACE_MINUTES * 60_000
          ? { kind: 'down', since: next.since, reason }
          : null,
    }
  if (elapsed(next.alertedAt) >= HEALTH_REMIND_HOURS * 3_600_000)
    return { entry: next, message: { kind: 'still', since: next.since, reason } }
  return { entry: next, message: null }
}

// One more look at what a repo's agent is waiting on. `items` are the gate's waiting lines (issue
// or PR number first), [] when nothing waits on the owner, or undefined when the gate didn't look
// (the entry stays as it was). A list is news when it differs from the last one told; the caller
// sets `notified` once it was delivered.
export function attentionStep(entry, { items, title, now }) {
  if (items === undefined) return { entry: entry ?? null, message: null }
  const clean = items.map((item) => toAscii(item, ITEM_CHARS)).filter(Boolean)
  if (!clean.length) return { entry: null, message: null }
  const at = new Date(now).toISOString()
  const fingerprint = clean.join('\n')
  const heading = toAscii(title ?? 'work waiting on you', ITEM_CHARS)
  if (entry?.fingerprint === fingerprint)
    return {
      entry: { ...entry, at },
      message: entry.notified ? null : { kind: 'waiting', title: heading, items: clean },
    }
  return {
    entry: { fingerprint, items: clean, title: heading, since: at, at, notified: false },
    message: { kind: 'waiting', title: heading, items: clean },
  }
}

// A watcher pass started (or, with `end`, finished) at `now`: the state with `lastTick` moved on,
// and, at a start, a gap recorded when the last pass ended too long ago. A pass with runs in it
// can take hours, and the passes due meanwhile are skipped, so only the time since the last one
// ended says the watcher wasn't running.
export function tickStep(state, now, { end = false } = {}) {
  const at = new Date(now).toISOString()
  const last = Date.parse(state.lastTick)
  const gap = !end && Number.isFinite(last) && Date.parse(at) - last >= GAP_HOURS * 3_600_000
  return {
    ...state,
    lastTick: at,
    gaps: gap ? [...state.gaps, { from: state.lastTick, to: at }].slice(-10) : state.gaps,
  }
}

// Whether the daily digest is due at `now` (local time): past DIGEST_HOUR, and none sent since then.
export function digestDue(lastDigest, now, hour = DIGEST_HOUR) {
  const n = new Date(now)
  const from = new Date(n.getFullYear(), n.getMonth(), n.getDate(), hour).getTime()
  return n.getTime() >= from && !(Date.parse(lastDigest) >= from)
}

const when = (iso) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '?'
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d)
}

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text)

// The Discord text for a health or attention message. `key` is the health key, or for attention
// "<repo> <agent>".
export function alertText(message, key) {
  if (message.kind === 'waiting') {
    const [repo] = String(key).split(' ')
    const lines = [
      `nightshift: ${toAscii(repo)} has ${message.title}:`,
      ...message.items.map((i) => `- ${i}`),
    ]
    return cut(lines.join('\n'), MESSAGE_CHARS)
  }
  const { scope, check } = healthSubject(key)
  const lines = {
    down: [
      `nightshift: ${scope} is stopped: ${check} has failed since ${when(message.since)}.`,
      `Why: ${message.reason}`,
    ],
    still: [
      `nightshift: ${scope} is still stopped: ${check} has failed since ${when(message.since)}.`,
      `Why: ${message.reason}`,
    ],
    up: [`nightshift: ${scope} is running again: ${check} works (it failed from ${when(message.since)}).`],
  }[message.kind]
  return cut(lines.join('\n'), MESSAGE_CHARS)
}

// The open health problems and waiting lists, one line each, for `nightshift.ps1 status`.
export function alertLines(state) {
  const health = Object.entries(state.health).map(([key, e]) => {
    const { scope, check } = healthSubject(key)
    return `stopped: ${scope}: ${check} failing since ${when(e.since)} (last ${when(e.last)}): ${e.reason}`
  })
  const attention = Object.entries(state.attention).map(
    ([key, e]) => `waiting: ${key}: ${e.items.join('; ')} (as of ${when(e.at)})`,
  )
  return [...health, ...attention].map((line) => toAscii(line, LINE_CHARS))
}

// The daily digest: open problems, watcher gaps, and per repo the runs since the last digest and
// what waits on the owner. `records` are runs.jsonl's, `repos` the enabled repos' names.
export function digestText({ state, records, repos, now }) {
  const since = Date.parse(state.lastDigest) || new Date(now).getTime() - 24 * 3_600_000
  const lines = [
    `nightshift daily, ${when(now)}. One of these comes every day; if one doesn't, the watcher has stopped.`,
  ]
  // A check runs only when something needs it (the usage probe, when a gate finds work), so one
  // that was fixed reads as failing until it next runs: the last failure says how stale it is.
  for (const [key, e] of Object.entries(state.health)) {
    const { scope, check } = healthSubject(key)
    lines.push(
      `Stopped: ${scope}: ${check} failing since ${when(e.since)}, last failed ${when(e.last)}: ${e.reason}`,
    )
  }
  for (const gap of state.gaps)
    lines.push(`The watcher didn't run from ${when(gap.from)} to ${when(gap.to)}.`)
  for (const repo of repos) {
    const runs = records.filter((r) => r.repo === repo && Date.parse(r.end) > since)
    const counts = Object.entries(
      runs.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {}),
    ).map(([outcome, n]) => `${n} ${outcome}`)
    const parts = [
      runs.length ? `${runs.length} run${runs.length === 1 ? '' : 's'} (${counts.join(', ')})` : 'no runs',
    ]
    for (const agent of ['build', 'review']) {
      const last = runs.filter((r) => r.agent === agent).at(-1)
      if (last) parts.push(`last ${agent}: ${last.reason ?? last.summary ?? last.outcome}`)
    }
    const waiting = ['build', 'review'].flatMap((agent) => state.attention[`${repo} ${agent}`]?.items ?? [])
    parts.push(waiting.length ? `waiting on you: ${waiting.join('; ')}` : 'nothing waiting on you')
    lines.push(toAscii(`${repo}: ${parts.join('. ')}.`, LINE_CHARS))
  }
  return cut(lines.map((line) => toAscii(line, LINE_CHARS)).join('\n'), MESSAGE_CHARS)
}
