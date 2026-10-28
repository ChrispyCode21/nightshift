import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  discordMessage,
  isDiscordWebhook,
  notification,
  notifyOutcome,
  postWebhook,
} from '../bin/lib/notify.mjs'

const PREFLIGHT = fileURLToPath(new URL('../bin/preflight.mjs', import.meta.url))
const WHO = { repo: 'foo', agent: 'build' }
const URL_OK = 'https://discord.com/api/webhooks/123456789/abc-DEF_ghi'

const rec = (extra = {}) => ({
  ...WHO,
  outcome: 'finished',
  summary: 'built PR 12 for issue 5',
  reason: null,
  log: 'foo-build-20261028-020000.log',
  ...extra,
})
const failed = (reason = 'exit code 1') => rec({ outcome: 'failed', reason })

test('notification: nothing until the third setback in a row, then "stuck" once', () => {
  assert.equal(notification([failed()], WHO), null)
  assert.equal(notification([failed(), failed()], WHO), null)
  const third = notification([failed(), failed(), failed('timed out')], WHO)
  assert.deepEqual([third.kind, third.count, third.last.reason], ['stuck', 3, 'timed out'])
  // later setbacks at the longest wait stay quiet
  assert.equal(notification([failed(), failed(), failed(), failed()], WHO), null)
  assert.equal(
    notification(
      Array.from({ length: 9 }, () => failed()),
      WHO,
    ),
    null,
  )
})

test('notification: "nothing built" counts toward a streak; questions and merges break it', () => {
  const nothing = rec({ summary: 'nothing built: all candidates stopped' })
  assert.equal(notification([failed(), nothing, failed()], WHO).kind, 'stuck')
  assert.equal(
    notification([failed(), failed(), rec({ summary: 'need answers on issue 5' }), failed()], WHO),
    null,
  )
})

test('notification: a run that did something after a streak that got to the top says "recovered", once', () => {
  const stuck = [failed(), failed(), failed()]
  const recovered = notification([...stuck, rec()], WHO)
  assert.deepEqual([recovered.kind, recovered.count], ['recovered', 3])
  assert.equal(notification([...stuck, failed(), rec()], WHO).count, 4)
  assert.equal(notification([...stuck, rec(), rec()], WHO), null) // the next success is not news
  assert.equal(notification([failed(), failed(), rec()], WHO), null) // never got to the top
})

test('notification: another repo or agent never counts', () => {
  const other = [
    { ...failed(), repo: 'bar' },
    { ...failed(), agent: 'review' },
  ]
  assert.equal(notification([failed(), failed(), ...other, failed()], WHO).kind, 'stuck')
  assert.equal(notification([...other, failed(), failed()], WHO), null)
  assert.equal(notification([], WHO), null)
})

test('discordMessage: says who, how long, why and where; no mentions; ASCII and short', () => {
  const [stuck] = [notification([failed(), failed(), failed('exit code 1')], WHO)]
  const body = discordMessage(stuck, WHO)
  assert.deepEqual(body.allowed_mentions, { parse: [] })
  assert.match(body.content, /foo build has come to nothing 3 times in a row and now waits 2 hours/)
  assert.match(body.content, /Last run: exit code 1/)
  assert.match(body.content, /Log: foo-build-20261028-020000\.log \(nightshift\.ps1 logs foo\)/)
  const hostile = rec({ outcome: 'failed', reason: `@everyone ‮ ${'x'.repeat(500)}\x1b[31m` })
  const text = discordMessage({ kind: 'stuck', count: 3, last: hostile }, WHO).content
  assert.match(text, /^[\x20-\x7e\n]+$/)
  assert.ok(text.length < 600)
  const back = discordMessage({ kind: 'recovered', count: 4, last: rec() }, WHO)
  assert.match(back.content, /foo build is working again after 4 runs that came to nothing/)
})

