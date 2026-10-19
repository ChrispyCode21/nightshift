# The nightshift baseline

The standards every repo is held to where its own rules say nothing (DESIGN.md, "Standards"). The repo's own rules always decide what the agents write. Where the repo departs from a rule here, it's reported on the repo's `standards` issue, never fixed in an unrelated PR, unless the repo's config lists it as an exception.

## UI

- `no-inline-components`: components are defined at module level, never inside another component's body.
- `no-inline-styles`: no `style={{…}}` or `style="…"` for anything a class or token can express.
- `tokens-only`: colors, spacing, radii, font sizes, shadows and z-indexes come from design tokens, not raw values.
- `use-primitives`: where the repo has a shared component (button, field, card), raw elements with the same role aren't used.
- `accessible-by-default`: interactive elements are real controls (`<button>`, `<a href>`, inputs) with accessible names; images have `alt`; nothing is clickable without being focusable.
- `respects-preferences`: motion honors `prefers-reduced-motion`, colors work in light and dark, and text pairs meet WCAG AA contrast.
- `fits-small-screens`: no fixed widths or sideways scrolling at 320px.

## Code

- `one-formatter`: dates, numbers and units are formatted through shared helpers.
- `pure-core`: domain logic has no UI, storage or I/O imports.
- `strict-types`: TypeScript `strict` on; no `any`, no unexplained `!`, and `@ts-expect-error` with a reason instead of `@ts-ignore`.
- `no-floating-promises`: every promise is awaited, returned or explicitly handled.
- `no-swallowed-errors`: no empty `catch`, and no `catch` that only logs where the caller needed to know.
- `no-debug-leftovers`: no `console.log`, `debugger`, commented-out code or `.only` in tests.
- `no-dead-code`: no unused exports, files or dependencies.
- `named-constants`: domain numbers (limits, rates, thresholds) are named constants, not literals in logic.

## Data

- `validate-at-boundaries`: data from the network, storage, files or the URL is parsed and checked where it enters, and typed only after that.
- `migrate-stored-data`: changing the shape of stored data comes with a versioned migration and a test that upgrades old data.
- `no-secrets`: no keys, tokens or credentialed URLs in code, config or fixtures.

## Tests and dependencies

- `tests-with-logic`: new logic arrives with unit tests, and a fixed bug with a test that would have caught it.
- `deterministic-tests`: unit tests control time, randomness and the network instead of using the real ones.
- `earn-each-dependency`: no new dependency for what the platform or an existing one already does; versions pinned by the lockfile.
