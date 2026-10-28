// How the agents reach GitHub (DESIGN.md, "GitHub access"): the gh commands they may run, and the
// fine-grained token they run them with, when the owner has set one with `nightshift.ps1 token`.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './config.mjs'
import { readSecret } from './secret.mjs'

// The gh commands the skills and Tier 0 use. Anything else (auth, secret, repo delete, workflow
// run, …) is refused, so an agent misled by text in an issue can't reach it through gh.mjs.
export const GH_COMMANDS = {
  api: null, // any endpoint, GET or POST only (see API_METHODS)
  issue: ['comment', 'create', 'edit', 'list', 'view'],
  label: ['create', 'list'],
  pr: ['checks', 'comment', 'create', 'diff', 'edit', 'list', 'merge', 'view'],
  repo: ['view'],
  run: ['list', 'view'],
}
export const API_METHODS = ['GET', 'POST']

// The HTTP method a `gh api` call asks for (-X POST, -XPOST, --method POST, --method=POST), or null
// when it gives none and gh picks GET or POST itself.
export function apiMethod(args) {
  let method = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-X' || arg === '--method') method = args[++i] ?? ''
    else if (arg.startsWith('--method=')) method = arg.slice('--method='.length)
    else if (/^-X./.test(arg)) method = arg.slice(2)
  }
  return method === null ? null : method.toUpperCase()
}

// Why gh.mjs won't run these arguments, or null when it will.
export function ghArgsProblem(args) {
  const [command, sub] = args
  if (!command || !Object.hasOwn(GH_COMMANDS, command)) {
    return `"gh ${command ?? ''}" isn't one of the gh commands nightshift uses (${Object.keys(GH_COMMANDS).join(', ')})`
  }
  if (command === 'api') {
    const method = apiMethod(args.slice(1))
    if (method !== null && !API_METHODS.includes(method)) {
      return `gh api ${method} isn't allowed; nightshift only reads (GET) and creates (POST)`
    }
    return null
  }
  if (!GH_COMMANDS[command].includes(sub)) {
    return `"gh ${command} ${sub ?? ''}" isn't one of the gh commands nightshift uses (gh ${command} ${GH_COMMANDS[command].join('|')})`
  }
  return null
}

export const tokenPath = () => join(home(), 'gh-token')

let token

// The environment to run gh in: with GH_TOKEN set to the nightshift token when there is one, else
// unchanged (the owner's own gh login). A token file that can't be read throws rather than falling
// back to the owner's login, which can do far more.
export function githubEnv(base = process.env) {
  const path = tokenPath()
  if (!existsSync(path)) return base
  token ??= readSecret(path)
  return { ...base, GH_TOKEN: token }
}
