import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { defaults, merge, resolveRepo } from '../bin/lib/config.mjs'

test("merge: objects merge key by key; the repo's arrays and scalars replace", () => {
  const base = { a: { x: 1, y: [1, 2] }, b: 'keep' }
  assert.deepEqual(merge(base, { a: { y: [3] } }), { a: { x: 1, y: [3] }, b: 'keep' })
  assert.deepEqual(merge(base, { a: { x: null } }), { a: { x: null, y: [1, 2] }, b: 'keep' })
})

test('defaults: every repo starts opted out of the optional features', () => {
  const d = defaults()
  assert.equal(d.builder.milestones, 'semver')
  assert.equal(d.builder.spec, null)
  assert.equal(d.builder.release, null)
  assert.equal(d.standards.baseline, true)
})

test('defaults: the builder skips issues that are waiting, followed up, questions or on hold', () => {
  assert.deepEqual(defaults().builder.skipLabels, [
    'agent-needs-info',
    'agent-followup',
    'question',
    'on-hold',
  ])
})

test("merge: a repo's own skipLabels replaces the default list, so it must name on-hold itself", () => {
  const merged = merge(defaults(), { builder: { skipLabels: ['question'] } })
  assert.deepEqual(merged.builder.skipLabels, ['question'])
  assert.equal(merged.builder.milestones, 'semver')
})

let dir
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'nightshift-'))
  process.env.NIGHTSHIFT_HOME = join(dir, 'home')
  mkdirSync(process.env.NIGHTSHIFT_HOME)
  const repo = (name) => {
    mkdirSync(join(dir, name, '.claude'), { recursive: true })
    return join(dir, name)
  }
  const optedIn = repo('opted-in')
  writeFileSync(
    join(optedIn, '.claude', 'nightshift.json'),
    JSON.stringify({ builder: { milestones: 'any' } }),
  )
  const registry = {
    repos: [
      { name: 'opted-in', github: 'o/a', checkout: optedIn },
      { name: 'no-config', github: 'o/b', checkout: repo('no-config') },
      { name: 'paused', github: 'o/c', checkout: optedIn, enabled: false },
    ],
  }
  writeFileSync(join(process.env.NIGHTSHIFT_HOME, 'repos.json'), JSON.stringify(registry))
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('resolveRepo: registered with a config file resolves, merged over the defaults', () => {
  const { config } = resolveRepo('opted-in')
  assert.equal(config.builder.milestones, 'any')
  assert.equal(config.builder.branchPrefix, 'agent/issue-')
})

test('resolveRepo: both opt-in keys are required', () => {
  assert.throws(() => resolveRepo('unknown'), /isn't registered/)
  assert.throws(() => resolveRepo('no-config'), /isn't opted in/)
  assert.throws(() => resolveRepo('paused'), /disabled/)
})
