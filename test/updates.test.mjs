import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDue, isNewer } from '../bin/lib/updates.mjs'

test('isNewer: compares each part as a number', () => {
  assert.equal(isNewer('0.3.5', '0.3.4'), true)
  assert.equal(isNewer('0.10.0', '0.9.9'), true)
  assert.equal(isNewer('1.0.0', '0.99.99'), true)
  assert.equal(isNewer('0.3.4', '0.3.4'), false)
  assert.equal(isNewer('0.3.3', '0.3.4'), false)
})

test('isNewer: a missing or malformed version is never newer', () => {
  assert.equal(isNewer(undefined, '0.3.4'), false)
  assert.equal(isNewer('0.3.5', ''), false)
  assert.equal(isNewer('0.3.5-beta', '0.3.4'), false)
  assert.equal(isNewer('not json', '0.3.4'), false)
})

test('checkDue: runs once a day', () => {
  const now = new Date('2026-10-21T12:00:00Z')
  assert.equal(checkDue(undefined, now), true)
  assert.equal(checkDue('garbage', now), true)
  assert.equal(checkDue('2026-10-20T12:00:00Z', now), true)
  assert.equal(checkDue('2026-10-20T12:00:01Z', now), false)
  assert.equal(checkDue('2026-10-21T11:30:00Z', now), false)
})

test('checkDue: a last check in the future (clock set back) is due', () => {
  assert.equal(checkDue('2026-10-22T12:00:00Z', new Date('2026-10-21T12:00:00Z')), true)
})
