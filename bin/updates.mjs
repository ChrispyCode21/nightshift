// The watcher's update questions, answered for nightshift.ps1 (the rules are in lib/updates.mjs):
//   updates.mjs newer <candidate> <installed>    true when candidate is a higher version
//   updates.mjs due [<last-check ISO time>]      true when the daily check should run
import { checkDue, isNewer } from './lib/updates.mjs'

const [command, a, b] = process.argv.slice(2)
if (command === 'newer') console.log(isNewer(a, b))
else if (command === 'due') console.log(checkDue(a))
else {
  console.error('Usage: updates.mjs newer <candidate> <installed> | due [<last-check>]')
  process.exit(2)
}
