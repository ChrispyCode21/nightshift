import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readJson } from '../bin/lib/config.mjs'

test('readJson: a byte-order mark from a Windows editor or PowerShell is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightshift-'))
  const path = join(dir, 'with-bom.json')
  writeFileSync(path, '﻿{"repos":[]}')
  assert.deepEqual(readJson(path), { repos: [] })
  rmSync(dir, { recursive: true, force: true })
})
