#!/usr/bin/env bash
# Land a factory PR from a merge worktree: check committed work, push, wait for CI, squash-merge.
# Usage: scripts/land-pr.sh <pr-number> "<squash subject>" [worktree-dir]
# Every step checks its own exit status; nothing is piped, so a failure always stops the merge.
set -euo pipefail

pr="$1"
subject="$2"
dir="${3:-.}"
repo="MattFlower/limitless"
private_check="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-private-strings.ts"
[[ "${LIMITLESS_CONFIG_DIR-/}" = /* ]] || export LIMITLESS_CONFIG_DIR="$PWD/$LIMITLESS_CONFIG_DIR"
# The checkout's own CLI: `limitless` need not be on PATH.
cli="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/cli/main.ts"
cd "$dir"
checker=""
push_repo=""
trap '[ -z "$push_repo" ] || rm -rf -- "$push_repo"' EXIT
trap '[ -z "$checker" ] || { kill -TERM "$checker" 2>/dev/null || :; wait "$checker" || :; }; exit 1' TERM INT
# The worktree's bunfig.toml (preload) and .env must not reach the checker.
check_private() { (cd "${check_dir:-$PWD}"; exec bun --config=/dev/null --no-env-file "$private_check" "$@") & checker=$!; wait "$checker"; checker=""; }
# Factory git after PR code has run: no hooks (files or config), filters, fsmonitor, forged commit-graph or bitmaps.
export LIMITLESS_GIT_EMPTY_HOOK=""
safe_git() {
  # Key names never contain newlines (git forbids them in subsections); no temp files, which confined runs can't create.
  local keys key flags=()
  keys="$(git config --name-only --get-regexp '^(hook|filter)\.' 2>/dev/null)" || [ $? = 1 ] || { echo "Cannot read git config; refusing to land" >&2; return 1; }
  set -f
  local IFS=$'\n'
  for key in $keys; do flags+=("--config-env=$key=LIMITLESS_GIT_EMPTY_HOOK"); done
  set +f
  git --no-pager -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.commitGraph=false -c pack.useBitmaps=false \
    ${flags[@]+"${flags[@]}"} "$@"
}
if ! admin="$(git rev-parse --absolute-git-dir 2>/dev/null)" || ! admin="$(cd "$admin" && pwd -P)" ||
   ! common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || ! common="$(cd "$common" && pwd -P)"; then
  echo "Cannot read repository git paths; refusing to land" >&2
  exit 1
fi
paths="$(check_private --record)"
{ IFS= read -r GIT_WORK_TREE; IFS= read -r GIT_DIR; IFS= read -r GIT_COMMON_DIR; ! IFS= read -r extra; } <<< "$paths" || exit 1
[[ "$GIT_WORK_TREE" = "$(pwd -P)" && "$GIT_DIR" = "$admin" && "$GIT_COMMON_DIR" = "$common" ]] || exit 1
# A planted graft or shallow file could hide ancestry from the scan and still be pushed.
export GIT_GRAFT_FILE=/dev/null/none GIT_SHALLOW_FILE=""
export GIT_WORK_TREE GIT_DIR GIT_COMMON_DIR
if ! sha="$(safe_git rev-parse HEAD 2>/dev/null)"; then
  echo "Cannot read landing commit; refusing to land" >&2
  exit 1
fi
# Read all values once so ambiguous origins fail closed; preserve trailing newlines.
if ! url="$(safe_git config --get-all remote.origin.url 2>/dev/null && printf '.')"; then
  echo "Cannot read origin URL; refusing to push" >&2
  exit 1
fi
url="${url%.}"
url="${url%$'\n'}"
if [[ -z "$url" || "$url" = *$'\n'* ]]; then
  echo "Origin URL is missing or multi-valued; refusing to push" >&2
  exit 1
fi
push_repo="$(mktemp -d "${TMPDIR:-/tmp}/land-pr-push.XXXXXXXX")"
chmod 0700 "$push_repo"
# Snapshot local ignore data before PR code runs; never reopen clone config afterward.
if [ -e "$common/info/exclude" ] || [ -L "$common/info/exclude" ]; then
  if ! cat "$common/info/exclude" > "$push_repo/exclude" 2>/dev/null; then
    echo "Cannot snapshot repository exclusions; refusing to land" >&2
    exit 1
  fi
else
  : > "$push_repo/exclude"
fi
env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_GRAFT_FILE -u GIT_SHALLOW_FILE bun install --frozen-lockfile >/dev/null
log="${LAND_PR_LOG:-${TMPDIR:-/tmp}/land-pr-check.$$.log}"
if ! env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_GRAFT_FILE -u GIT_SHALLOW_FILE bun "$cli" gate-slot --name "land-pr #$pr" -- bun run check >"$log" 2>&1; then
  echo "bun run check failed; see $log" >&2
  exit 1
fi

for state in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
  if [ -e "$admin/$state" ] || [ -L "$admin/$state" ]; then
    echo "Merge, cherry-pick or revert in progress; refusing to land" >&2
    exit 1
  fi
done
clone="$GIT_WORK_TREE"
unset GIT_WORK_TREE GIT_CONFIG
export GIT_DIR="$push_repo" GIT_COMMON_DIR="$push_repo" GIT_INDEX_FILE="$push_repo/index"
if ! git -C "$push_repo" init --bare -q 2>/dev/null; then
  echo "Cannot initialize push repository; refusing to push" >&2
  exit 1
fi
export GIT_WORK_TREE="$clone"
printf '%s\n' "$common/objects" > "$push_repo/objects/info/alternates"
mv "$push_repo/exclude" "$push_repo/info/exclude"
# Local LFS payloads remain source data, not Git configuration.
ln -s "$common/lfs" "$push_repo/lfs"
# Keep global hasconfig:remote.*.url includes working without copying clone config.
if ! safe_git -C "$push_repo" config remote.origin.url "$url" 2>/dev/null ||
   ! safe_git -C "$push_repo" cat-file -e "$sha^{commit}" 2>/dev/null; then
  echo "Cannot prepare pinned commit in push repository; refusing to push" >&2
  exit 1
fi
# Status must compare the private index with the pinned commit, not an unborn HEAD.
printf '%s\n' "$sha" > "$push_repo/HEAD"
if ! safe_git --git-dir="$push_repo" --work-tree="$clone" read-tree "$sha" 2>/dev/null; then
  echo "Cannot inspect worktree; refusing to land" >&2
  exit 1
fi
# Running outside the clone prevents worktreeGit from restoring its recorded admin paths.
check_dir="$push_repo"
export LIMITLESS_LAND_SOURCE_DIR="$clone" LIMITLESS_LAND_SOURCE_COMMON_DIR="$common"
check_private "$pr" "$repo" "$subject"
head_ref="$(gh pr view "$pr" -R "$repo" --json headRefName --jq .headRefName)"
check_private "$pr" "$repo" "$subject" "$head_ref" "$sha"
if ! dirty="$(safe_git --git-dir="$push_repo" --work-tree="$clone" status --porcelain --untracked-files=normal --ignored=no 2>/dev/null)"; then
  echo "Cannot inspect worktree; refusing to land" >&2
  exit 1
fi
if [ -n "$dirty" ]; then
  echo "Worktree differs from landing commit; refusing to land" >&2
  exit 1
fi
# A PR process still running as the user can act as the user directly; this script
# cannot defend against it. The land queue runs checks confined instead.
safe_git -C "$push_repo" -c protocol.allow=never -c protocol.https.allow=always -c protocol.ssh.allow=always \
  push --no-verify -q --no-follow-tags "$url" "$sha:refs/heads/$head_ref"

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
