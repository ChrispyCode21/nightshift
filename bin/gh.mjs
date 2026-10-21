// The agents' only way to run gh (DESIGN.md, "GitHub access"):
//
//   node gh.mjs <gh arguments>
//
// Runs gh with the nightshift token when the owner has set one (`nightshift.ps1 token`), and only
// the gh commands nightshift uses (lib/github.mjs). Exit 2: refused; otherwise gh's own exit code.
import { spawnSync } from 'node:child_process'
import { ghArgsProblem, githubEnv } from './lib/github.mjs'

const args = process.argv.slice(2)
const problem = ghArgsProblem(args)
if (problem) {
  console.error(`nightshift: ${problem}.`)
  process.exit(2)
}

let env
try {
  env = githubEnv()
} catch (error) {
  console.error(
    `nightshift: couldn't read the nightshift GitHub token (${String(error.message).split('\n')[0]}), ` +
      "so gh wasn't run (it doesn't fall back to the owner's own login). Run `nightshift.ps1 token` again, or `token -Off`.",
  )
  process.exit(1)
}

const result = spawnSync('gh', args, { env, stdio: 'inherit' })
if (result.error) {
  console.error(`nightshift: couldn't start gh (${result.error.message}).`)
  process.exit(1)
}
process.exit(result.status ?? 1)
