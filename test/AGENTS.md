# Writing useful, fast tests

The repository's root `AGENTS.md` also applies here.

Add a test when it protects a distinct behavior or regression. Search the existing tests first
and extend the closest case when it already exercises that behavior.

## Tests not to create

- **Source-spelling assertions.** Do not read implementation source just to check identifiers,
  JSX expressions, column-count literals, or formatting. Exercise the exported behavior or
  rendered component. Source inspection is appropriate when source itself is the input being
  analyzed, such as diff auditing. Generated prompts, commands, and configuration are outputs;
  assertions on their meaningful contents are appropriate.
- **Documentation keyword checklists.** Do not require incidental words or prose fragments in
  READMEs or skills. Test executable examples, parseable metadata, installed artifacts, and
  references that must resolve. Preserve exact text checks when wording is an explicit contract.
- **Duplicate assertions without a distinct boundary.** Do not repeat a unit-tested formatting
  or parsing matrix through a complete factory run. Keep representative integration cases for
  wiring, persisted state, retry, and feedback; exercise spelling variants and input boundaries
  directly against the responsible function. Add further integration cases only when they can
  expose a different integration failure.
- **Assertions that only validate the fixture or mock.** Expected results must independently
  describe the contract, rather than repeat the implementation or compare a fake with itself.
- **Tests added only because a file changed.** Comments, cosmetic edits, and reversible changes
  already covered by meaningful tests do not automatically need new test cases.

## Keep useful coverage inexpensive

- Put pure prompt, schema, parsing, and policy tests in focused files without Git, worktree,
  server, or factory setup hooks. Keep expensive `beforeEach` hooks scoped to tests that use them.
- Choose the smallest fixture that exercises the contract. Use an in-memory store for pure
  store behavior; use disk/reopening when persistence or migration is what the test proves.
- Use deferred promises, observable readiness signals, or an injected clock instead of fixed
  sleeps to arrange ordering. Reuse `wait-clock.ts` for provider waits. Retain real subprocess
  and timer coverage where OS cancellation, descendants, sockets, or actual timeout wiring is
  the behavior under test.
- Parameterize distinct behavior classes and boundaries; avoid full Cartesian products whose
  combinations all exercise the same branch and outcome.
- Do not delete security, isolation, cancellation, crash-resume, or delivery tests just because
  they are slow. Identify the unique failure they catch and any replacement coverage first.
- Measure proposed speed changes with the complete default suite. Do not obtain a faster result
  by skipping tests, weakening assertions, or enabling blanket concurrency over shared globals
  such as `process.env`, spies, timers, and gate slots. Finish with `bun run check`.
