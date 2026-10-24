# Reader dependency investigation (#872)

Both Claude and Codex tool readers receive the run worktree as `AgentSpec.cwd`
(`RunContext.invoke`, `src/pipeline/context.ts`). Neither harness creates another checkout.
Their ordinary reader policies allow reading that checkout and its dependencies; writes remain
limited to invocation scratch (`buildClaudeArgs` and `readerFilesystem` in `src/harness/`).
Credential and explicit read denials still take precedence. No read grants change here.

| Execution layout | Where setup/dependencies live | What the reader sees |
| --- | --- | --- |
| Local gates | Run worktree; setup scratch/caches are removed afterwards | Same worktree, installed dependencies readable |
| In-place gates | Same run worktree, owned by the executor process | Same worktree; `onLocalSetup` confirms setup locally |
| LAN gates | Worker's detached checkout and private scratch, cleaned after completion | Coordinator worktree receives results, without ignored dependencies |
| Cached baseline | Recorded results; no setup executes on a hit | A fresh worktree need not have dependencies |
| Resumed/cached round | Gate results can be reused without rerunning setup | Persisted gate success does not establish a current local install |
| Eligible LAN review | Fresh detached checkout created by `runAgent`/`withCheckout` in `src/workers/client.ts` | Committed files only; coordinator `node_modules` is absent |
| Acceptance verification with LAN enabled | `lanAgentExecutor` supports remote review/implementation only | Falls back to the coordinator worktree for both harnesses |
| Shadow review | Separate detached worktree in `src/pipeline/review-shadow.ts` | Also needs its own setup |

Prepare's baseline runs/cache hits are in `src/pipeline/engine.ts`. Before candidate gates,
`checkoutCommitted` (`src/git/repos.ts`) uses `clean -ffdxq`, removing prepare's ignored install.
Local/in-place gate setup recreates it. LAN gate results cannot establish a coordinator install
(`src/gates/lan.ts`). Ordinary post-reader `discardChanges` keeps ignored dependencies.

## Resolution evidence and reproduction

This worker checkout initially had no `node_modules/.bin/biome` or `tsc`. Before installing,
this read-only command reproduced ancestor resolution using real Zod:

```sh
ls node_modules/.bin/biome node_modules/.bin/tsc
bun -e 'console.log(JSON.stringify({ path: import.meta.resolve("zod"), version: (await import("zod/package.json")).version, prefault: typeof (await import("zod")).z.number().prefault }))'
```

The result was `file://<home>/node_modules/zod/index.js`, version `3.25.76`, with `prefault`
`undefined`. After a checkout-local frozen-lockfile install with a private scratch cache, the
same command resolved `<checkout>/node_modules/zod/index.js`, version `4.6.5`, with `prefault`
`function`. Thus the reproduced failure is an absent local install and successful ancestor
resolution, not a read denial or a partial local install. PR #863's runtime artifacts are unavailable:
its reported API/missing-package errors alone cannot prove its exact historical resolution path.

The permanent offline reproduction uses a local file dependency named `zod`, with explicit version
and v4-shaped API exports, and an incompatible ancestor fixture (not full historical Zod releases):

```sh
bun test test/pipeline-reader-dependencies.test.ts
bun test test/workers.test.ts -t 'readonly worker dependencies'
bun test test/pipeline-lan-agent.test.ts -t 'LAN review installs dependencies'
bun test test/pipeline-verification.test.ts -t 'environment verification retry: all-blocked|environment verification retry: mixed-unclear|concurrent decisions.*blocked'
```

These real Bun imports assert resolved paths, versions/API, lockfile changes, resumed stale installs,
private cache destinations, unchanged ancestor files, generated reader permissions, and explicit
setup failure. Local/in-place cases also protect reuse of successful local setup. LAN review tests
exercise the coordinator payload, HTTP lease, detached worker checkout, and local acceptance fallback.

## Change and validation

The factory reuses setup only when this round observed successful local/in-place gates. Otherwise,
it runs the trusted base gate setup in the actual reader checkout, before starting readers. When a
preview needs setup, its existing preparation runs before the concurrent readers and is reused.
Detached LAN/shadow reviewers run that same setup in their own checkout. The shared helper uses
`runLocalGates`: confined subprocesses, scrubbed environments and private disposable caches. Setup
success is followed by the existing hardened `discardChanges` cleanup before any reader starts:
tracked source is restored while ignored installed dependencies remain. This applies to coordinator,
detached LAN and shadow checkouts through the shared helper. Setup failure stops the reader; no
incompatible ancestor import is accepted. No reader gets write access
to its checkout or shared package directories. Production changes stay within the requested budget.

Explicit blocked statuses, reasons and evidence remain persisted, and verification remains failed.
Only the stage summary changes to include the blocked count. Existing feedback filtering, bounded
environment retry, independent review rejections and draft delivery/human handoff are preserved.
Regression checks cover all-blocked and mixed results without adding another implementation round
solely for environment blocks. No prompts, models, routing, retry or merge policies change.

Validation used `bun test --parallel=4` on the 11 affected pipeline, executor, worker and harness
files. Two preview integration failures exposed duplicate ownership of coordinator setup; reusing
preview preparation corrected both without changing those tests. The final rerun of
`test/pipeline-reader-dependencies.test.ts`, `test/pipeline-preview.test.ts` and
`test/pipeline-verification.test.ts` passed all 77 tests. The other eight affected files passed
(eight existing platform/confinement skips). Changed-file `bunx biome check`,
`bunx tsc --noEmit` and `git diff --check` passed. The factory owns the full-suite gate.

Mutation runs removed each fix separately and restored source bytes afterwards: removing local
setup failed four dependency regressions; removing worker setup failed both harness regressions;
removing LAN setup forwarding failed the end-to-end reviewer test; removing blocked counts failed
four summary cases. Removing the existing blocked-feedback filter failed the extended pure feedback
case. Local/in-place dependency cases are positive controls for the already-working reuse path.

The follow-up regression makes offline setup rewrite a tracked source module without changing HEAD.
Every dependency probe now imports that module as well as the expected package, requiring its
committed value. A separate shadow layout also requires the detached shadow review to complete.
Removing the cleanup made the coordinator LAN-gate, detached worker and shadow-layout regressions
fail; restoring it passes them. The complete production diff is 52 added and 7 removed lines,
within the approximate 60-line budget; additional coverage and this report are separate.

Follow-up validation: `bun test --parallel=4` across `pipeline-reader-dependencies`,
`pipeline-agent-executor`, `pipeline-lan-agent`, `pipeline-shadow`, `pipeline-verification`,
`pipeline-preview`, `verification`, `workers`, `workers-http`, `harness` and `sandbox`
(all under `test/`, with `.test.ts` suffix) passed 683 tests, with 23 existing platform/confinement
skips and no failures. Changed-file `bunx biome check`, `bunx tsc --noEmit` and
`git diff --check` also passed.
