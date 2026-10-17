import pathlib, subprocess, json, re, sys, time
root=pathlib.Path.cwd(); out=root/'.measure-556'; base='ead8155c9880508b07669fba33a30b2eba4dd7b2'
files=['mcp-proxy','pipeline-baseline-cache','evals-runner','failure-injection','evals-http','evals-implement-runner','pipeline-delivery-restart','evals-reading-runner']
pairs=[files[i:i+2] for i in range(0,8,2)]
targets={
'mcp-proxy':['change pages expose 2-line PR prose but protect its holdout quotation in reports','change pages expose 3-line PR prose but protect its holdout quotation in reports','change pages reuse the catalogue and refresh diagnostics, holdouts and privacy inputs','change view preserves PR text and withholds private paths, patch lines, reports and errors on both backends'],
'pipeline-baseline-cache':re.findall(r'test\("([^"]+)"', (root/'test/pipeline-baseline-cache.test.ts').read_text()),
'evals-runner':['control and causal replay share candidates and a pinned verifier but grade and cache independently'],
'failure-injection':[f'factory merge survives interruption at {c} without losing parents or replaying completed work' for c in ['resolution-start','implementation-committed']]+['delivery with 3 PR-create 502s falls back as GitHub unavailable'],
'evals-http':['review and verify API reports preserve role grades and text/JSON metrics'],
'evals-implement-runner':['baseline gates are shared across repetitions and providers per case within each run'],
'pipeline-delivery-restart':['delivery checkpoint conflict-committed never publishes unchecked work'],
'evals-reading-runner':['review uses the pipeline prompt, recomputed audit, detached seeded HEAD and agent harness']}
(out/'targets.json').write_text(json.dumps(targets,indent=2))
def command(cmd, label):
    print('START',label,flush=True)
    started=time.monotonic()
    with (out/(label+'.log')).open('w') as log:
        p=subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT)
        try:
            # Admission to the factory slot is idle, not generated test load.
            while p.poll() is None and 'bun test v' not in (out/(label+'.log')).read_text():
                time.sleep(0.2)
            code=p.wait(timeout=590)
        except subprocess.TimeoutExpired:
            p.terminate(); code=p.wait(timeout=10)
    record={'label':label,'command':cmd,'exit':code,'seconds':round(time.monotonic()-started,3)}
    with (out/'runs.jsonl').open('a') as f: f.write(json.dumps(record)+'\n')
    print(json.dumps(record),flush=True)
    return code
mode=sys.argv[1]
if mode=='save':
    changed=subprocess.check_output(['git','diff','--name-only',base+'..HEAD'],text=True).splitlines()
    for name in changed:
        target=out/'saved'/name; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes((root/name).read_bytes())
    (out/'changed.json').write_text(json.dumps(changed))
elif mode in ['before','restore']:
    for name in json.loads((out/'changed.json').read_text()):
        if mode=='restore': (root/name).write_bytes((out/'saved'/name).read_bytes())
        else:
            result=subprocess.run(['git','show',base+':'+name],capture_output=True)
            if result.returncode==0: (root/name).write_bytes(result.stdout)
elif mode=='alone':
    stage=sys.argv[2]
    for file,names in targets.items():
        for i,name in enumerate(names):
            command(['bun','test',f'test/{file}.test.ts','-t',re.escape(name)], f'{stage}-alone-{file}-{i}')
elif mode=='loaded':
    stage=sys.argv[2]; iteration=sys.argv[3]
    indices=[int(x) for x in sys.argv[4:]] or range(4)
    for i in indices:
        command(['bun','test','--parallel=4',*[f'test/{file}.test.ts' for file in pairs[i]]],f'{stage}-loaded-{i}-{iteration}')
elif mode=='batch':
    from concurrent.futures import ThreadPoolExecutor
    stage=sys.argv[2]; first=int(sys.argv[3]); last=int(sys.argv[4])
    def pair(i):
        for iteration in range(first,last+1):
            code=command(['bun','test','--parallel=4',*[f'test/{file}.test.ts' for file in pairs[i]]],f'{stage}-loaded-{i}-{iteration}')
            if code: return False
        return True
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(pair, range(4)))
    if not all(results): sys.exit(1)
