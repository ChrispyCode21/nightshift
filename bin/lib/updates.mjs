// When a newer nightshift is available, judged with no I/O so it's unit-tested (test/updates.test.mjs).
// The watcher's pass uses these through bin/updates.mjs; it only ever tells the owner, never updates.

const parse = (v) =>
  /^(\d+)\.(\d+)\.(\d+)$/
    .exec(String(v ?? '').trim())
    ?.slice(1)
    .map(Number) ?? null

// True when `candidate` is a higher x.y.z than `installed`. Anything that isn't x.y.z is never newer.
export function isNewer(candidate, installed) {
  const a = parse(candidate)
  const b = parse(installed)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

// Whether the once-a-day check should run: never ran, last ran over a day ago, or a clock that
// went backwards. `last` is an ISO timestamp.
export function checkDue(last, now = new Date()) {
  const then = Date.parse(last ?? '')
  if (Number.isNaN(then)) return true
  const elapsed = now.getTime() - then
  return elapsed < 0 || elapsed >= 24 * 60 * 60 * 1000
}
