#!/usr/bin/env bash
set -eu
if [[ ${1:-} == --monitor ]]; then
  shift
  root=$1
  trap '
    trap "" TERM
    echo "CI check timed out: runner process tree (PID PPID COMMAND)"
    ps -ax -o pid,ppid,command | awk -v root="$root" '\''
      NR == 1 { print; next } { line[$1]=$0; children[$2]=children[$2] " " $1 }
      function tree(pid, indent, ids, n, i) {
        print indent line[pid]; n=split(children[pid], ids, " ")
        for (i=1; i<=n; i++) if (ids[i] != "") tree(ids[i], indent "  ")
      }
      END { tree(root, "") }'\''
    kill -TERM -- -"$PPID"
    while :; do sleep 1; done
  ' TERM
  shift
  "$@" & wait "$!"
  exit $?
fi
limit=$1; shift
# Job control gives timeout and the check their own group; TERM first reaches only the monitor.
set -m
timeout --foreground --signal=TERM --kill-after="${CI_CHECK_GRACE:-30s}" "$limit" bash "$0" --monitor "$PPID" "$@" &
check=$!
# --foreground kills only the monitor at the grace deadline; stop its remaining group here.
trap 'kill -KILL -- "-$check" 2>/dev/null || true' EXIT
wait "$check"
