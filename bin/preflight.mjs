// Tier 0 (DESIGN.md, "How it runs"): decides with no model whether a registered repo has work for
// the builder or reviewer, so a run with nothing to do costs no tokens. The rules are in
// lib/gates.mjs; this file reads GitHub and the repo's config.
//
//   node preflight.mjs repos                                  the repos the agents may work on
//   node preflight.mjs peak                                   exit 10 during peak hours
//   node preflight.mjs usage                                  exit 10 when plan usage is near its limits
//   node preflight.mjs build|review --repo <name> [--claim | --ignore-lock]
//   node preflight.mjs release build|review --repo <name>     drop that run's lock
//   node preflight.mjs lock build|review --repo <name>        exit 10 while a run holds the lock
//   node preflight.mjs log --file <path>                      print a run log, UTF-8 or UTF-16
//   node preflight.mjs log --newest [--repo <name>]           the newest run log's path
//   node preflight.mjs log --list                             the last 20 runs in runs.jsonl
//   node preflight.mjs outcome --exit <code> --log <file> [--err <file>] --start <iso> --repo <name>
//     --agent build|review [--timed-out]    exit 10 if a run failed; appends the run to runs.jsonl
//
// Prints one JSON object (with the repo's resolved config when there's work). Exit 0: there's work
// (`status: "work"`); 10: nothing to do (`status: "idle"`, with `reason`); 1: it failed.
// --claim takes a lock for that repo and agent when there's work, so a scheduled run and a
// triggered one never overlap; --ignore-lock is for the run holding it, to check again. A lock
// goes stale after LOCK_HOURS, or at once when trigger.ps1 took it and its process has gone.
import { execFileSync, execSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { CONFIG_PATH, home, loadRegistry, resolveRepo } from './lib/config.mjs'
import {
  buildCandidates,
  isDue,
  isOpenBlocker,
  isPeak,
  isReviewable,
  overUsage,
  pickMilestone,
  riskOf,
  USAGE_LIMITS,
  usageFromStream,
} from './lib/gates.mjs'
import { githubEnv } from './lib/github.mjs'
import { lockHolder, lockPath } from './lib/locks.mjs'
import {
  decodeLog,
  formatLock,
  formatRun,
  newestLog,
  parseRuns,
  runFailure,
  runRecord,
  summarizeRun,
} from './lib/runs.mjs'

// Git reports "dubious ownership" for checkouts on drives that don't record owners (exFAT).
const env = {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: '*',
}

const run = (cmd, args, cwd, runEnv = env) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const idle = (reason, extra = {}) => ({ status: 'idle', reason, ...extra })

// gh with the nightshift token when there is one (lib/github.mjs), read on first use. A token
// that can't be read fails the run; it never falls back to the owner's own login.
let ghEnv
const tokenEnv = () => (ghEnv ??= githubEnv(env))
const runGh = (args) => run('gh', args, undefined, tokenEnv())

function github(repo) {
  const json = (args) => JSON.parse(runGh(args) || 'null')
  return {
    json,
    api: (path) => json(['api', `repos/${repo}/${path}`]),
    prs: (fields) => json(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '200', '--json', fields]),
    me: () => runGh(['api', 'user', '--jq', '.login']),
    succeeds: (args) => {
      tokenEnv() // outside the try: an unreadable token is an error, not "no"
      try {
        runGh(args)
        return true
      } catch {
        return false
      }
    },
  }
}

function claim(path) {
  mkdirSync(join(home(), 'locks'), { recursive: true })
  rmSync(path, { force: true }) // stale, or this run's own (--ignore-lock)
  // trigger.ps1 passes its own pid: this process ends with the command, the launcher outlives the run.
  const runner = Number(process.env.NIGHTSHIFT_RUN_PID) || null
  const text = formatLock({
    pid: runner ?? process.pid,
    runner: Boolean(runner),
    since: new Date().toISOString(),
  })
  writeFileSync(path, text, { flag: 'wx' }) // fails on a race
}

