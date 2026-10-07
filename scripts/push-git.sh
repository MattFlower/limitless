#!/usr/bin/env bash
# Run hardened push/lease lookup arguments ending in a trusted URL and one refspec/ref.
set -euo pipefail
destination="${@: -2:1}"
case "$destination" in /*|*:* ) ;; *) echo "push requires an explicit trusted destination" >&2; exit 1 ;; esac
admin="${GIT_DIR:-$(git rev-parse --absolute-git-dir)}"
common="${GIT_COMMON_DIR:-$(git rev-parse --path-format=absolute --git-common-dir)}"
format="$(git rev-parse --show-object-format)"
isolated="$(mktemp -d "${TMPDIR:-/tmp}/limitless-push.XXXXXX")"
trap 'rm -rf "$isolated"' EXIT
# Redirect only common administration: keep the original gitdir for trusted global includeIf
# conditions, and the original objects/refs for the exact SHA.
for name in objects refs packed-refs; do ln -s "$common/$name" "$isolated/$name"; done
git config --file "$isolated/config" core.repositoryformatversion 0
if [ "$format" = sha256 ]; then
  git config --file "$isolated/config" core.repositoryformatversion 1
  git config --file "$isolated/config" extensions.objectformat sha256
fi
export GIT_DIR="$admin" GIT_COMMON_DIR="$isolated"
# No checkout config or its includes is read, including config.worktree. Global/system config
# (and their includes) remains in place, so credential helpers and URL-scoped settings survive.
ssh_command=ssh
ssh_command="$(git -c extensions.worktreeConfig=false config --get core.sshCommand)" || {
  [ $? = 1 ] || { echo "cannot read trusted push configuration" >&2; exit 1; }
  ssh_command=ssh
}
git_command="$1"; shift
"$git_command" -c extensions.worktreeConfig=false -c protocol.ext.allow=never \
  -c "core.sshCommand=$ssh_command" "$@"
