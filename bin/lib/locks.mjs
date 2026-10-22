// The builder's and reviewer's lock files in the nightshift home, read by preflight.mjs and
// tidy.mjs. Whether a lock still counts is lockHeld in runs.mjs.
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './config.mjs'
import { lockHeld, processAlive } from './runs.mjs'

export const LOCK_HOURS = 4

export const lockPath = (name, agent) => join(home(), 'locks', `${name}-${agent}.lock`)

// Who holds the lock, or null. One file handle for the age and the text, so they agree.
export function lockHolder(path) {
  let fd
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const ageHours = (Date.now() - fstatSync(fd).mtimeMs) / 3_600_000
    const text = readFileSync(fd, 'utf8').trim()
    return lockHeld(text, { ageHours, maxHours: LOCK_HOURS, isAlive: processAlive }) ? text : null
  } finally {
    closeSync(fd)
  }
}
