// The plugin and its marketplace entry describe the same plugin.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
const plugin = read('.claude-plugin/plugin.json')
const marketplace = read('.claude-plugin/marketplace.json')

test('the marketplace lists this plugin from the repo root', () => {
  const entry = marketplace.plugins.find((p) => p.name === plugin.name)
  assert.ok(entry, `marketplace.json has no entry named ${plugin.name}`)
  assert.equal(entry.source, './')
})

test('the plugin version is semver', () => {
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/)
})
