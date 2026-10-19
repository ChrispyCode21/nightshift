// The two opt-in keys (DESIGN.md, "Opting a repo in"): this machine's registry, and each repo's
// committed .claude/nightshift.json, merged over the plugin's defaults.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULTS = new URL('../../defaults/nightshift.json', import.meta.url)

// %USERPROFILE%\.nightshift, not AppData: the Claude desktop app's processes see a private copy of
// AppData, so its scheduled runs and Task Scheduler's runs wouldn't share state there.
export const home = () => process.env.NIGHTSHIFT_HOME || join(homedir(), '.nightshift')

export const CONFIG_PATH = join('.claude', 'nightshift.json')

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Objects merge key by key; arrays and scalars in the repo's config replace the default.
export function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [key, value] of Object.entries(over)) out[key] = merge(base[key], value)
  return out
}

// JSON written on Windows may start with a byte-order mark, which JSON.parse rejects.
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))

export const defaults = () => readJson(DEFAULTS)

export function loadRegistry() {
  const path = join(home(), 'repos.json')
  if (!existsSync(path)) return { repos: [] }
  return readJson(path)
}

// A repo the agents may work on: registered, enabled, and carrying its config file.
export function resolveRepo(name) {
  const entry = loadRegistry().repos.find((r) => r.name === name)
  if (!entry) throw new Error(`${name} isn't registered (${join(home(), 'repos.json')}).`)
  if (entry.enabled === false) throw new Error(`${name} is registered but disabled.`)
  const path = join(entry.checkout, CONFIG_PATH)
  if (!existsSync(path)) throw new Error(`${name} has no ${CONFIG_PATH}, so it isn't opted in.`)
  return { entry, config: merge(defaults(), readJson(path)) }
}