function build({ entry, config }) {
  const gh = github(entry.github)
  const { branchPrefix, milestones: mode, skipLabels, release } = config.builder
  const prs = gh.prs('number,headRefName,closingIssuesReferences')
  const open = prs.find((p) => p.headRefName.startsWith(branchPrefix))
  if (open) return idle(`Build PR #${open.number} still open.`)

  const milestone = pickMilestone(gh.api('milestones?state=open&per_page=100'), mode)
  if (mode !== 'none' && !milestone) return idle('No milestone to build from.')
  const query = milestone ? `milestone=${milestone.number}` : 'labels=nightshift'
  const issues = gh.api(`issues?${query}&state=open&per_page=100`).filter((i) => !i.pull_request)

  if (issues.length === 0) {
    if (!release || !milestone || mode !== 'semver')
      return idle(`Nothing open in ${milestone?.title ?? 'nightshift issues'}.`)
    const title = `Release ${milestone.title}`
    const hasIssue = gh
      .api(`issues?milestone=${milestone.number}&state=all&per_page=100`)
      .some((i) => i.title === title)
    if (hasIssue || gh.succeeds(['release', 'view', milestone.title, '-R', entry.github]))
      return idle(`Milestone ${milestone.title} has nothing open and its release is under way.`)
    return { status: 'work', milestone: milestone.title, release: true, candidates: [], waiting: [] }
  }

  // Through the registered checkout, so private repos use its remote and credentials.
  const branches = run('git', ['ls-remote', '--heads', 'origin', `${branchPrefix}*`], entry.checkout)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('refs/heads/')[1])
  const { candidates, waiting } = buildCandidates({
    issues,
    me: gh.me(),
    skipLabels,
    closing: new Set(prs.flatMap((p) => p.closingIssuesReferences.map((r) => r.number))),
    branches,
    branchPrefix,
    openSubIssues: (n) => gh.api(`issues/${n}/sub_issues?per_page=100`).some((s) => s.state === 'open'),
    openBlockers: (n) =>
      gh
        .api(`issues/${n}/dependencies/blocked_by?per_page=100`)
        .filter(isOpenBlocker)
        .map((b) => b.number),
  })
  const where = milestone?.title ?? 'nightshift issues'
  if (candidates.length === 0) return idle(`Nothing to build in ${where}.`, { waiting })
  return { status: 'work', milestone: milestone?.title ?? null, release: false, candidates, waiting }
}

function review({ entry, config }) {
  const gh = github(entry.github)
  const me = gh.me()
  const { authors, highRisk } = config.reviewer
  const branchPrefix = config.builder.branchPrefix
  const prs = gh
    .prs('number,title,body,author,headRefName,isDraft,isCrossRepository,labels')
    .filter((p) => isReviewable(p, { me, branchPrefix, authors }))
    .sort((a, b) => a.number - b.number)

  const due = []
  for (const pr of prs) {
    const labels = pr.labels.map((l) => l.name)
    if (labels.includes('reviewed')) {
      const events = gh.api(`issues/${pr.number}/events?per_page=100`)
      const labeledAt = events
        .filter((e) => e.event === 'labeled' && e.label?.name === 'reviewed')
        .at(-1)?.created_at
      const { commits } = gh.json(['pr', 'view', String(pr.number), '-R', entry.github, '--json', 'commits'])
      if (!isDue({ labels, labeledAt, commits, me })) continue
    }
    const { files } = gh.json(['pr', 'view', String(pr.number), '-R', entry.github, '--json', 'files'])
    const risk = riskOf(
      { author: pr.author.login, title: pr.title, body: pr.body, labels, paths: files.map((f) => f.path) },
      highRisk,
    )
    due.push({ number: pr.number, title: pr.title, branch: pr.headRefName, ...risk })
  }
  if (due.length === 0) return idle('No PRs due.')
  return { status: 'work', prs: due }
}

