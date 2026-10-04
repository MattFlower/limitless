#!/usr/bin/env bash
# Land a factory PR from a merge worktree: check, commit everything, push, wait for CI, squash-merge.
# Usage: scripts/land-pr.sh <pr-number> "<squash subject>" [worktree-dir]
# Every step checks its own exit status; nothing is piped, so a failure always stops the merge.
set -euo pipefail

pr="$1"
subject="$2"
dir="${3:-.}"
repo="MattFlower/limitless"
private_check="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-private-strings.ts"
export LIMITLESS_CONFIG_DIR="${LIMITLESS_CONFIG_DIR-$HOME/.config/limitless}"
[[ "$LIMITLESS_CONFIG_DIR" = /* ]] || export LIMITLESS_CONFIG_DIR="$PWD/$LIMITLESS_CONFIG_DIR"
cd "$dir"

bun install --frozen-lockfile >/dev/null
log="${LAND_PR_LOG:-${TMPDIR:-/tmp}/land-pr-check.$$.log}"
if ! bun run check >"$log" 2>&1; then
  echo "bun run check failed; see $log" >&2
  exit 1
fi

git add -A
bun "$private_check" "$pr" "$repo" "$subject"
if ! git diff --cached --quiet || [ -f "$(git rev-parse --git-path MERGE_HEAD)" ]; then
  git commit -q -m "Merge main into PR $pr

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "worktree still dirty after commit" >&2
  exit 1
fi

head_ref="$(gh pr view "$pr" -R "$repo" --json headRefName --jq .headRefName)"
bun "$private_check" "$pr" "$repo" "$subject" "$head_ref"
git push -q origin "HEAD:refs/heads/$head_ref"
sha="$(git rev-parse HEAD)"

# Wait for the CI run on exactly this commit, then require success.
run=""
for _ in $(seq 1 60); do
  run="$(gh run list -R "$repo" --commit "$sha" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [ -n "$run" ] && break
  sleep 5
done
if [ -z "$run" ]; then
  echo "no CI run appeared for $sha" >&2
  exit 1
fi
if ! gh run watch "$run" -R "$repo" --exit-status >/dev/null; then
  echo "CI failed for $sha (run $run)" >&2
  exit 1
fi

gh pr merge "$pr" -R "$repo" --squash --delete-branch --subject "$subject" --match-head-commit "$sha"
echo "landed #$pr at $sha"
