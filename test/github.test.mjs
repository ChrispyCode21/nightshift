import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { apiMethod, GH_COMMANDS, ghArgsProblem } from '../bin/lib/github.mjs'

test('ghArgsProblem: the commands the skills and Tier 0 use are allowed', () => {
  for (const args of [
    ['pr', 'edit', '12', '-R', 'o/r', '--add-label', 'reviewed'],
    ['pr', 'checks', '12', '-R', 'o/r', '--watch', '--required'],
    ['pr', 'merge', '12', '-R', 'o/r', '--squash', '--body', 'Nothing dropped.'],
    ['pr', 'create', '-R', 'o/r', '--title', 't', '--body', 'b'],
    ['issue', 'create', '-R', 'o/r', '--label', 'agent-followup'],
    ['issue', 'comment', '7', '-R', 'o/r', '--body', 'b'],
    ['api', 'user', '--jq', '.login'],
    ['api', '-X', 'POST', 'repos/o/r/issues/7/sub_issues', '-F', 'sub_issue_id=99'],
    ['api', 'repos/o/r/issues/7/dependencies/blocked_by', '--method=POST', '-F', 'issue_id=1'],
    ['run', 'view', '123', '-R', 'o/r', '--log-failed'],
  ]) {
    assert.equal(ghArgsProblem(args), null, args.join(' '))
  }
})

test('ghArgsProblem: anything that could leak the login or change more than PRs and issues is refused', () => {
  for (const args of [
    [],
    ['auth', 'token'],
    ['auth', 'status'],
    ['secret', 'set', 'X'],
    ['repo', 'delete', 'o/r', '--yes'],
    ['workflow', 'run', 'deploy.yml'],
    ['pr'],
    ['pr', 'close', '12'],
    ['issue', 'delete', '7'],
    ['api', '-X', 'DELETE', 'repos/o/r'],
    ['api', '-XPATCH', 'repos/o/r'],
    ['api', 'repos/o/r', '--method', 'put'],
    ['api', 'repos/o/r', '--method=DELETE'],
    ['api', 'repos/o/r', '-X'],
  ]) {
    assert.ok(ghArgsProblem(args), `should refuse: gh ${args.join(' ')}`)
  }
})

test('apiMethod: reads every way gh accepts a method, and the last one wins', () => {
  assert.equal(apiMethod(['user']), null)
  assert.equal(apiMethod(['-X', 'post', 'x']), 'POST')
  assert.equal(apiMethod(['-XGET', 'x']), 'GET')
  assert.equal(apiMethod(['--method', 'GET', 'x', '-X', 'DELETE']), 'DELETE')
})

test('every gh command the skills name through gh.mjs is one it allows', () => {
  for (const skill of ['build-next-issue', 'review-prs']) {
    const text = readFileSync(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), 'utf8')
    for (const [, command, sub] of text.matchAll(/gh\.mjs" (\w+) (\S+)/g)) {
      assert.ok(Object.hasOwn(GH_COMMANDS, command), `${skill}: gh ${command}`)
      if (command !== 'api') assert.ok(GH_COMMANDS[command].includes(sub), `${skill}: gh ${command} ${sub}`)
    }
  }
})
