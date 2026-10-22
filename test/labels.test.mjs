import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaults } from '../bin/lib/config.mjs'
import { ensureLabels, missingLabels, STANDARD_LABELS } from '../bin/lib/labels.mjs'

const names = STANDARD_LABELS.map((l) => l.name)

test('the standard labels: a name, a six-digit color, and a description GitHub accepts', () => {
  assert.equal(new Set(names).size, names.length)
  for (const { name, color, description } of STANDARD_LABELS) {
    assert.match(color, /^[0-9a-f]{6}$/, name)
    assert.ok(
      description.length > 0 && description.length <= 100,
      `${name}: ${description.length} characters`,
    )
  }
})

test('the standard labels include the ones the owner named, with the wording he gave', () => {
  const byName = Object.fromEntries(STANDARD_LABELS.map((l) => [l.name, l.description]))
  for (const name of [
    'on-hold',
    'agent-needs-info',
    'agent-followup',
    'standards',
    'touches-data',
    'touches-gates',
  ]) {
    assert.ok(name in byName, name)
  }
  assert.equal(byName['on-hold'], 'Paused: not under active development. The nightshift builder skips this.')
  assert.equal(byName['agent-needs-info'], "Builder is waiting on the owner's answer")
})

test('every label the builder skips by default is a standard label', () => {
  for (const label of defaults().builder.skipLabels) assert.ok(names.includes(label), label)
})

test('missingLabels: compares names without regard to case, as GitHub does', () => {
  const some = STANDARD_LABELS.slice(0, 3) // on-hold, agent-needs-info, agent-followup
  assert.deepEqual(
    missingLabels(['On-Hold', 'unrelated'], some).map((l) => l.name),
    ['agent-needs-info', 'agent-followup'],
  )
  assert.deepEqual(missingLabels(['on-hold', 'agent-needs-info', 'agent-followup'], some), [])
})

// A fake gh: `label list` answers with the labels the repo has; everything else is recorded.
function fakeGh(existing, failing = []) {
  const calls = []
  const runGh = (args) => {
    calls.push(args)
    if (args[1] === 'list') return JSON.stringify(existing.map((name) => ({ name })))
    if (failing.includes(args[2]))
      throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 403: nope\nmore' })
    return ''
  }
  return { calls, runGh }
}
const small = [
  { name: 'on-hold', color: 'fbca04', description: 'Paused' },
  { name: 'standards', color: '5319e7', description: 'Rolling' },
  { name: 'reviewed', color: 'ededed', description: 'Done' },
]

test('ensureLabels: creates only the missing labels, with color and description, and never forces', () => {
  const { calls, runGh } = fakeGh(['Standards', 'bug'])
  const result = ensureLabels('o/r', runGh, small)
  assert.deepEqual(result, { created: ['on-hold', 'reviewed'], existing: ['standards'], failed: [] })
  const creates = calls.filter((c) => c[1] === 'create')
  assert.deepEqual(creates, [
    ['label', 'create', 'on-hold', '-R', 'o/r', '--color', 'fbca04', '--description', 'Paused'],
    ['label', 'create', 'reviewed', '-R', 'o/r', '--color', 'ededed', '--description', 'Done'],
  ])
  assert.ok(!calls.flat().some((a) => a === '--force' || a === '-f'))
})

test("ensureLabels: lists past gh's default of 30 labels", () => {
  const { calls, runGh } = fakeGh([])
  ensureLabels('o/r', runGh, small)
  assert.deepEqual(calls[0], ['label', 'list', '-R', 'o/r', '--limit', '1000', '--json', 'name'])
})

test('ensureLabels: a label that fails is reported and the rest are still created', () => {
  const { calls, runGh } = fakeGh([], ['on-hold'])
  const result = ensureLabels('o/r', runGh, small)
  assert.deepEqual(result.created, ['standards', 'reviewed'])
  assert.deepEqual(result.failed, [{ name: 'on-hold', error: 'HTTP 403: nope' }])
  assert.equal(calls.filter((c) => c[1] === 'create').length, 3)
})

test('ensureLabels: creates nothing when every label is there', () => {
  const { calls, runGh } = fakeGh(['on-hold', 'standards', 'reviewed'])
  assert.deepEqual(ensureLabels('o/r', runGh, small), {
    created: [],
    existing: ['on-hold', 'standards', 'reviewed'],
    failed: [],
  })
  assert.equal(calls.length, 1)
})

test("ensureLabels: throws when the repo's labels can't be listed", () => {
  assert.throws(
    () =>
      ensureLabels('o/r', () => {
        throw new Error('no access')
      }),
    /no access/,
  )
})
