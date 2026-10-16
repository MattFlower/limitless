import json,os,subprocess,sys
from pathlib import Path
Path('.measure-556/orchestrator.pid').write_text(str(os.getpid()))
steps=[
 ['python3','.measure-556/run.py','before-exact','alone','1','0'],
 ['python3','.measure-556/run.py','before-exact','load','1','3,4'],
 ['python3','.measure-556/run.py','after','alone','1'],
 ['bun','test','test/wait-support.test.ts'],
 ['python3','.measure-556/run.py','after-validation','load','10'],
]
for step in steps:
 print('START '+json.dumps(step),flush=True)
 result=subprocess.run(step)
 print('DONE '+json.dumps(dict(step=step,code=result.returncode)),flush=True)
 if result.returncode: sys.exit(result.returncode)
