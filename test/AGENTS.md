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
- Build a fixture repository once per process with `seeded` (`seeded.ts`) and copy it into each
  test instead of repeating `git init`/`commit` in every `beforeEach`. Git runs with the
  identity-only global config `setup.ts` installs, as in CI; set `GIT_CONFIG_GLOBAL` in a test
  that needs more.
- Use deferred promises, observable readiness signals, or an injected clock instead of fixed
  sleeps to arrange ordering. Reuse `wait-clock.ts` for provider waits, and let promise chains
  settle between fake-clock steps with `setImmediate` turns, not 1 ms timers. Retain real
  subprocess and timer coverage where OS cancellation, descendants, sockets, or actual timeout
  wiring is the behavior under test; when such tests only wait, each in its own directory and
  processes, `test.concurrent` lets them overlap.
- Parameterize distinct behavior classes and boundaries; avoid full Cartesian products whose
  combinations all exercise the same branch and outcome.
- Do not delete security, isolation, cancellation, crash-resume, or delivery tests just because
  they are slow. Identify the unique failure they catch and any replacement coverage first.
- Measure proposed speed changes with the complete default suite. Do not obtain a faster result
  by skipping tests, weakening assertions, or enabling blanket concurrency over shared globals
  such as `process.env`, spies, timers, and gate slots. Finish with `bun run check`.

## Tests that hold on every machine

- **Show that the test fails without the change.** Undo the fix (copy the file aside, never
  `git stash`), run the test, and restore it. A test that still passes protects nothing, and
  reviewers run this check.
- **No timing margins.** An ordering that holds by a few milliseconds (for example a grace period
  of 0 that needs one event recorded before another completes) passes today and fails when either
  path gets faster or slower. Arrange the order with deferred promises or readiness signals.
- **CI is Linux.** It pins the Bun version in `.github/workflows/ci.yml`, runs a newer git than
  macOS, and has git-lfs filters (`filter.lfs.*`) configured outside the global file `setup.ts`
  replaces. Avoid assertions on incidental, environment-dependent argv or config entries; keep
  exact assertions where the command's structure is the behavior under test, and inject the
  relevant configuration explicitly. Reproduce a CI-only git failure with `GIT_CONFIG_SYSTEM`
  pointing at a file that defines a fake lfs filter.
- **Platform-specific tests skip with a reason.** Real Seatbelt tests use
  `test.skipIf(seatbeltSkip !== null)` and put `seatbeltSkip` (`confinement.ts`) in the title: they
  skip on other platforms and inside confined gates (factory and land-queue checks), and run on
  unconfined macOS (development and the manual `land-pr.sh` check). Darwin-only process inspection checks
  `process.platform`. A behavior whose only test is skipped everywhere it runs is untested.
- **Real subprocesses:** keep every pid or handle the test starts and stop it in `finally`. Never
  find processes by name, never `pkill`, and give each test its own directory.
- **Servers listen on port 0** and read the assigned port. Other suites run on the same machine at
  the same time.
- **Temporary files** go under `os.tmpdir()` (`mkdtemp`), never a hardcoded `/tmp`: confined gates
  point `TMPDIR` into scratch and deny the system temp directories.
- **External clients are injected.** `gh`, GitHub and model clients come in through parameters or
  factory dependencies, and some default to the real one (for example the `client` parameter of
  `startGitHubNotifier`). Pass a fake every time.
- **"Flaky" needs evidence.** Before calling a failure flaky, rerun it alone and read its raw
  output. Deterministic bugs (a matcher that missed a changed CLI path, a test race exposed by a
  faster code path) have been dismissed as flakes and cost hours.
