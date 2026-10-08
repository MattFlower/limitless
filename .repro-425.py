import subprocess, os, time
files = ['test/pipeline-verification.test.ts', 'test/pipeline-audit.test.ts', 'test/pipeline-review.test.ts', 'test/pipeline-routing.test.ts']
for i in range(4, 11):
    start = time.monotonic()
    with open(f'repro-425-before-{i}.log', 'w') as out:
        result = subprocess.run(['bun', 'test', '--parallel=4', *files], stdout=out, stderr=subprocess.STDOUT, env={**os.environ, 'LIMITLESS_DIAGNOSTICS_425': '1'})
    print(f'iteration {i}: exit={result.returncode} seconds={time.monotonic()-start:.1f}', flush=True)
    if '(fail) environment verification retry: passes [' in open(f'repro-425-before-{i}.log').read(): break
