import pathlib,json,re
out=pathlib.Path(__file__).parent
successful={json.loads(line)['label'] for line in (out/'runs.jsonl').read_text().splitlines() if json.loads(line)['exit']==0}
targets=json.loads((out/'targets.json').read_text())
rows=[]
for file,names in targets.items():
 for i,name in enumerate(names):
  timings=[]
  for stage,kind in [('before','alone'),('before','loaded'),('after','alone'),('after','loaded')]:
   values=[]
   for p in out.glob(f'{stage}-{kind}-*.log'):
    if p.stem not in successful: continue
    if kind=='alone' and p.name!=f'{stage}-alone-{file}-{i}.log': continue
    for status,test,ms in re.findall(r'\((pass|fail)\) (.*?) \[([\d.]+)ms\]',p.read_text()):
     if test==name or test.endswith(' > '+name):
      values.append(float(ms)/1000)
   timings.append(round(max(values),2) if values else None)
  rows.append({'file':file,'name':name,'before_alone':timings[0],'before_loaded':timings[1],'after_alone':timings[2],'after_loaded_max':timings[3]})
(out/'table.json').write_text(json.dumps(rows,indent=2))
for row in rows: print(row['file'],row['name'],row['before_alone'],row['before_loaded'],row['after_alone'],row['after_loaded_max'],sep=' | ')
