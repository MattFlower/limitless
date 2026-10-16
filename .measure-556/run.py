import subprocess, json, sys, time
from pathlib import Path
cfg=json.loads(Path('.measure-556/config.json').read_text())
phase=sys.argv[1]
mode=sys.argv[2]
iterations=int(sys.argv[3]) if len(sys.argv)>3 else 1
jobs=([(name,["bun","test",f"test/{name}.test.ts","-t",selector]) for name,selectors in cfg["selectors"].items() for selector in selectors] if mode=="alone" else [("+".join(pair),["bun","test","--parallel=4",*[f"test/{name}.test.ts" for name in pair]]) for pair in cfg["pairs"]])
for iteration in range(iterations):
 for index,(name,cmd) in enumerate(jobs):
  if len(sys.argv)>4 and str(index) not in sys.argv[4].split(","): continue
  log=Path(f".measure-556/{phase}-{mode}-{iteration}-{index}.log")
  if phase=="before-exact":
   cmd=[arg.replace("test/", "test/measure-before-556-",1) if arg.startswith("test/") else arg for arg in cmd]
  start=time.monotonic()
  with log.open("w") as out:
   process=subprocess.Popen(cmd,stdout=out,stderr=subprocess.STDOUT)
   Path(str(log)+".pid").write_text(str(process.pid))
   active_started=None
   while True:
    try:
     code=process.wait(timeout=1)
     break
    except subprocess.TimeoutExpired:
     if active_started is None:
      with log.open(errors='replace') as current: header=current.read(4096)
      if 'bun test v' in header: active_started=time.monotonic()
     elif time.monotonic()-active_started>590:
      process.terminate()
      process.wait()
      code=124
      break
  record=dict(phase=phase,mode=mode,iteration=iteration,name=name,code=code,seconds=round(time.monotonic()-start,3),log=str(log))
  print(json.dumps(record),flush=True)
  with Path('.measure-556/results.jsonl').open('a') as records: records.write(json.dumps(record)+'\n')
  if phase.startswith('after') and code != 0: raise SystemExit(code)
