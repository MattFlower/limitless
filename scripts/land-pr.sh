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
[[ "${LIMITLESS_CONFIG_DIR-/}" = /* ]] || export LIMITLESS_CONFIG_DIR="$PWD/$LIMITLESS_CONFIG_DIR"
cd "$dir"
checker=""
trap '[ -z "$checker" ] || { kill -TERM "$checker" 2>/dev/null || :; wait "$checker" || :; }; exit 1' TERM INT
check_private() { bun "$private_check" "$@" & checker=$!; wait "$checker"; checker=""; }

admin="$(cd "$(git rev-parse --absolute-git-dir)" && pwd -P)"
common="$(cd "$(git rev-parse --path-format=absolute --git-common-dir)" && pwd -P)"
paths="$(check_private --record)"
{ IFS= read -r GIT_WORK_TREE; IFS= read -r GIT_DIR; IFS= read -r GIT_COMMON_DIR; ! IFS= read -r extra; } <<< "$paths" || exit 1
[[ "$GIT_WORK_TREE" = "$(pwd -P)" && "$GIT_DIR" = "$admin" && "$GIT_COMMON_DIR" = "$common" ]] || exit 1
# A planted graft could hide ancestry from the scan and still be pushed.
export GIT_GRAFT_FILE=/dev/null
export GIT_WORK_TREE GIT_DIR GIT_COMMON_DIR
env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR bun install --frozen-lockfile >/dev/null
log="${LAND_PR_LOG:-${TMPDIR:-/tmp}/land-pr-check.$$.log}"
if ! env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR bun run check >"$log" 2>&1; then
  echo "bun run check failed; see $log" >&2
  exit 1
fi

git add -A
check_private "$pr" "$repo" "$subject"
if ! git diff --cached --quiet || [ -f "$(git rev-parse --git-path MERGE_HEAD)" ]; then
  git commit -q -m "Merge main into PR $pr

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "worktree still dirty after commit" >&2
  exit 1
fi

sha="$(git rev-parse HEAD)"
head_ref="$(gh pr view "$pr" -R "$repo" --json headRefName --jq .headRefName)"
check_private "$pr" "$repo" "$subject" "$head_ref" "$sha"
git push -q --no-follow-tags origin "$sha:refs/heads/$head_ref"

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

check_private "$pr" "$repo" --merge "$sha"
echo "landed #$pr at $sha"
