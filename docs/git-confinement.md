# Factory Git confinement

`worktreeGit` confines the main command, hardening discovery, empty-tree hashing, nested-repository
inspection and clean retries. The production backend derives Git's executable paths at runtime,
checks the profile separately from the repository command, and refuses when Seatbelt is unavailable.
Normal Git failures retain `CommandError` and `allowFail` behavior. Tests install an identity backend
in their preload; subprocess tests pass that preload explicitly. Production reads no backend selector.

The existing hardening flags, hook/filter blanking, dirty-submodule suppression and populated-repository
walk remain. A recorded linked worktree supplies the write roots; standalone repositories use their
own administration directory. Explicit global `--git-dir` and `--work-tree` options take precedence
over the environment, with the last option winning; filenames after the command cannot select write
roots. Scratch and TMPDIR are canonicalized too. Reads remain unrestricted.

## Caller audit

- `src/git/repos.ts`: local delivery exports pinned commits with confined bundle creation, then performs
  a confined fetch of the bundle into the destination with hooks, maintenance, tags and recursive submodule fetching off.
  Eval grading uses the same bundle export instead of starting upload-pack in the candidate checkout.
- Factory-owned cache clone/fetch and worktree administration use `cacheGit`, preserving the existing
  hardening. Worktree creation there uses `--no-checkout`; checkout/reset runs confined from the new
  recorded worktree. Exports use a private scratch index and designate the export directory as TMPDIR.
- `remoteSh` retains hardened, unconfined remote transports, as required by the issue's remote-push
  exclusion. Those commands do not inspect nested working trees.
- `src/land`, `src/pipeline`, `src/integrations/mcp-change.ts`, `src/evals/runner.ts`: checkout inspection,
  merge/rebase, reset, commit, diff and object reads use the confined wrapper. No difftool, mergetool,
  interactive rebase or editor invocation was found.
- `src/gc.ts`: administrative removal/pruning runs from the owning common/cache directory.
- `scripts/check-private-strings.ts`: its subprocess imports the same production backend.
  `scripts/land-pr.sh`: both config discovery and local `safe_git` commands use `git-confined.ts`.
  Its remote push remains a separate hardened transport from the private push repository.
- `worktreeGitScope.run(false, ...)` occurs only in tests; no production caller enters that scope.

## Execution-vector coverage

The [Git configuration reference](https://git-scm.com/docs/git-config) and
[attribute reference](https://git-scm.com/docs/gitattributes) identify these execution paths:

| Vector | Coverage or applicability |
| --- | --- |
| clean / long-running process filters | Nested dirty-check command matrix, including empty commit, cherry-pick and revert; identity controls execute both drivers. |
| smudge filters / merge drivers | Direct profile probes with identity controls. Parent operations do not recurse into nested checkouts with the preserved `submodule.recurse=false`. |
| `core.fsmonitor` | Direct profile probe; the wrapper also preserves `core.fsmonitor=false`. |
| `gpg.program`, `commit.gpgSign` | Signing profile probe. A nested dirty check does not commit inside the nested repository. |
| `core.askPass`, credential helpers, `core.sshCommand` | Authentication/transport paths; checkout operations do not request them. Confined operations have no network or shell transport. |
| hooks | Existing hook tests; bundle delivery plants pre-push, pre-receive, update and reference-transaction hooks at both ends and checks that none runs. Tags and notes remain absent at the destination. |
| external diff / textconv | Existing hardening disables them on inspection. |
| pager / editor / sequence editor / merge tools | Factory captures output and supplies commit messages, uses noninteractive rebase, and does not invoke external diff/merge tools. Any attempted execution is denied. |
| shell aliases / remote helpers / upload-pack / receive-pack | Alias execution probe; local delivery and candidate-to-grader transfer use bundles. Remote transports remain outside this boundary. |
| maintenance / gc / alternate-ref commands | Executions outside the Git installation are denied; destination bundle fetch disables automatic maintenance/gc. |

## Verification limits

`test/git-confinement.test.ts` includes portable backend/refusal tests, identity controls, the command
matrix, execution probes, delivery and a writer synchronized after the populated-repository check.
The writer control reproduces filter execution with the identity backend.

Two portable checks run without real Seatbelt. One drives the production Seatbelt backend through a
stand-in `sandbox-exec` and a recording `git` on PATH, across status, diff, staging, commits, merge,
the empty-tree lookup and the clean retry. It asserts that every git process except the one-time
version probe started inside the stand-in. The other launches `worktreeGit` and
`scripts/check-private-strings.ts` in subprocesses without the test preload, where Seatbelt is
unavailable (nested inside a sandbox, or not macOS). Both refuse, and no nested filter runs. When
Seatbelt is available, the same launch confines and succeeds.

The factory worker is already sandboxed. Real Seatbelt tests therefore skip using `seatbeltSkip`;
an unconfined macOS run, including both installed Git and `/usr/bin/git`, is still required before
landing. This worker cannot certify the real profile or its identity-backend comparison.

Conservative interpretation: matrix rows already protected by #539 remain regression coverage.
Requiring every such row to execute a marker on main would contradict the requirement to preserve
those protections. New empty-commit and race identity controls demonstrate the remaining gap.

The implementation exceeds the approximate 150-line source budget (about 220 net source lines,
including the manual landing entry point and the additional eval transfer discovered in the audit).

## Checks run in the worker

The initial affected-suite run completed with 727 passes, 50 platform skips and one failure: the
new directory-precedence regression, added before its fix. No existing test failed. That failure
showed the old profile granting inherited paths instead of the explicit destinations.

```sh
bun test --parallel=4 test/git-confinement.test.ts test/git-integrity.test.ts test/land-queue.test.ts test/land-pr.test.ts test/conflict-rounds.test.ts test/pipeline-conflicts.test.ts test/pipeline-merge-integrity.test.ts test/pipeline-local-clones.test.ts test/evals-implement-runner.test.ts test/failure-injection.test.ts
```

After the fix, the regression passed on its own. The following batch also completed with 68 passes,
48 real-Seatbelt skips and zero failures, including the strengthened hook/notes delivery assertions:

```sh
bun test --parallel=4 test/git-confinement.test.ts test/mcp.test.ts test/gc.test.ts test/worktree-git-locks.test.ts test/github-delivery.test.ts
```

The final `bun test test/git-confinement.test.ts` completed with 22 passes, 48 real-Seatbelt skips
and zero failures. Across the two batches, all 774 distinct runnable tests in 14 affected files
passed after the regression fix; 50 platform-specific tests skipped. Real Seatbelt verification
remains outstanding and must happen outside this worker's sandbox.

`bun run lint` (existing warnings), `bunx tsc --noEmit`, `bunx biome check` on changed TypeScript,
`git diff --check`, and `bash -n scripts/land-pr.sh` pass.
