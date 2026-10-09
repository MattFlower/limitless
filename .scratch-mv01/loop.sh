#!/usr/bin/env bash
# Preserve complete output and require both a successful invocation and the target pass.
set -u
phase=${1:-validation}
iterations=${2:-30}
root=$(cd "$(dirname "$0")" && pwd)
logs="$root/$phase"
mkdir -p "$logs"
export PIPELINE_DIAGNOSTICS="$logs"
passed=0
for ((i=1; i<=iterations; i++)); do
  output="$logs/iteration-$i.log"
  bun test --parallel=4 test/pipeline-verification.test.ts test/pipeline-holdout-lifecycle.test.ts test/pipeline-panel.test.ts test/pipeline-gates.test.ts >"$output" 2>&1
  status=$?
  if ((status != 0)) || ! rg -q '^\(pass\) environment verification retry: passes \[' "$output"; then
    cat "$output"
    echo "iteration $i failed (exit $status); passed iterations: $passed/$iterations"
    exit 1
  fi
  passed=$((passed+1))
  echo "iteration $i passed"
done
echo "passed iterations: $passed/$iterations"