test('isDiscordWebhook: only Discord webhook URLs', () => {
  assert.equal(isDiscordWebhook(URL_OK), true)
  assert.equal(isDiscordWebhook('https://ptb.discord.com/api/webhooks/1/abc'), true)
  assert.equal(isDiscordWebhook('https://discordapp.com/api/webhooks/1/abc'), true)
  for (const bad of [
    'http://discord.com/api/webhooks/1/abc',
    'https://discord.com.evil.example/api/webhooks/1/abc',
    'https://evil.example/https://discord.com/api/webhooks/1/abc',
    'https://discord.com/api/webhooks/1/abc?x=1',
    'https://discord.com/api/webhooks/abc/def',
    '',
  ])
    assert.equal(isDiscordWebhook(bad), false, bad)
})

test('postWebhook: posts JSON with a timeout and fails on a refusal', async () => {
  let seen
  await postWebhook(
    URL_OK,
    { content: 'hi' },
    {
      fetchImpl: async (url, init) => ((seen = { url, init }), { ok: true, status: 204 }),
    },
  )
  assert.equal(seen.url, URL_OK)
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.body, '{"content":"hi"}')
  assert.ok(seen.init.signal instanceof AbortSignal)
  await assert.rejects(
    postWebhook(URL_OK, {}, { fetchImpl: async () => ({ ok: false, status: 429 }) }),
    /429/,
  )
})

test('notifyOutcome: sends when stuck and a webhook is set; says nothing otherwise; never throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightshift-'))
  try {
    const path = join(dir, 'discord-webhook')
    const stuck = [failed(), failed(), failed()]
    const sent = []
    const deps = (extra = {}) => ({
      path,
      read: () => URL_OK,
      post: async (url, body) => sent.push([url, body]),
      ...extra,
    })

    assert.equal(await notifyOutcome(stuck, WHO, deps()), null) // no webhook file
    writeFileSync(path, 'encrypted')
    assert.equal(await notifyOutcome(stuck, WHO, deps()), 'discord: sent (stuck)')
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], URL_OK)
    assert.equal(await notifyOutcome([failed()], WHO, deps()), null) // nothing to say yet
    assert.equal(sent.length, 1)

    assert.match(
      await notifyOutcome(
        stuck,
        WHO,
        deps({
          post: async () => {
            throw new Error('Discord answered 500')
          },
        }),
      ),
      /^discord: not sent: Discord answered 500$/,
    )
    assert.match(
      await notifyOutcome(
        stuck,
        WHO,
        deps({
          read: () => {
            throw new Error('cannot decrypt')
          },
        }),
      ),
      /^discord: not sent: cannot decrypt$/,
    )
    assert.match(
      await notifyOutcome(stuck, WHO, deps({ read: () => 'https://evil.example/x' })),
      /not a Discord webhook/,
    )
    assert.equal(sent.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preflight outcome: an unreadable webhook never changes what the run reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightshift-'))
  try {
    const log = join(dir, 'foo-build-20261028-020000.log')
    writeFileSync(log, 'Result: nothing built: all candidates stopped\n')
    writeFileSync(join(dir, 'discord-webhook'), 'not a DPAPI blob')
    const runsFile = join(dir, 'runs.jsonl')
    const old = JSON.stringify({
      ...failed(),
      start: '2026-10-28T01:00:00.000Z',
      end: '2026-10-28T01:05:00.000Z',
    })
    writeFileSync(runsFile, `${old}\n${old}\n`) // this run is the third setback
    mkdirSync(join(dir, 'logs'), { recursive: true })
    const outcome = spawnSync(
      process.execPath,
      [
        PREFLIGHT,
        'outcome',
        '--exit',
        '0',
        '--log',
        log,
        '--start',
        '2026-10-28T02:00:00.000Z',
        '--repo',
        'foo',
        '--agent',
        'build',
      ],
      { env: { ...process.env, NIGHTSHIFT_HOME: dir }, encoding: 'utf8' },
    )
    // exit 0: a finished run, whatever happened to the message
    assert.equal(outcome.status, 0)
    const result = JSON.parse(outcome.stdout)
    assert.match(result.summary, /^nothing built/)
    assert.match(result.notice, /^discord: not sent: /)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
