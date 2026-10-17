import pathlib,json,re
out=pathlib.Path(__file__).parent
rows=[json.loads(line) for line in (out/'runs.jsonl').read_text().splitlines()]
print('Completed loaded runs:', ', '.join(f'pair {i}: '+str(sum(r['exit']==0 and r['label'].startswith(f'after-loaded-{i}-') for r in rows))+'/10' for i in range(4)))
logs=list(out.glob('after-loaded-*.log'))
print('Failure markers:',sum(p.read_text().count('(fail)') for p in logs),'timeout text:',sum(p.read_text().count('timed out') for p in logs),'closed database errors:',sum(p.read_text().count('Cannot use a closed database') for p in logs))
if logs:
 latest=max(logs,key=lambda p:p.stat().st_mtime)
 print('Latest:',latest.name)
 print('\n'.join(latest.read_text().splitlines()[-2:]))
