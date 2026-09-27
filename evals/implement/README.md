# Implement eval dataset (v1)

Twelve tasks for the `implement` role (format and grading: [docs/EVALS.md](../../docs/EVALS.md)).
Each trial starts from a pinned `base` commit. After the candidate finishes, the files under
`hidden/<case-id>/` are copied in and `hidden.command` runs them. A trial passes when the hidden
command exits 0 and there is no blocking gate or audit finding.

| Mix | Cases |
|---|---|
| Complexity | 4 trivial, 5 small, 3 medium |
| Repository | 6 `limitless-sandbox` (3 PR replays, 3 authored), 6 Limitless (replays of small fixes and features) |
| Kind | 6 bug fixes, 5 CLI behaviours |

## Provenance
- **Replays** (`head` = the upstream commit): the prompt restates the original request. Where the
  original tests were stricter than the request, the prompt pins the interface the hidden test
  relies on (names, signatures, CLI syntax, output format), as a good spec would. Each case's
  `notes` records what was tightened.
- **Authored** (impl-004, 005, 006; `head` = `base`): written against sandbox `b63e95b`, with
  reference solutions in `reference/<case-id>.patch`. The impl-004 bug (`titleCase` capitalising
  mid-word on non-ASCII letters) is real at that commit.
- Hidden tests are new files (`test/hidden-<id>.test.ts`), so a candidate's own test edits never collide.

## Validation (2026-09-27)
Every case was checked in fresh worktrees after `bun install --frozen-lockfile`:
1. With the hidden files at `base`, the hidden command fails for the intended reason: a missing export, or an assertion about the defect.
2. At the reference (the upstream commit, or `base` plus the patch), the hidden command passes.
3. At the reference, the repository gates pass.

## Caveats
- **impl-002, impl-006:** spec-sensitive (exact table padding, tie-break order, `--top` validation). Everything is stated in the prompt, but a skimming candidate fails.
- **impl-011:** a correct fix breaks assertions in the existing `test/quota-alerts.test.ts`. The prompt asks the candidate to update that test, and the gates enforce it.
- **impl-009, impl-011:** the hidden tests construct `Store`, `RunContext` or `Factory`. Needless constructor changes fail them.
- **Contamination:** this repository and the sandbox are public, and replay solutions are in their history. Trials pin only `base` history, but a candidate with network access could look upstream. Treat absolute pass rates as upper bounds; comparisons between candidates remain fair.