// The owner's plan usage, read from one tiny headless run on the cheapest model: Claude Code reports
// the plan's 5-hour and weekly windows in a rate_limit_event only in stream-json output. A command
// line with nothing from outside it, so the shell (which finds claude.cmd on Windows) is safe here.
function usage() {
  let out
  try {
    out = execSync('claude -p hi --model haiku --output-format stream-json --verbose', {
      cwd: home(),
      encoding: 'utf8',
      env: { ...env, NIGHTSHIFT_AGENT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
  } catch (error) {
    // A run refused at the limit can still have printed its rate_limit_event.
    out = String(error.stdout ?? '')
    if (!usageFromStream(out)) throw error
  }
  const windows = usageFromStream(out)
  // No event: Claude Code had nothing to report. So far it has only been seen once a window passed
  // a warning level (75%), so no event is taken to mean no window is near USAGE_LIMITS.
  if (!windows) return { status: 'work', reason: 'No usage warning.' }
  const over = overUsage(windows)
  if (windows.rejected) over.unshift('usage limit reached')
  if (over.length) return idle(`Plan usage near its limit: ${over.join(', ')}.`, { limits: USAGE_LIMITS })
  return { status: 'work', reason: 'Usage below the limits.', windows }
}

function repos() {
  const list = loadRegistry().repos.map((entry) => {
    try {
      resolveRepo(entry.name)
      return { name: entry.name, github: entry.github, ready: true }
    } catch (error) {
      return { name: entry.name, github: entry.github, ready: false, reason: error.message }
    }
  })
  return {
    status: list.some((r) => r.ready) ? 'work' : 'idle',
    reason: `${CONFIG_PATH} + registry`,
    repos: list,
  }
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
let result
try {
  const [mode, agent] = args
  if (mode === 'repos') result = repos()
  else if (mode === 'peak')
    result = isPeak() ? idle('Peak hours (5–11 AM Pacific).') : { status: 'work', reason: 'Off-peak.' }
  else if (mode === 'usage') result = usage()
  else if (mode === 'release') {
    if (!['build', 'review'].includes(agent) || !option('--repo'))
      throw new Error('Usage: release build|review --repo <name>')
    rmSync(lockPath(option('--repo'), agent), { force: true })
    process.exit(0)
  } else if (mode === 'log') {
    // The run's own text: printed as data, never executed.
    if (option('--file')) {
      process.stdout.write(decodeLog(readFileSync(option('--file'))))
      process.exit(0)
    }
    const runsFile = join(home(), 'runs.jsonl')
    if (flag('--list')) {
      const records = existsSync(runsFile) ? parseRuns(readFileSync(runsFile, 'utf8')) : []
      result = records.length
        ? { status: 'work', reason: 'Recent runs.', lines: records.slice(-20).map(formatRun) }
        : idle('No runs recorded yet.')
    } else {
      const dir = join(home(), 'logs')
      const name = newestLog(existsSync(dir) ? readdirSync(dir) : [], option('--repo'))
      result = name
        ? { status: 'work', reason: 'Newest run log.', path: join(dir, name) }
        : idle(option('--repo') ? `No run logs for ${option('--repo')} yet.` : 'No run logs yet.')
    }
  } else if (mode === 'outcome') {
    // A finished headless run: idle (exit 10) with the reason when it didn't finish its work. The
    // summary comes from the log (stdout) alone; failures are looked for in stderr too.
    const logFile = option('--log')
    const stdout = decodeLog(readFileSync(logFile))
    const errFile = option('--err')
    const stderr = errFile && existsSync(errFile) ? decodeLog(readFileSync(errFile)) : ''
    const exitCode = Number(option('--exit'))
    const failure = runFailure({ exitCode, timedOut: flag('--timed-out'), log: `${stdout}\n${stderr}` })
    const end = new Date().toISOString()
    const { durationSeconds, summary, refs } = summarizeRun(stdout, { start: option('--start'), end })
    const record = runRecord({
      start: option('--start') ?? null,
      end,
      repo: option('--repo') ?? null,
      agent: option('--agent') ?? null,
      exitCode,
      failure,
      durationSeconds,
      refs,
      log: basename(logFile),
    })
    mkdirSync(home(), { recursive: true })
    appendFileSync(
      join(home(), 'runs.jsonl'),
      `${JSON.stringify(record)}
`,
    )
    const detail = { summary, durationSeconds }
    result = failure ? idle(record.reason, detail) : { status: 'work', reason: 'Finished.', ...detail }
  } else if (mode === 'lock') {
    if (!['build', 'review'].includes(agent) || !option('--repo'))
      throw new Error('Usage: lock build|review --repo <name>')
    const holder = lockHolder(lockPath(option('--repo'), agent))
    result = holder
      ? idle(`A ${agent} run is in progress (${holder}).`)
      : { status: 'work', reason: 'No run holds the lock.' }
  } else if (mode === 'build' || mode === 'review') {
    const name = option('--repo')
    if (!name) throw new Error(`Usage: ${mode} --repo <name> [--claim | --ignore-lock]`)
    const repo = resolveRepo(name)
    const path = lockPath(name, mode)
    const holder = !flag('--ignore-lock') && lockHolder(path)
    if (holder) result = idle(`Another ${mode} run on ${name} is in progress (${holder}).`)
    else result = mode === 'build' ? build(repo) : review(repo)
    if (result.status === 'work') {
      if (flag('--claim')) claim(path)
      result = { ...result, repo: { ...repo.entry }, config: repo.config }
    }
  } else
    throw new Error(
      'Usage: preflight.mjs repos | peak | usage | build|review --repo <name> | release|lock build|review --repo <name>',
    )
} catch (error) {
  result = { status: 'error', reason: String(error.stderr || error.message).trim() }
}
console.log(JSON.stringify(result, null, 2))
process.exit({ work: 0, idle: 10 }[result.status] ?? 1)
