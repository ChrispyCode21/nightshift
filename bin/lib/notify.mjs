// Telling the owner when a repo's agent is stuck (DESIGN.md, "Back-off"): one Discord message when
// the back-off first reaches its longest wait, and one when a run gets past it. The decision and the
// message are pure functions, unit-tested (test/notify.test.mjs); the I/O is injected.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './config.mjs'
import { BACKOFF_MINUTES, setback, toAscii } from './runs.mjs'
import { readSecret } from './secret.mjs'

export const webhookPath = () => join(home(), 'discord-webhook')

// Only Discord's own webhook URLs: a URL that is anything else (a typo, or a file someone edited)
// is never posted to, whatever it says.
const DISCORD_WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/
export const isDiscordWebhook = (url) => DISCORD_WEBHOOK.test(url)

const REASON_CHARS = 200

// What the owner should hear about after `records` (runs.jsonl, oldest first, the run that just
// ended last), or null. 'stuck': this run is the one that took its repo and agent to the longest
// wait, once per streak. 'recovered': a run that did something after a streak that got that far.
// A streak counts the setbacks on record; a launcher that died with no record is not one of them.
export function notification(records, { repo, agent }) {
  const mine = records.filter((r) => r.repo === repo && r.agent === agent)
  const last = mine.at(-1)
  if (!last) return null
  const streakBefore = (list) => {
    let count = 0
    for (const record of list.toReversed()) {
      if (!setback(record)) break
      count++
    }
    return count
  }
  const top = BACKOFF_MINUTES.length
  if (setback(last)) return streakBefore(mine) === top ? { kind: 'stuck', count: top, last } : null
  const before = streakBefore(mine.slice(0, -1))
  return before >= top ? { kind: 'recovered', count: before, last } : null
}

// The Discord message body. Run text is data from a run that read issues and PRs: reduced to
// printable ASCII, cut short, and posted with every mention disabled.
export function discordMessage({ kind, count, last }, { repo, agent }) {
  const what = `${repo} ${agent}`
  const detail = toAscii(last.reason ?? last.summary ?? '', REASON_CHARS)
  const lines =
    kind === 'stuck'
      ? [
          `nightshift: ${what} has come to nothing ${count} times in a row and now waits ${BACKOFF_MINUTES.at(-1) / 60} hours between tries.`,
          detail && `Last run: ${detail}`,
          last.log && `Log: ${toAscii(last.log, 120)} (nightshift.ps1 logs ${repo})`,
        ]
      : [
          `nightshift: ${what} is working again after ${count} runs that came to nothing.`,
          detail && `Last run: ${detail}`,
        ]
  return {
    username: 'nightshift',
    content: lines.filter(Boolean).join('\n'),
    allowed_mentions: { parse: [] },
  }
}

export async function postWebhook(url, body, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`Discord answered ${response.status}`)
}

// Sends the message a run's outcome calls for, if there is a webhook. Never throws: a webhook that
// is missing, unreadable, refused or slow must not change what the run reports. Returns one line
// for the log, or null when there was nothing to say or no webhook.
export async function notifyOutcome(
  records,
  who,
  { path = webhookPath(), read = readSecret, post = postWebhook } = {},
) {
  try {
    const note = notification(records, who)
    if (!note || !existsSync(path)) return null
    const url = read(path)
    if (!isDiscordWebhook(url))
      return 'discord: not sent; the stored URL is not a Discord webhook (nightshift.ps1 discord)'
    await post(url, discordMessage(note, who))
    return `discord: sent (${note.kind})`
  } catch (error) {
    return `discord: not sent: ${toAscii(error.message ?? error, REASON_CHARS)}`
  }
}
