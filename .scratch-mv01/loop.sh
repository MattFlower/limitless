#!/bin/zsh
# 30 consecutive iterations: target file plus three other pipeline files under --parallel=4.
pass=0
for i in $(seq 1 30); do
  out=$(bun test --parallel=4 test/pipeline-verification.test.ts test/pipeline-holdout-lifecycle.test.ts test/pipeline-panel.test.ts test/pipeline-gates.test.ts 2>&1)
  if echo "$out" | grep -q "(fail)"; then echo "iter $i FAIL"; echo "$out" | grep -A20 "(fail)" | head -60; else pass=$((pass+1)); fi
  echo "$out" | grep -E "environment verification retry: passes" | head -1
  echo "$out" | grep -E "^ *[0-9]+ (pass|fail)$" | tr '\n' ' '; echo
done
echo "passed iterations: $pass/30"
