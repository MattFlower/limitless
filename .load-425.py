import subprocess, os, time, sys
files = ['test/pipeline-verification.test.ts', 'test/pipeline-audit.test.ts', 'test/pipeline-review.test.ts', 'test/pipeline-routing.test.ts']
start = time.monotonic()
end = start + 595
code = "import time; end=time.monotonic()+590\nwhile time.monotonic()<end:\n for i in range(10000): x=i*i"
loads = []
try:
    for _ in range(4):
        loads.append(subprocess.Popen([sys.executable, '-c', code]))
    print('owned load PIDs:', [p.pid for p in loads], flush=True)
    for i in range(1, 101):
        if time.monotonic() >= end: break
        iteration_start = time.monotonic()
        with open(f'repro-425-load-{i}.log', 'w') as out:
            result = subprocess.run(['bun', 'test', '--parallel=4', *files], stdout=out, stderr=subprocess.STDOUT, env={**os.environ, 'LIMITLESS_DIAGNOSTICS_425': '1'})
        print(f'load iteration {i}: exit={result.returncode} seconds={time.monotonic()-iteration_start:.1f} total={time.monotonic()-start:.1f}', flush=True)
        if '(fail) environment verification retry: passes [' in open(f'repro-425-load-{i}.log').read(): break
finally:
    for p in loads:
        if p.poll() is None: p.terminate()
    for p in loads: p.wait()
    print('all owned load processes stopped; wall seconds:', round(time.monotonic()-start, 1), flush=True)
