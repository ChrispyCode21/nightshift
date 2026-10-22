// Creates nightshift's standard labels in a GitHub repo (lib/labels.mjs), for `nightshift.ps1
// register`. Labels that exist are left as they are.
//
//   node labels.mjs <owner/repo>
//
// Prints one line. Exit 0: the labels are there; 1: some couldn't be created or listed (the line
// says why). Uses the nightshift GitHub token when there is one, and never falls back to the
// owner's own gh login if that token can't be read.
import { execFileSync } from 'node:child_process'
import { githubEnv } from './lib/github.mjs'
import { ensureLabels } from './lib/labels.mjs'

const repo = process.argv[2]
if (!repo) {
  console.error('Usage: labels.mjs <owner/repo>')
  process.exit(2)
}

try {
  const env = githubEnv()
  const runGh = (args) =>
    execFileSync('gh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const { created, existing, failed } = ensureLabels(repo, runGh)
  const parts = [`${created.length} created`, `${existing.length} already there`]
  if (failed.length) {
    parts.push(`couldn't create ${failed.map((f) => `${f.name} (${f.error})`).join(', ')}`)
  }
  console.log(parts.join(', '))
  process.exit(failed.length ? 1 : 0)
} catch (error) {
  const reason = String(error.stderr || error.message)
    .trim()
    .split('\n')[0]
  console.log(`couldn't read or create the labels (${reason})`)
  process.exit(1)
}
