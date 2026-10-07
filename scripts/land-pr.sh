#!/usr/bin/env bash
# Land a factory PR from a merge worktree: check, commit everything, push, wait for CI, squash-merge.
# Usage: scripts/land-pr.sh <pr-number> "<squash subject>" [worktree-dir]
# Every step checks its own exit status, including pipelines, so a failure always stops the merge.
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
trap '[ -z "$checker" ] || { kill -TERM "$checker" 2>/dev/null || :; wait "$checker" || :; }; exit 1' TERM INT
# The worktree's bunfig.toml (preload) and .env must not reach the checker.
check_private() { bun --config=/dev/null --no-env-file "$private_check" "$@" & checker=$!; wait "$checker"; checker=""; }
# Factory git after PR code has run: no hooks (files or config), filters, fsmonitor, forged commit-graph or bitmaps.
export LIMITLESS_GIT_EMPTY_HOOK=""
safe_git() {
  # Key names never contain newlines (git forbids them in subsections); no temp files, which confined runs can't create.
  local keys key flags=()
  keys="$(git config --name-only --get-regexp '^(hook|filter)\.')" || [ $? = 1 ] || return 1
  set -f
  local IFS=$'\n'
  for key in $keys; do flags+=("--config-env=$key=LIMITLESS_GIT_EMPTY_HOOK"); done
  set +f
  git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.commitGraph=false -c pack.useBitmaps=false \
    ${flags[@]+"${flags[@]}"} "$@"
}
repository_config() {
  local line
  safe_git config --list --show-scope --show-origin --includes 2>/dev/null | while IFS= read -r line; do
    case "$line" in
      local$'\t'*|worktree$'\t'*) printf '%s\n' "$line" ;;
    esac
  done || return 1
  # Preserve trailing newlines through command substitution without storing secrets on disk.
  printf '.'
}
validate_repository_config() {
  # Only clone/merge metadata may be present, even if PR code ran before this script.
  safe_git config -z --list --show-scope --name-only --includes 2>/dev/null | (
    bad=0
    while IFS= read -r -d '' scope && IFS= read -r -d '' key; do
      case "$scope" in local|worktree) ;; *) continue ;; esac
      key="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"
      case "$key" in
        core.repositoryformatversion|core.filemode|core.bare|core.logallrefupdates|core.ignorecase|core.precomposeunicode|core.symlinks|core.untrackedcache|extensions.worktreeconfig|extensions.objectformat|remote.origin.url|remote.origin.fetch) continue ;;
      esac
      [[ "$key" =~ ^branch\..+\.(remote|merge)$ ]] && continue
      printf 'Repository git config key %s is not allowed; refusing to land\n' "$key" >&2
      bad=1
    done
    exit "$bad"
  ) || { echo "Cannot validate repository git config; refusing to land" >&2; return 1; }
  safe_git config -z --get-all remote.origin.url 2>/dev/null | (
    bad=0
    while IFS= read -r -d '' url; do
      case "$url" in "https://github.com/$repo.git"|"git@github.com:$repo.git") ;; *) bad=1 ;; esac
    done
    exit "$bad"
  ) || { echo "Repository git config remote.origin.url is missing, invalid or unreadable; refusing to land" >&2; return 1; }
}

admin="$(cd "$(git rev-parse --absolute-git-dir)" && pwd -P)"
common="$(cd "$(git rev-parse --path-format=absolute --git-common-dir)" && pwd -P)"
paths="$(check_private --record)"
{ IFS= read -r GIT_WORK_TREE; IFS= read -r GIT_DIR; IFS= read -r GIT_COMMON_DIR; ! IFS= read -r extra; } <<< "$paths" || exit 1
[[ "$GIT_WORK_TREE" = "$(pwd -P)" && "$GIT_DIR" = "$admin" && "$GIT_COMMON_DIR" = "$common" ]] || exit 1
# A planted graft or shallow file could hide ancestry from the scan and still be pushed.
export GIT_GRAFT_FILE=/dev/null/none GIT_SHALLOW_FILE=""
export GIT_WORK_TREE GIT_DIR GIT_COMMON_DIR
# Snapshot and validate before any package lifecycle scripts or checks run.
if ! config_before="$(repository_config)"; then
  echo "Cannot read repository git config; refusing to land" >&2
  exit 1
fi
validate_repository_config || exit 1
env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_GRAFT_FILE -u GIT_SHALLOW_FILE bun install --frozen-lockfile >/dev/null
log="${LAND_PR_LOG:-${TMPDIR:-/tmp}/land-pr-check.$$.log}"
if ! env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_GRAFT_FILE -u GIT_SHALLOW_FILE bun "$cli" gate-slot --name "land-pr #$pr" -- bun run check >"$log" 2>&1; then
  echo "bun run check failed; see $log" >&2
  exit 1
fi

safe_git add -A
check_private "$pr" "$repo" "$subject"
if ! safe_git diff --cached --quiet || [ -f "$(safe_git rev-parse --git-path MERGE_HEAD)" ]; then
  safe_git commit --no-verify -q -m "Merge main into PR $pr

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
fi
if [ -n "$(safe_git status --porcelain)" ]; then
  echo "worktree still dirty after commit" >&2
  exit 1
fi

sha="$(safe_git rev-parse HEAD)"
head_ref="$(gh pr view "$pr" -R "$repo" --json headRefName --jq .headRefName)"
check_private "$pr" "$repo" "$subject" "$head_ref" "$sha"
validate_repository_config || exit 1
if ! config_after="$(repository_config)" || [ "$config_before" != "$config_after" ]; then
  echo "Repository git config changed during the checks or could not be read; refusing to push" >&2
  exit 1
fi
safe_git push --no-verify -q --no-follow-tags origin "$sha:refs/heads/$head_ref"

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
